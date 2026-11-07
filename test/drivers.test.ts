import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sql-js";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";

import { expoSqlite, expoSqliteAsync, SchemaChangesBlockedError, syncSchema, syncSchemaAsync } from "../src";
import { columns, objects, open, rows } from "./helpers";

const items = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false) }, (table) => [index("items_title").on(table.title)]);
const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title"), note: text("note") }, (table) => [index("items_title").on(table.title)]);

describe("a Drizzle database on sql.js", () => {
  it("is all it takes: the same deployment, through Drizzle's own calls", async () => {
    const SQL = await initSqlJs();
    const db = drizzle(new SQL.Database());

    expect(syncSchema(db, { items }).status).toBe("applied");
    db.insert(items).values({ id: "a", title: "First" }).run();

    const result = syncSchema(db, { items: next }, { allowDataLoss: true });

    expect(result.status).toBe("applied");
    expect(db.all(sql`SELECT id, title, note FROM items`)).toEqual([{ id: "a", title: "First", note: null }]);
    expect(syncSchema(db, { items: next }, { allowDataLoss: true }).skippedComparison).toBe(true);
  });

  it("waits for an asynchronous Drizzle database's thenables", async () => {
    const SQL = await initSqlJs();
    const db = drizzle(new SQL.Database());
    const thenable = { run: async (query: never) => db.run(query), all: async (query: never) => db.all(query) };

    expect((await syncSchemaAsync(thenable, { items })).status).toBe("applied");
    expect(db.all(sql`SELECT name FROM pragma_table_info('items')`)).toHaveLength(3);
  });
});

describe("the asynchronous call", () => {
  const connection = (database: ReturnType<typeof open>) => ({
    exec: async (statement: string) => database.exec(statement),
    all: async <T>(query: string) => database.all<T>(query),
  });

  it("does what the synchronous one does, statement for statement", async () => {
    const left = open();
    const right = open();
    for (const database of [left, right]) {
      syncSchema(database, { items });
      database.raw.exec(`INSERT INTO items (id, title) VALUES ('a', 'First')`);
      database.log.length = 0;
    }

    const asynchronous = await syncSchemaAsync(connection(left), { items: next }, { allowDataLoss: true });
    const synchronous = syncSchema(right, { items: next }, { allowDataLoss: true });

    expect(left.log).toEqual(right.log);
    expect(asynchronous).toEqual(synchronous);
    expect(rows(left, "SELECT id, title, note FROM items")).toEqual([{ id: "a", title: "First", note: null }]);
  });

  it("blocks and rolls back the same way", async () => {
    const database = open();
    syncSchema(database, { items });
    database.raw.exec(`INSERT INTO items (id, title) VALUES ('a', 'First')`);

    await expect(syncSchemaAsync(connection(database), { items: sqliteTable("items", { id: text("id").primaryKey(), owner: text("owner").notNull() }) })).rejects.toThrow(SchemaChangesBlockedError);

    await expect(syncSchemaAsync(connection(database), { items: next }, { allowDataLoss: true, afterDeploy: () => ["not sql"] })).rejects.toThrow();
    expect(columns(database, "items")).toEqual(["id", "title", "done"]);
    expect(objects(database, "index")).toEqual(["items_title"]);
  });
});

describe("expo-sqlite's connection", () => {
  it("goes through its synchronous calls", () => {
    const database = open();
    const execSync = vi.fn((source: string) => database.raw.exec(source));
    const getAllSync = vi.fn((source: string) => database.raw.prepare(source).all());
    const expo = { execSync, getAllSync: <T>(source: string) => getAllSync(source) as T[] };

    expect(syncSchema(expoSqlite(expo), { items }).status).toBe("applied");

    expect(execSync).toHaveBeenCalled();
    expect(getAllSync).toHaveBeenCalled();
  });

  it("goes through its asynchronous calls", async () => {
    const database = open();
    const execAsync = vi.fn(async (source: string) => void database.raw.exec(source));
    const getAllAsync = vi.fn(async (source: string) => database.raw.prepare(source).all());
    const expo = { execAsync, getAllAsync: async <T>(source: string) => (await getAllAsync(source)) as T[] };

    expect((await syncSchemaAsync(expoSqliteAsync(expo), { items })).status).toBe("applied");

    expect(execAsync).toHaveBeenCalled();
    expect(getAllAsync).toHaveBeenCalled();
  });
});
