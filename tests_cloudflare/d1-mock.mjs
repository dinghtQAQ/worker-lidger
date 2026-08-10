import { DatabaseSync } from "node:sqlite";

export class D1Mock {
  constructor(schema) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(schema);
    this.batchCalls = [];
    this.failBatchAt = null;
  }

  prepare(sql) {
    return new PreparedMock(this, sql);
  }

  async batch(statements) {
    this.batchCalls.push(statements.map((statement) => statement.sql));
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        if (this.failBatchAt === index + 1) {
          this.failBatchAt = null;
          throw new Error("injected D1 batch failure");
        }
        results.push(statement.runSync());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  all(sql, ...values) {
    return this.sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
  }

  get(sql, ...values) {
    const row = this.sqlite.prepare(sql).get(...values);
    return row === undefined ? undefined : { ...row };
  }

  close() {
    this.sqlite.close();
  }
}

class PreparedMock {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new PreparedMock(this.database, this.sql, values);
  }

  runSync() {
    return this.database.sqlite.prepare(this.sql).run(...this.values);
  }

  async run() {
    const result = this.runSync();
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  async all() {
    const rows = this.database.sqlite.prepare(this.sql).all(...this.values);
    return { success: true, results: rows.map((row) => ({ ...row })) };
  }

  async first(column) {
    const row = this.database.sqlite.prepare(this.sql).get(...this.values);
    if (row === undefined) {
      return null;
    }
    return column === undefined ? { ...row } : row[column] ?? null;
  }
}
