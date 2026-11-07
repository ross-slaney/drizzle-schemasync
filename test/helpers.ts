import { DatabaseSync } from "node:sqlite";

import type { Connection } from "../src";

/** A real SQLite, the build that ships with Node, and everything this library asks of one. */
export function open(...statements: string[]): Connection & { raw: DatabaseSync; log: string[] } {
  const raw = new DatabaseSync(":memory:");
  const log: string[] = [];
  for (const statement of statements) raw.exec(statement);
  return {
    raw,
    log,
    exec(statement) {
      log.push(statement);
      raw.exec(statement);
    },
    all<T>(query: string) {
      log.push(query);
      return raw.prepare(query).all() as T[];
    },
  };
}

export function rows(database: { raw: DatabaseSync }, query: string) {
  return database.raw.prepare(query).all().map((row) => ({ ...row }));
}

export function columns(database: { raw: DatabaseSync }, table: string) {
  return rows(database, `SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name as string);
}

export function objects(database: { raw: DatabaseSync }, type: "table" | "index" | "trigger" | "view") {
  return rows(database, `SELECT name FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((row) => row.name as string);
}
