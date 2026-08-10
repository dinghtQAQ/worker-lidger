#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BASE_URL_PLACEHOLDER = "https://YOUR-WORKER.example.com";
export const TOKEN_PLACEHOLDER = "PASTE_BEARER_TOKEN_HERE";
export const SKIP_CHILD_LABEL = "无细项";
export const AMOUNT_PATTERN = "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$";

const OBJECT_REPLACEMENT = "\uFFFC";

function createIdFactory() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
}

function namedVariable(name) {
  return { Type: "Variable", VariableName: name };
}

function currentDate() {
  return { Type: "CurrentDate" };
}

function attachment(reference) {
  return {
    Value: reference,
    WFSerializationType: "WFTextTokenAttachment",
  };
}

function utf16Length(value) {
  return [...value].reduce(
    (length, character) => length + (character.codePointAt(0) > 0xffff ? 2 : 1),
    0,
  );
}

function tokenString(...parts) {
  const attachmentsByRange = {};
  let offset = 0;
  let string = "";

  for (const part of parts) {
    if (typeof part === "string") {
      string += part;
      offset += utf16Length(part);
      continue;
    }
    attachmentsByRange[`{${offset}, 1}`] = part;
    string += OBJECT_REPLACEMENT;
    offset += 1;
  }

  return {
    Value: { string, attachmentsByRange },
    WFSerializationType: "WFTextTokenString",
  };
}

function dictionaryItem(key, value, itemType = 0) {
  return {
    WFKey: tokenString(key),
    WFItemType: itemType,
    WFValue: typeof value === "string" ? tokenString(value) : value,
  };
}

function dictionaryField(items) {
  return {
    Value: { WFDictionaryFieldValueItems: items },
    WFSerializationType: "WFDictionaryFieldValue",
  };
}

function textListItem(value) {
  return { WFItemType: 0, WFValue: tokenString(value) };
}

export function buildShortcut() {
  const nextId = createIdFactory();
  const actions = [];

  function addAction(identifier, parameters = {}) {
    actions.push({
      WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`,
      WFWorkflowActionParameters: parameters,
    });
    return actions.length - 1;
  }

  function addOutput(identifier, parameters, outputName) {
    const outputUUID = nextId();
    const index = addAction(identifier, {
      CustomOutputName: outputName,
      UUID: outputUUID,
      ...parameters,
    });
    return {
      index,
      reference: { Type: "ActionOutput", OutputName: outputName, OutputUUID: outputUUID },
    };
  }

  function addComment(text) {
    addAction("comment", { WFCommentActionText: text });
  }

  function addAlert(title, ...messageParts) {
    addAction("alert", {
      WFAlertActionCancelButtonShown: false,
      WFAlertActionMessage: tokenString(...messageParts),
      WFAlertActionTitle: title,
    });
  }

  function stop() {
    addAction("exit");
  }

  function setVariable(name, reference) {
    addAction("setvariable", {
      WFInput: attachment(reference),
      WFVariableName: name,
    });
  }

  function appendVariable(name, reference) {
    addAction("appendvariable", {
      WFInput: attachment(reference),
      WFVariableName: name,
    });
  }

  function getDictionaryValue(reference, key, outputName) {
    return addOutput(
      "getvalueforkey",
      {
        WFDictionaryKey: key,
        WFGetDictionaryValueType: "Value",
        WFInput: attachment(reference),
      },
      outputName,
    ).reference;
  }

  function conditional(reference, condition, comparison, body, otherwise) {
    const groupingIdentifier = nextId();
    const parameters = {
      GroupingIdentifier: groupingIdentifier,
      WFCondition: condition,
      WFControlFlowMode: 0,
      WFInput: { Type: "Variable", Variable: attachment(reference) },
    };
    if (comparison?.number !== undefined) {
      parameters.WFNumberValue = comparison.number;
    }
    if (comparison?.text !== undefined) {
      parameters.WFConditionalActionString =
        typeof comparison.text === "string"
          ? comparison.text
          : tokenString(comparison.text);
    }
    addAction("conditional", parameters);
    body();
    if (otherwise) {
      addAction("conditional", {
        GroupingIdentifier: groupingIdentifier,
        WFControlFlowMode: 1,
      });
      otherwise();
    }
    addAction("conditional", {
      GroupingIdentifier: groupingIdentifier,
      UUID: nextId(),
      WFControlFlowMode: 2,
    });
  }

  function repeatEach(reference, body) {
    const groupingIdentifier = nextId();
    addAction("repeat.each", {
      GroupingIdentifier: groupingIdentifier,
      WFControlFlowMode: 0,
      WFInput: attachment(reference),
    });
    body(namedVariable("Repeat Item"));
    addAction("repeat.each", {
      GroupingIdentifier: groupingIdentifier,
      UUID: nextId(),
      WFControlFlowMode: 2,
    });
  }

  function forActiveCategory(itemsReference, body) {
    repeatEach(itemsReference, (itemReference) => {
      const active = getDictionaryValue(itemReference, "active", "Category Active");
      conditional(active, 4, { number: 1 }, () => {
        const categoryKind = getDictionaryValue(itemReference, "kind", "Category Kind");
        conditional(categoryKind, 4, { text: namedVariable("Kind") }, () => {
          body(itemReference);
        });
      });
    });
  }

  addComment(
    "CONFIGURATION: import questions replace the next two Text actions. The URL must use HTTPS with no trailing slash. The token is only used in Authorization headers.",
  );
  const baseURL = addOutput(
    "gettext",
    { WFTextActionText: BASE_URL_PLACEHOLDER },
    "Configured Worker URL",
  );
  setVariable("BaseURL", baseURL.reference);
  const token = addOutput(
    "gettext",
    { WFTextActionText: TOKEN_PLACEHOLDER },
    "Configured Bearer Token",
  );
  setVariable("Token", token.reference);

  addComment("Validate configuration before making a network request.");
  const validBaseURL = addOutput(
    "text.match",
    {
      WFMatchTextCaseSensitive: true,
      WFMatchTextPattern: "^https://[^\\s/]+(?:/[^\\s/]+)*$",
      text: tokenString(namedVariable("BaseURL")),
    },
    "Valid HTTPS Base URL",
  ).reference;
  conditional(validBaseURL, 101, undefined, () => {
    addAlert("配置错误", "Worker URL 必须使用 HTTPS，且末尾不能有 /。");
    stop();
  });
  conditional(namedVariable("Token"), 4, { text: TOKEN_PLACEHOLDER }, () => {
    addAlert("配置错误", "请先配置 Worker API Token。");
    stop();
  });

  addComment("1. Choose transaction direction and map the localized label to the API kind.");
  const kindMenuGroup = nextId();
  addAction("choosefrommenu", {
    GroupingIdentifier: kindMenuGroup,
    WFControlFlowMode: 0,
    WFMenuItems: ["收入", "支出"],
    WFMenuPrompt: "选择出入帐",
  });
  addAction("choosefrommenu", {
    GroupingIdentifier: kindMenuGroup,
    WFControlFlowMode: 1,
    WFMenuItemTitle: "收入",
  });
  const income = addOutput("gettext", { WFTextActionText: "income" }, "Income Kind");
  setVariable("Kind", income.reference);
  addAction("choosefrommenu", {
    GroupingIdentifier: kindMenuGroup,
    WFControlFlowMode: 1,
    WFMenuItemTitle: "支出",
  });
  const expense = addOutput("gettext", { WFTextActionText: "expense" }, "Expense Kind");
  setVariable("Kind", expense.reference);
  addAction("choosefrommenu", {
    GroupingIdentifier: kindMenuGroup,
    UUID: nextId(),
    WFControlFlowMode: 2,
  });

  const authorizationHeader = dictionaryItem(
    "Authorization",
    tokenString("Bearer ", namedVariable("Token")),
  );
  const jsonHeaders = dictionaryField([
    authorizationHeader,
    dictionaryItem("Accept", "application/json"),
    dictionaryItem("Content-Type", "application/json"),
  ]);

  addComment("Load the live category tree from the authenticated Worker API.");
  const categoriesResponse = addOutput(
    "downloadurl",
    {
      ShowHeaders: true,
      WFHTTPHeaders: jsonHeaders,
      WFHTTPMethod: "GET",
      WFURL: tokenString(namedVariable("BaseURL"), "/v1/categories"),
    },
    "Categories Response",
  ).reference;
  const categoriesError = getDictionaryValue(
    categoriesResponse,
    "error",
    "Categories API Error",
  );
  conditional(categoriesError, 100, undefined, () => {
    addAlert("获取分类失败", "API 错误：", categoriesError);
    stop();
  });
  const categoryItems = getDictionaryValue(categoriesResponse, "items", "Category Items");
  setVariable("CategoryItems", categoryItems);
  conditional(namedVariable("CategoryItems"), 101, undefined, () => {
    addAlert("获取分类失败", "没有可用的分类。");
    stop();
  });

  addComment("2. Build and choose active top-level categories for the selected kind.");
  const emptyRoots = addOutput("list", { WFItems: [] }, "Empty Root Names");
  setVariable("RootNames", emptyRoots.reference);
  forActiveCategory(namedVariable("CategoryItems"), (itemReference) => {
    const parentID = getDictionaryValue(itemReference, "parent_id", "Root Parent ID");
    conditional(parentID, 101, undefined, () => {
      const rootName = getDictionaryValue(itemReference, "name", "Root Category Name");
      appendVariable("RootNames", rootName);
    });
  });
  conditional(namedVariable("RootNames"), 101, undefined, () => {
    addAlert("无法记账", "所选出入帐类型没有可用粗项。");
    stop();
  });
  const chosenRoot = addOutput(
    "choosefromlist",
    {
      WFChooseFromListActionPrompt: "选择粗项",
      WFChooseFromListActionSelectMultiple: false,
      WFInput: attachment(namedVariable("RootNames")),
    },
    "Chosen Root Name",
  );
  setVariable("RootName", chosenRoot.reference);

  addComment("Resolve the chosen root name back to its category ID.");
  forActiveCategory(namedVariable("CategoryItems"), (itemReference) => {
    const parentID = getDictionaryValue(itemReference, "parent_id", "Resolved Root Parent ID");
    conditional(parentID, 101, undefined, () => {
      const rootName = getDictionaryValue(itemReference, "name", "Resolved Root Name");
      conditional(rootName, 4, { text: namedVariable("RootName") }, () => {
        const rootID = getDictionaryValue(itemReference, "id", "Resolved Root ID");
        setVariable("RootID", rootID);
      });
    });
  });
  conditional(namedVariable("RootID"), 101, undefined, () => {
    addAlert("分类错误", "无法解析所选粗项，请重试。");
    stop();
  });

  addComment("3. Build matching active children and include an explicit no-detail option.");
  const childNames = addOutput(
    "list",
    { WFItems: [textListItem(SKIP_CHILD_LABEL)] },
    "Child Names with Skip",
  );
  setVariable("ChildNames", childNames.reference);
  forActiveCategory(namedVariable("CategoryItems"), (itemReference) => {
    const parentID = getDictionaryValue(itemReference, "parent_id", "Child Parent ID");
    conditional(parentID, 4, { text: namedVariable("RootID") }, () => {
      const childName = getDictionaryValue(itemReference, "name", "Child Category Name");
      appendVariable("ChildNames", childName);
    });
  });
  const chosenChild = addOutput(
    "choosefromlist",
    {
      WFChooseFromListActionPrompt: "选择细项（可跳过）",
      WFChooseFromListActionSelectMultiple: false,
      WFInput: attachment(namedVariable("ChildNames")),
    },
    "Chosen Child Name",
  );
  setVariable("ChildName", chosenChild.reference);
  setVariable("SelectedCategoryID", namedVariable("RootID"));

  conditional(namedVariable("ChildName"), 5, { text: SKIP_CHILD_LABEL }, () => {
    forActiveCategory(namedVariable("CategoryItems"), (itemReference) => {
      const parentID = getDictionaryValue(itemReference, "parent_id", "Selected Child Parent ID");
      conditional(parentID, 4, { text: namedVariable("RootID") }, () => {
        const childName = getDictionaryValue(itemReference, "name", "Selected Child Name");
        conditional(childName, 4, { text: namedVariable("ChildName") }, () => {
          const childID = getDictionaryValue(itemReference, "id", "Resolved Child ID");
          setVariable("ChildID", childID);
        });
      });
    });
    conditional(namedVariable("ChildID"), 101, undefined, () => {
      addAlert("分类错误", "无法解析所选细项，请重试。");
      stop();
    });
    setVariable("SelectedCategoryID", namedVariable("ChildID"));
  });

  addComment("4. Validate a positive CNY amount with at most two decimal places, then convert yuan to integer fen.");
  const amountInput = addOutput(
    "ask",
    {
      WFAllowsMultilineText: false,
      WFAskActionPrompt: "输入金额（人民币元，最多两位小数）",
      WFInputType: "Text",
    },
    "Amount Input",
  );
  setVariable("AmountInput", amountInput.reference);
  const amountMatch = addOutput(
    "text.match",
    {
      WFMatchTextCaseSensitive: true,
      WFMatchTextPattern: AMOUNT_PATTERN,
      text: tokenString(namedVariable("AmountInput")),
    },
    "Valid Amount Match",
  );
  conditional(amountMatch.reference, 101, undefined, () => {
    addAlert("金额无效", "请输入正数，且最多保留两位小数。");
    stop();
  });
  const amountNumber = addOutput(
    "number",
    { WFNumberActionNumber: tokenString(namedVariable("AmountInput")) },
    "Amount Yuan",
  );
  conditional(amountNumber.reference, 1, { number: 0 }, () => {
    addAlert("金额无效", "金额必须大于 0。");
    stop();
  });
  const amountTimes100 = addOutput(
    "math",
    {
      WFInput: attachment(amountNumber.reference),
      WFMathOperand: 100,
      WFMathOperation: "×",
    },
    "Amount in Fen Before Rounding",
  );
  const amountMinor = addOutput(
    "round",
    {
      WFInput: attachment(amountTimes100.reference),
      WFRoundMode: "Normal",
      WFRoundTo: "Ones Place",
    },
    "Integer Amount Minor",
  );
  setVariable("AmountMinor", amountMinor.reference);

  const occurredOn = addOutput(
    "format.date",
    {
      WFDate: tokenString(currentDate()),
      WFDateFormat: "yyyy-MM-dd",
      WFDateFormatStyle: "Custom",
      WFTimeFormatStyle: "None",
    },
    "Occurred On",
  );
  setVariable("OccurredOn", occurredOn.reference);

  const entryBody = dictionaryField([
    dictionaryItem("kind", tokenString(namedVariable("Kind"))),
    dictionaryItem(
      "category_id",
      tokenString(namedVariable("SelectedCategoryID")),
      3,
    ),
    dictionaryItem("amount_minor", tokenString(namedVariable("AmountMinor")), 3),
    dictionaryItem("currency", "CNY"),
    dictionaryItem("occurred_on", tokenString(namedVariable("OccurredOn"))),
  ]);

  addComment("Create the entry with the same bearer token; the token is never displayed or returned.");
  const entryResponse = addOutput(
    "downloadurl",
    {
      ShowHeaders: true,
      WFHTTPBodyType: "JSON",
      WFHTTPHeaders: jsonHeaders,
      WFHTTPMethod: "POST",
      WFJSONValues: entryBody,
      WFURL: tokenString(namedVariable("BaseURL"), "/v1/entries"),
    },
    "Entry Response",
  ).reference;
  const entryError = getDictionaryValue(entryResponse, "error", "Entry API Error");
  conditional(entryError, 100, undefined, () => {
    addAlert("记账失败", "API 错误：", entryError);
    stop();
  });
  const entryID = getDictionaryValue(entryResponse, "id", "Created Entry ID");
  conditional(entryID, 101, undefined, () => {
    addAlert("记账失败", "服务器响应中没有流水 ID。");
    stop();
  });
  addAction("showresult", {
    Text: tokenString("记账成功（流水 ID：", entryID, "）"),
  });

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: "4033.0.4.3",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowIcon: {
      WFWorkflowIconGlyphNumber: 59722,
      WFWorkflowIconStartColor: 4292093695,
    },
    WFWorkflowImportQuestions: [
      {
        ActionIndex: baseURL.index,
        Category: "Parameter",
        DefaultValue: BASE_URL_PLACEHOLDER,
        ParameterKey: "WFTextActionText",
        Question: "请输入 Worker HTTPS URL（末尾不要加 /）",
      },
      {
        ActionIndex: token.index,
        Category: "Parameter",
        DefaultValue: TOKEN_PLACEHOLDER,
        ParameterKey: "WFTextActionText",
        Question: "请输入 Worker API Token（仅用于 Authorization 请求头）",
      },
    ],
    WFWorkflowInputContentItemClasses: ["WFStringContentItem"],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowName: "Worker Lidger 记账",
    WFWorkflowNoInputBehavior: {},
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: [],
  };
}

function escapeXML(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plistValue(value, indentation = "") {
  const childIndentation = `${indentation}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indentation}<array/>`;
    return [
      `${indentation}<array>`,
      ...value.map((item) => plistValue(item, childIndentation)),
      `${indentation}</array>`,
    ].join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indentation}<dict/>`;
    const body = [];
    for (const [key, item] of entries) {
      body.push(`${childIndentation}<key>${escapeXML(key)}</key>`);
      body.push(plistValue(item, childIndentation));
    }
    return [`${indentation}<dict>`, ...body, `${indentation}</dict>`].join("\n");
  }
  if (typeof value === "string") {
    return `${indentation}<string>${escapeXML(value)}</string>`;
  }
  if (typeof value === "boolean") {
    return `${indentation}<${value ? "true" : "false"}/>`;
  }
  if (Number.isInteger(value)) {
    return `${indentation}<integer>${value}</integer>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${indentation}<real>${value}</real>`;
  }
  throw new TypeError(`Unsupported plist value: ${String(value)}`);
}

export function serializePlist(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value),
    "</plist>",
    "",
  ].join("\n");
}

async function main() {
  const outputArgument = process.argv.indexOf("--output");
  if (outputArgument === -1 || outputArgument === process.argv.length - 1) {
    throw new Error("Usage: node scripts/generate-shortcut.mjs --output <source.plist>");
  }
  const outputPath = resolve(process.argv[outputArgument + 1]);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializePlist(buildShortcut()), "utf8");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
