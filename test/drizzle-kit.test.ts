import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { customType, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { syncSchema } from "../src";
import { open, rows } from "./helpers";

const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "blob" });

const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  admin: integer("admin", { mode: "boolean" }).notNull().default(false),
  plan: text("plan", { enum: ["free", "pro"] }).notNull().default("free"),
  seats: integer("seats").notNull().default(3),
  score: real("score"),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  settings: text("settings", { mode: "json" }).notNull().default({}),
  quoted: text("quoted").notNull().default("it's"),
  empty: text("empty").notNull().default(""),
  avatar: bytes("avatar"),
  created: integer("created").notNull().default(sql`(unixepoch())`),
});

const queue = sqliteTable(
  "queue",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    entity: text("entity").notNull(),
    rowId: text("row_id").notNull(),
    token: text("token").unique(),
  },
  (table) => [uniqueIndex("queue_entity_row").on(table.entity, table.rowId), index("queue_token").on(table.token)],
);

const pairs = sqliteTable(
  "pairs",
  {
    left: text("left_id").notNull(),
    right: text("right_id").notNull(),
    owner: text("owner_id").references(() => people.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.left, table.right] })],
);

const schema = { people, queue, pairs };

describe("a database drizzle-kit's migrations built", () => {
  it("already matches the schema, so moving to this library changes nothing", async () => {
    const empty = await generateSQLiteDrizzleJson({});
    const full = await generateSQLiteDrizzleJson(schema);
    const statements = await generateSQLiteMigration(empty, full);
    const database = open(...statements);
    database.raw.exec(`INSERT INTO queue (entity, row_id) VALUES ('a', 'b')`);

    const result = syncSchema(database, schema, { allowObjectRemoval: true, skipComparisonWhenUnchanged: false });

    expect(result.plan.changes).toEqual([]);
    expect(result.plan.statements).toEqual([]);
    expect(result.status).toBe("unchanged");
    expect(rows(database, "SELECT entity FROM queue")).toEqual([{ entity: "a" }]);
  });
});

describe("the database this library builds", () => {
  it("is one drizzle-kit would call the same", async () => {
    const database = open();
    syncSchema(database, schema);

    const kit = open(...(await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))));

    const shape = (target: typeof database) =>
      rows(target, `SELECT m.name AS tableName, c.name, lower(c.type) AS type, c."notnull" AS required, c.pk FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY 1, 2`);
    expect(shape(database)).toEqual(shape(kit));
  });
});
