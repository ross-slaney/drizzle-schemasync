import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { syncSchema, type SchemaSource } from "../src";
import { open, rows } from "./helpers";

/*
 * The property the whole library promises: from any database, one run reaches a
 * state where a second run, comparing for real, has nothing to do.
 */
const parent = sqliteTable("t", { id: text("id").primaryKey(), a: text("a") });

const shapes: Record<string, SchemaSource> = {
  nothing: {},
  small: { t: sqliteTable("t", { id: text("id").primaryKey() }) },
  columns: { t: sqliteTable("t", { id: text("id").primaryKey(), a: text("a"), b: integer("b").notNull().default(0) }) },
  retyped: { t: sqliteTable("t", { id: text("id").primaryKey(), a: integer("a"), b: text("b").notNull().default("x") }) },
  indexed: { t: sqliteTable("t", { id: text("id").primaryKey(), a: text("a"), b: integer("b").notNull().default(0) }, (table) => [index("t_a").on(table.a), uniqueIndex("t_b").on(table.b)]) },
  partial: { t: sqliteTable("t", { id: text("id").primaryKey(), a: text("a"), b: integer("b").notNull().default(0) }, (table) => [index("t_a").on(table.a).where(sql`${table.b} > 0`)]) },
  keyed: { t: sqliteTable("t", { a: text("a").notNull(), b: integer("b").notNull() }, (table) => [primaryKey({ columns: [table.a, table.b] })]) },
  counted: { t: sqliteTable("t", { id: integer("id").primaryKey({ autoIncrement: true }), a: text("a") }) },
  related: {
    t: parent,
    u: sqliteTable("u", { id: text("id").primaryKey(), tId: text("t_id").references(() => parent.id) }),
  },
  moved: { u: sqliteTable("u", { id: text("id").primaryKey(), a: text("a") }) },
};

describe("from any shape to any other", () => {
  for (const [fromName, from] of Object.entries(shapes)) {
    for (const [toName, to] of Object.entries(shapes)) {
      if (fromName === toName) continue;
      it(`${fromName} to ${toName}`, () => {
        const database = open();
        syncSchema(database, from);
        const hasT = rows(database, `SELECT 1 FROM sqlite_master WHERE name = 't'`).length > 0;
        if (hasT) {
          const id = rows(database, `SELECT lower(type) AS type FROM pragma_table_info('t') WHERE pk = 1`)[0]?.type;
          database.raw.exec(id === "integer" ? `INSERT INTO t DEFAULT VALUES` : fromName === "keyed" ? `INSERT INTO t VALUES ('k', 1)` : `INSERT INTO t (id) VALUES ('r')`);
        }

        syncSchema(database, to, { allowDataLoss: true, allowObjectRemoval: true });

        expect(syncSchema(database, to, { allowObjectRemoval: true, skipComparisonWhenUnchanged: false })).toMatchObject({ status: "unchanged", plan: { statements: [] } });
      });
    }
  }
});
