import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AMOUNT_PATTERN,
  BASE_URL_PLACEHOLDER,
  SKIP_CHILD_LABEL,
  TOKEN_PLACEHOLDER,
  buildShortcut,
  serializePlist,
} from "../scripts/generate-shortcut.mjs";

const SOURCE_PATH = new URL("../shortcuts/worker-lidger.shortcut.plist", import.meta.url);
const ARTIFACT_PATH = new URL("../shortcuts/worker-lidger.shortcut", import.meta.url);

function actions(workflow = buildShortcut()) {
  return workflow.WFWorkflowActions;
}

function findActions(identifier, workflow = buildShortcut()) {
  return actions(workflow).filter(
    (action) => action.WFWorkflowActionIdentifier === `is.workflow.actions.${identifier}`,
  );
}

function referencesVariable(value, variableName) {
  if (Array.isArray(value)) return value.some((item) => referencesVariable(item, variableName));
  if (value === null || typeof value !== "object") return false;
  if (value.Type === "Variable" && value.VariableName === variableName) return true;
  return Object.values(value).some((item) => referencesVariable(item, variableName));
}

function dictionaryItems(field) {
  return field.Value.WFDictionaryFieldValueItems;
}

function dictionaryKey(item) {
  return item.WFKey.Value.string;
}

function tokenText(value) {
  return value?.Value?.string ?? value;
}

test("committed shortcut source is deterministic and plist-valid", () => {
  const generated = serializePlist(buildShortcut());
  assert.equal(readFileSync(SOURCE_PATH, "utf8"), generated);
  const output = execFileSync("plutil", ["-lint", fileURLToPath(SOURCE_PATH)], {
    encoding: "utf8",
  });
  assert.match(output, /OK/);
});

test("import questions configure placeholders without embedding a deployment", () => {
  const workflow = buildShortcut();
  assert.equal(workflow.WFWorkflowImportQuestions.length, 2);
  const [urlQuestion, tokenQuestion] = workflow.WFWorkflowImportQuestions;
  assert.equal(urlQuestion.DefaultValue, BASE_URL_PLACEHOLDER);
  assert.equal(tokenQuestion.DefaultValue, TOKEN_PLACEHOLDER);
  for (const question of workflow.WFWorkflowImportQuestions) {
    assert.equal(question.Category, "Parameter");
    assert.equal(question.ParameterKey, "WFTextActionText");
    const action = workflow.WFWorkflowActions[question.ActionIndex];
    assert.equal(action.WFWorkflowActionIdentifier, "is.workflow.actions.gettext");
    assert.equal(action.WFWorkflowActionParameters.WFTextActionText, question.DefaultValue);
  }
  assert.match(BASE_URL_PLACEHOLDER, /^https:\/\//);
  assert.doesNotMatch(BASE_URL_PLACEHOLDER, /\/$/);
  assert.doesNotMatch(JSON.stringify(workflow), /\.workers\.dev|pages\.dev|Bearer [A-Za-z0-9_-]{20,}/);
});

test("GET and POST use bearer authentication only in headers", () => {
  const requests = findActions("downloadurl");
  assert.equal(requests.length, 2);
  const getRequest = requests.find(
    (request) => request.WFWorkflowActionParameters.WFHTTPMethod === "GET",
  );
  const postRequest = requests.find(
    (request) => request.WFWorkflowActionParameters.WFHTTPMethod === "POST",
  );
  assert.equal(tokenText(getRequest.WFWorkflowActionParameters.WFURL), "￼/v1/categories");
  assert.equal(tokenText(postRequest.WFWorkflowActionParameters.WFURL), "￼/v1/entries");
  assert.equal(postRequest.WFWorkflowActionParameters.WFHTTPBodyType, "JSON");

  for (const request of requests) {
    assert.equal(referencesVariable(request.WFWorkflowActionParameters.WFURL, "Token"), false);
    const headers = dictionaryItems(request.WFWorkflowActionParameters.WFHTTPHeaders);
    const authorization = headers.find((item) => dictionaryKey(item) === "Authorization");
    assert.equal(tokenText(authorization.WFValue), "Bearer ￼");
    assert.equal(referencesVariable(authorization.WFValue, "Token"), true);
  }

  const tokenDisplays = findActions("showresult").filter((action) =>
    referencesVariable(action, "Token"),
  );
  assert.equal(tokenDisplays.length, 0);
});

test("category graph filters active roots and matching optional children", () => {
  const workflow = buildShortcut();
  const serialized = JSON.stringify(workflow);
  const kindMenu = findActions("choosefrommenu", workflow).find(
    (action) => action.WFWorkflowActionParameters.WFControlFlowMode === 0,
  );
  assert.deepEqual(kindMenu.WFWorkflowActionParameters.WFMenuItems, ["收入", "支出"]);
  const kindValues = findActions("gettext", workflow)
    .map((action) => action.WFWorkflowActionParameters.WFTextActionText)
    .filter((value) => value === "income" || value === "expense");
  assert.deepEqual(kindValues, ["income", "expense"]);
  assert.equal(
    findActions("setvariable", workflow).filter(
      (action) => action.WFWorkflowActionParameters.WFVariableName === "Kind",
    ).length,
    2,
  );
  assert.match(serialized, /Category Active/);
  assert.match(serialized, /parent_id/);
  assert.match(serialized, /RootNames/);
  assert.match(serialized, /ChildNames/);
  assert.match(serialized, /RootID/);
  assert.match(serialized, /ChildID/);
  assert.match(serialized, /SelectedCategoryID/);
  assert.match(serialized, new RegExp(SKIP_CHILD_LABEL));
  assert.ok(findActions("repeat.each", workflow).length >= 8);
  const dictionaryKeys = findActions("getvalueforkey", workflow).map(
    (action) => action.WFWorkflowActionParameters.WFDictionaryKey,
  );
  assert.equal(dictionaryKeys.filter((key) => key === "active").length, 4);
  assert.equal(dictionaryKeys.filter((key) => key === "kind").length, 4);
  assert.equal(dictionaryKeys.filter((key) => key === "parent_id").length, 4);
  assert.equal(
    findActions("appendvariable", workflow).some(
      (action) => action.WFWorkflowActionParameters.WFVariableName === "RootNames",
    ),
    true,
  );
  assert.equal(
    findActions("appendvariable", workflow).some(
      (action) => action.WFWorkflowActionParameters.WFVariableName === "ChildNames",
    ),
    true,
  );
  const selectedCategoryAssignments = findActions("setvariable", workflow).filter(
    (action) => action.WFWorkflowActionParameters.WFVariableName === "SelectedCategoryID",
  );
  assert.equal(selectedCategoryAssignments.length, 2);
  assert.equal(referencesVariable(selectedCategoryAssignments[0], "RootID"), true);
  assert.equal(referencesVariable(selectedCategoryAssignments[1], "ChildID"), true);
});

test("amount conversion rejects invalid precision and creates integer fen", () => {
  const workflow = buildShortcut();
  const match = findActions("text.match", workflow).find(
    (action) => action.WFWorkflowActionParameters.WFMatchTextPattern === AMOUNT_PATTERN,
  );
  assert.ok(match);
  const amountCases = new Map([
    ["12", true],
    ["12.3", true],
    ["12.34", true],
    ["0.01", true],
    ["0", true],
    ["-1", false],
    ["1.234", false],
    ["01.20", false],
    ["1e2", false],
  ]);
  const regex = new RegExp(AMOUNT_PATTERN);
  for (const [input, accepted] of amountCases) assert.equal(regex.test(input), accepted, input);

  assert.equal(
    findActions("conditional", workflow).some(
      (action) =>
        action.WFWorkflowActionParameters.WFCondition === 1 &&
        action.WFWorkflowActionParameters.WFNumberValue === 0,
    ),
    true,
  );
  const multiply = findActions("math", workflow).find(
    (action) => action.WFWorkflowActionParameters.WFMathOperation === "×",
  );
  assert.equal(multiply.WFWorkflowActionParameters.WFMathOperand, 100);
  const round = findActions("round", workflow)[0];
  assert.equal(round.WFWorkflowActionParameters.WFRoundTo, "Ones Place");
  assert.equal(round.WFWorkflowActionParameters.WFRoundMode, "Normal");
});

test("POST body uses selected category, CNY, local date, and numeric minor units", () => {
  const workflow = buildShortcut();
  const post = findActions("downloadurl", workflow).find(
    (action) => action.WFWorkflowActionParameters.WFHTTPMethod === "POST",
  );
  const items = dictionaryItems(post.WFWorkflowActionParameters.WFJSONValues);
  const byKey = Object.fromEntries(items.map((item) => [dictionaryKey(item), item]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    "amount_minor",
    "category_id",
    "currency",
    "kind",
    "occurred_on",
  ]);
  assert.equal(referencesVariable(byKey.kind.WFValue, "Kind"), true);
  assert.equal(referencesVariable(byKey.category_id.WFValue, "SelectedCategoryID"), true);
  assert.equal(referencesVariable(byKey.amount_minor.WFValue, "AmountMinor"), true);
  assert.equal(byKey.category_id.WFItemType, 3);
  assert.equal(byKey.amount_minor.WFItemType, 3);
  assert.equal(tokenText(byKey.currency.WFValue), "CNY");
  assert.equal(referencesVariable(byKey.occurred_on.WFValue, "OccurredOn"), true);

  const date = findActions("format.date", workflow)[0].WFWorkflowActionParameters;
  assert.equal(date.WFDateFormatStyle, "Custom");
  assert.equal(date.WFDateFormat, "yyyy-MM-dd");
  assert.equal(date.WFTimeFormatStyle, "None");
  assert.equal(date.WFDate.Value.attachmentsByRange["{0, 1}"].Type, "CurrentDate");
});

test("errors stop safely and success is concise", () => {
  const workflow = buildShortcut();
  assert.ok(findActions("alert", workflow).length >= 8);
  assert.ok(findActions("exit", workflow).length >= 8);
  const result = findActions("showresult", workflow);
  assert.equal(result.length, 1);
  assert.equal(tokenText(result[0].WFWorkflowActionParameters.Text), "记账成功（流水 ID：￼）");
  assert.equal(referencesVariable(result[0], "Token"), false);
});

test("committed artifact is signed and contains no obvious deployment secret", () => {
  const artifact = readFileSync(ARTIFACT_PATH);
  assert.ok(statSync(ARTIFACT_PATH).size > 1_000);
  assert.equal(artifact.subarray(0, 4).toString("ascii"), "AEA1");
  const printable = artifact.toString("latin1");
  assert.doesNotMatch(printable, /\.workers\.dev|pages\.dev|Bearer [A-Za-z0-9_-]{20,}/);
});
