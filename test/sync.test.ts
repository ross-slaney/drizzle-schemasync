import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, sqliteView, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { createStatements, describeResult, describeSchema, diffSchemas, SchemaChangesBlockedError, syncSchema, UnsupportedSchemaError } from "../src";
import { columns, objects, open, rows } from "./helpers";

const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  },
  (table) => [index("items_title").on(table.title)],
);

const seeded = (statement = `INSERT INTO items (id, title) VALUES ('a', 'First')`) => {
  const database = open();
  syncSchema(database, { items });
  database.raw.exec(statement);
  database.log.length = 0;
  return database;
};

describe("a fresh database", () => {
  it("gets every table and index the schema asks for", () => {
    const database = open();

    const result = syncSchema(database, { items });

    expect(result.status).toBe("applied");
    expect(objects(database, "table")).toEqual(["items"]);
    expect(objects(database, "index")).toEqual(["items_title"]);
    expect(columns(database, "items")).toEqual(["id", "title", "done", "tags"]);
    database.raw.exec(`INSERT INTO items (id, title) VALUES ('a', 'First')`);
    expect(rows(database, "SELECT done, tags FROM items")).toEqual([{ done: 0, tags: "[]" }]);
  });

  it("builds composite keys, foreign keys, checks, unique columns and constraints, partial and expression indexes, every type of default", () => {
    const owners = sqliteTable("owners", { id: integer("id").primaryKey({ autoIncrement: true }) });
    const edges = sqliteTable(
      "edges",
      {
        from: integer("from_id").notNull(),
        to: integer("to_id").notNull(),
        slug: text("slug").notNull().unique(),
        code: text("code").notNull(),
        weight: real("weight").notNull().default(1.5),
        at: text("at").notNull().default(sql`CURRENT_TIMESTAMP`),
        made: integer("made").notNull().default(sql`(unixepoch())`),
        quoted: text("quoted").notNull().default("it's"),
        nothing: text("nothing").default(sql`NULL`),
      },
      (table) => [
        primaryKey({ columns: [table.from, table.to] }),
        foreignKey({ columns: [table.from], foreignColumns: [owners.id] }).onDelete("cascade"),
        check("weight_positive", sql`${table.weight} > 0`),
        unique("edges_code_unique_pair").on(table.code, table.slug),
        uniqueIndex("edges_slug_live").on(table.slug).where(sql`${table.weight} > 2`),
        index("edges_lower_code").on(sql`lower(${table.code})`),
      ],
    );
    const database = open();

    syncSchema(database, { owners, edges });

    expect(objects(database, "index")).toEqual(["edges_code_unique_pair", "edges_lower_code", "edges_slug_live", "edges_slug_unique"]);
    expect(syncSchema(open(), { owners, edges }, { skipComparisonWhenUnchanged: false }).status).toBe("applied");
    // A second run compares for real and finds nothing, whatever SQLite did to the text of each definition.
    expect(syncSchema(database, { owners, edges }, { skipComparisonWhenUnchanged: false })).toMatchObject({ status: "unchanged", plan: { statements: [] } });
    database.raw.exec(`INSERT INTO owners DEFAULT VALUES`);
    database.raw.exec(`INSERT INTO edges (from_id, to_id, slug, code) VALUES (1, 2, 'a', 'b')`);
    const [row] = rows(database, "SELECT weight, quoted FROM edges");
    expect(row).toEqual({ weight: 1.5, quoted: "it's" });
    expect(() => database.raw.exec(`INSERT INTO edges (from_id, to_id, slug, code, weight) VALUES (1, 3, 'c', 'd', -1)`)).toThrow(/CHECK/);
  });

  it("writes byte defaults and refuses a default it cannot write", () => {
    const blobby = sqliteTable("blobby", { id: text("id").primaryKey(), raw: text("raw").default(new Uint8Array([1, 255]) as never) });
    expect(createStatements({ blobby })[0]).toContain("DEFAULT X'01ff'");
    const broken = sqliteTable("broken", { id: text("id").primaryKey(), when: text("when").default((() => 1) as never) });
    expect(() => describeSchema({ broken })).toThrow(UnsupportedSchemaError);
  });
});

describe("running again", () => {
  it("reads one number and stops when the schema is the one last applied", () => {
    const database = seeded();

    const result = syncSchema(database, { items });

    expect(result).toMatchObject({ status: "unchanged", skippedComparison: true });
    expect(database.log).toEqual(["PRAGMA user_version"]);
  });

  it("compares when the number does not match, and records it when nothing needed doing", () => {
    const database = seeded();
    database.raw.exec("PRAGMA user_version = 7");

    expect(syncSchema(database, { items })).toMatchObject({ status: "unchanged", skippedComparison: false });

    expect(rows(database, "PRAGMA user_version")).not.toEqual([{ user_version: 7 }]);
    expect(syncSchema(database, { items }).skippedComparison).toBe(true);
  });

  it("leaves user_version alone when told to", () => {
    const database = open();

    syncSchema(database, { items }, { skipComparisonWhenUnchanged: false });
    syncSchema(database, { items }, { skipComparisonWhenUnchanged: false });

    expect(rows(database, "PRAGMA user_version")).toEqual([{ user_version: 0 }]);
  });
});

describe("adding to a table that holds rows", () => {
  it("adds columns in place and keeps every row", () => {
    const database = seeded();
    const next = sqliteTable(
      "items",
      {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
        done: integer("done", { mode: "boolean" }).notNull().default(false),
        tags: text("tags", { mode: "json" }).notNull().default([]),
        note: text("note"),
        count: integer("count").notNull().default(3),
      },
      (table) => [index("items_title").on(table.title), index("items_note").on(table.note)],
    );

    const result = syncSchema(database, { items: next });

    expect(result.status).toBe("applied");
    expect(result.plan.dataLossRisks).toEqual([]);
    expect(result.plan.statements.some((statement) => statement.includes("__schemasync_new_"))).toBe(false);
    expect(rows(database, "SELECT id, title, note, count FROM items")).toEqual([{ id: "a", title: "First", note: null, count: 3 }]);
    expect(objects(database, "index")).toEqual(["items_note", "items_title"]);
  });

  it("rebuilds for a default ALTER cannot add, and the rows stay", () => {
    const database = seeded();
    const next = sqliteTable("items", {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
      done: integer("done", { mode: "boolean" }).notNull().default(false),
      tags: text("tags", { mode: "json" }).notNull().default([]),
      at: text("at").notNull().default(sql`CURRENT_TIMESTAMP`),
    });

    const result = syncSchema(database, { items: next }, { allowObjectRemoval: true });

    expect(result.plan.changes).toContain("Rebuild table items, keeping its rows");
    const [row] = rows(database, "SELECT id, at FROM items");
    expect(row?.id).toBe("a");
    expect(row?.at).toBeTruthy();
  });

  it("changes a default or lets go of NOT NULL with every row kept and no risk reported", () => {
    const database = seeded();
    const next = sqliteTable("items", {
      id: text("id").primaryKey(),
      title: text("title"),
      done: integer("done", { mode: "boolean" }).notNull().default(true),
      tags: text("tags", { mode: "json" }).notNull().default([]),
    });

    const result = syncSchema(database, { items: next });

    expect(result.plan.dataLossRisks).toEqual([]);
    expect(rows(database, "SELECT title, done FROM items")).toEqual([{ title: "First", done: 0 }]);
    database.raw.exec("INSERT INTO items (id, title) VALUES ('b', NULL)");
    expect(rows(database, "SELECT done FROM items WHERE id = 'b'")).toEqual([{ done: 1 }]);
  });

  it("fills existing nulls from the default when a column becomes required and has one", () => {
    const database = open(`CREATE TABLE t (id text PRIMARY KEY NOT NULL, name text)`, `INSERT INTO t VALUES ('a', NULL), ('b', 'kept')`);
    const t = sqliteTable("t", { id: text("id").primaryKey(), name: text("name").notNull().default("none") });

    const result = syncSchema(database, { t });

    expect(result.plan.dataLossRisks).toEqual([]);
    expect(rows(database, "SELECT id, name FROM t ORDER BY id")).toEqual([
      { id: "a", name: "none" },
      { id: "b", name: "kept" },
    ]);
  });
});

describe("a change that would lose data", () => {
  const lossy = {
    "a new required column with no default": sqliteTable("items", {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
      done: integer("done", { mode: "boolean" }).notNull().default(false),
      tags: text("tags", { mode: "json" }).notNull().default([]),
      owner: text("owner").notNull(),
    }),
    "a type change": sqliteTable("items", {
      id: text("id").primaryKey(),
      title: integer("title").notNull(),
      done: integer("done", { mode: "boolean" }).notNull().default(false),
      tags: text("tags", { mode: "json" }).notNull().default([]),
    }),
    "a different primary key": sqliteTable("items", {
      id: text("id").notNull(),
      title: text("title").primaryKey(),
      done: integer("done", { mode: "boolean" }).notNull().default(false),
      tags: text("tags", { mode: "json" }).notNull().default([]),
    }),
    "a new unique index": sqliteTable(
      "items",
      {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
        done: integer("done", { mode: "boolean" }).notNull().default(false),
        tags: text("tags", { mode: "json" }).notNull().default([]),
      },
      (table) => [index("items_title").on(table.title), uniqueIndex("items_unique_title").on(table.title)],
    ),
    "a new check": sqliteTable(
      "items",
      {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
        done: integer("done", { mode: "boolean" }).notNull().default(false),
        tags: text("tags", { mode: "json" }).notNull().default([]),
      },
      (table) => [index("items_title").on(table.title), check("title_short", sql`length(${table.title}) < 3`)],
    ),
  };

  for (const [name, next] of Object.entries(lossy)) {
    it(`${name}: blocked on a protected table with rows, and nothing changes`, () => {
      const database = seeded();
      database.log.length = 0;

      expect(() => syncSchema(database, { items: next })).toThrow(SchemaChangesBlockedError);

      expect(database.log.filter((line) => !/^(SELECT|PRAGMA)/.test(line))).toEqual([]);
      expect(rows(database, "SELECT id, title FROM items")).toEqual([{ id: "a", title: "First" }]);
    });

    it(`${name}: on an allowed table, the rows are discarded and reported, and the shape is right`, () => {
      const database = seeded();

      const result = syncSchema(database, { items: next }, { allowDataLoss: true, allowObjectRemoval: true });

      expect(result.status).toBe("applied");
      expect(result.plan.discardedRows).toEqual(["items"]);
      expect(result.plan.dataLossRisks.length).toBeGreaterThan(0);
      expect(rows(database, "SELECT * FROM items")).toEqual([]);
      expect(syncSchema(database, { items: next }, { skipComparisonWhenUnchanged: false, allowObjectRemoval: true })).toMatchObject({ status: "unchanged" });
    });

    it(`${name}: a table with no rows has nothing to lose and never blocks`, () => {
      const database = open();
      syncSchema(database, { items });

      const result = syncSchema(database, { items: next }, { allowObjectRemoval: true });

      expect(result.status).toBe("applied");
      expect(result.plan.dataLossRisks).toEqual([]);
      expect(result.plan.discardedRows).toEqual([]);
    });
  }

  it("treats a column becoming required with no default as a loss", () => {
    const database = open(`CREATE TABLE t (id text PRIMARY KEY NOT NULL, name text)`, `INSERT INTO t VALUES ('a', NULL)`);
    const t = sqliteTable("t", { id: text("id").primaryKey(), name: text("name").notNull() });

    expect(() => syncSchema(database, { t })).toThrow(/becomes required/);
    expect(syncSchema(database, { t }, { allowDataLoss: ["t"] }).plan.discardedRows).toEqual(["t"]);
  });

  it("names the rename to declare in the error", () => {
    const database = open(`CREATE TABLE t (id text PRIMARY KEY NOT NULL, name text NOT NULL)`, `INSERT INTO t VALUES ('a', 'x')`);
    const t = sqliteTable("t", { id: text("id").primaryKey(), fullName: text("full_name").notNull() });

    expect(() => syncSchema(database, { t })).toThrow(/renames\.columns\["t"\]\["full_name"\] = "name"/);
  });
});

describe("a column the schema no longer has", () => {
  const without = sqliteTable(
    "items",
    { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false) },
    (table) => [index("items_title").on(table.title)],
  );

  it("is dropped from an allowed table, and the rows stay", () => {
    const database = seeded();

    const result = syncSchema(database, { items: without }, { allowDataLoss: true });

    expect(columns(database, "items")).toEqual(["id", "title", "done"]);
    expect(rows(database, "SELECT id, title FROM items")).toEqual([{ id: "a", title: "First" }]);
    expect(result.plan.discardedRows).toEqual([]);
    expect(result.plan.dataLossRisks).toMatchObject([{ kind: "column-dropped", table: "items", column: "tags" }]);
    expect(objects(database, "index")).toEqual(["items_title"]);
  });

  it("stays in a protected table when it cannot get in the way of an insert, and is reported", () => {
    const database = seeded();

    const result = syncSchema(database, { items: without });

    expect(columns(database, "items")).toEqual(["id", "title", "done", "tags"]);
    expect(result.plan.retained).toEqual([{ type: "column", table: "items", name: "tags" }]);
    expect(result.plan.statements).toEqual([]);
    database.raw.exec("INSERT INTO items (id, title) VALUES ('b', 'Second')");
  });

  it("keeps a retained column through a rebuild the table needs anyway", () => {
    const database = seeded();
    const relaxed = sqliteTable("items", { id: text("id").primaryKey(), title: text("title"), done: integer("done", { mode: "boolean" }).notNull().default(false) }, (table) => [
      index("items_title").on(table.title),
    ]);

    syncSchema(database, { items: relaxed });

    expect(columns(database, "items")).toEqual(["id", "title", "done", "tags"]);
    expect(rows(database, "SELECT title, tags FROM items")).toEqual([{ title: "First", tags: "[]" }]);
  });

  it("blocks a protected table when it is required and has no default, since inserts would fail", () => {
    const database = open(`CREATE TABLE t (id text PRIMARY KEY NOT NULL, gone text NOT NULL)`, `INSERT INTO t VALUES ('a', 'x')`);
    const t = sqliteTable("t", { id: text("id").primaryKey() });

    expect(() => syncSchema(database, { t })).toThrow(/cannot stay and cannot be dropped/);
  });

  it("is dropped from an empty protected table with no risk", () => {
    const database = open();
    syncSchema(database, { items });

    const result = syncSchema(database, { items: without });

    expect(columns(database, "items")).toEqual(["id", "title", "done"]);
    expect(result.plan.dataLossRisks).toEqual([]);
  });
});

describe("what the schema does not mention", () => {
  it("is retained by default: tables and indexes", () => {
    const database = seeded();
    database.raw.exec("CREATE TABLE extra (id text); INSERT INTO extra VALUES ('x'); CREATE INDEX items_extra ON items (title, done)");

    const result = syncSchema(database, { items }, { skipComparisonWhenUnchanged: false });

    expect(result.status).toBe("unchanged");
    expect(result.plan.retained).toEqual(
      expect.arrayContaining([
        { type: "table", table: "extra", name: "extra" },
        { type: "index", table: "items", name: "items_extra" },
      ]),
    );
    expect(objects(database, "table")).toEqual(["extra", "items"]);
    expect(objects(database, "index")).toEqual(["items_extra", "items_title"]);
  });

  it("is dropped with allowObjectRemoval; a table with rows also needs allowDataLoss", () => {
    const database = seeded();
    database.raw.exec("CREATE TABLE empty_one (id text); CREATE TABLE full_one (id text); INSERT INTO full_one VALUES ('x'); CREATE INDEX items_extra ON items (title, done)");

    expect(() => syncSchema(database, { items }, { allowObjectRemoval: true })).toThrow(/full_one has rows/);

    const result = syncSchema(database, { items }, { allowObjectRemoval: true, allowDataLoss: { except: [items] } });
    expect(objects(database, "table")).toEqual(["items"]);
    expect(objects(database, "index")).toEqual(["items_title"]);
    expect(result.plan.discardedRows).toEqual(["full_one"]);
  });

  it("is never touched when ignored, even with removal allowed", () => {
    const database = seeded();
    database.raw.exec("CREATE TABLE __drizzle_migrations (id integer); INSERT INTO __drizzle_migrations VALUES (1)");

    const result = syncSchema(database, { items }, { allowObjectRemoval: true, allowDataLoss: true, ignoreTables: ["__drizzle_migrations"] });

    expect(result.plan.statements).toEqual([]);
    expect(rows(database, "SELECT * FROM __drizzle_migrations")).toEqual([{ id: 1 }]);
  });

  it("keeps a retained index through a rebuild, unless its column went", () => {
    const database = seeded();
    database.raw.exec("CREATE INDEX items_extra ON items (done); CREATE INDEX items_on_tags ON items (tags)");
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false) }, (table) => [
      index("items_title").on(table.title),
    ]);

    const result = syncSchema(database, { items: next }, { allowDataLoss: ["items"] });

    expect(objects(database, "index")).toEqual(["items_extra", "items_title"]);
    expect(result.plan.changes).toContain("Drop index items_on_tags, whose column is gone");
  });

  it("lets go of an index on a rebuild when removal is allowed", () => {
    const database = seeded();
    database.raw.exec("CREATE INDEX items_extra ON items (done)");
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false) }, (table) => [
      index("items_title").on(table.title),
    ]);

    syncSchema(database, { items: next }, { allowDataLoss: true, allowObjectRemoval: true });

    expect(objects(database, "index")).toEqual(["items_title"]);
  });

  it("changes an index in place when its definition moved", () => {
    const database = seeded();
    const next = sqliteTable(
      "items",
      {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
        done: integer("done", { mode: "boolean" }).notNull().default(false),
        tags: text("tags", { mode: "json" }).notNull().default([]),
      },
      (table) => [index("items_title").on(table.done)],
    );

    const result = syncSchema(database, { items: next });

    expect(result.plan.changes).toEqual(["Change index items_title on items"]);
    expect(rows(database, "SELECT sql FROM sqlite_master WHERE name = 'items_title'")[0]?.sql).toContain("done");
  });

  it("puts triggers and views back after a rebuild", () => {
    const database = seeded();
    database.raw.exec(`CREATE TABLE audit (at text);
      CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit VALUES ('x'); END;
      CREATE TRIGGER extra_audit AFTER INSERT ON audit BEGIN SELECT 1; END;
      CREATE VIEW item_titles AS SELECT title FROM items`);
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title"), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]) }, (table) => [
      index("items_title").on(table.title),
    ]);

    syncSchema(database, { items: next });

    expect(objects(database, "trigger")).toEqual(["extra_audit", "items_audit"]);
    expect(objects(database, "view")).toEqual(["item_titles"]);
    database.raw.exec("INSERT INTO items (id, title) VALUES ('b', 'Second')");
    expect(rows(database, "SELECT count(*) AS n FROM audit")).toEqual([{ n: 1 }]);
    expect(rows(database, "SELECT count(*) AS n FROM item_titles")).toEqual([{ n: 2 }]);
  });

  it("does not bring back a trigger whose table was removed", () => {
    const database = seeded();
    database.raw.exec(`CREATE TABLE audit (at text); CREATE TRIGGER audit_trigger AFTER INSERT ON audit BEGIN SELECT 1; END`);
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title"), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]) }, (table) => [
      index("items_title").on(table.title),
    ]);

    syncSchema(database, { items: next }, { allowObjectRemoval: true });

    expect(objects(database, "trigger")).toEqual([]);
    expect(objects(database, "table")).toEqual(["items"]);
  });

  it("leaves a virtual table and the tables that hold its data alone, even with removal allowed", () => {
    const database = seeded();
    database.raw.exec(`CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search VALUES ('kitchen')`);

    const result = syncSchema(database, { items }, { allowObjectRemoval: true, allowDataLoss: true });

    expect(result.plan.statements).toEqual([]);
    expect(rows(database, "SELECT body FROM search WHERE search MATCH 'kitchen'")).toEqual([{ body: "kitchen" }]);
  });

  it("does not bring back or trip over a trigger on an ignored table", () => {
    const database = seeded();
    database.raw.exec(`CREATE TABLE ledger (id text); CREATE TRIGGER ledger_t AFTER INSERT ON ledger BEGIN SELECT 1; END`);
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title"), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]) }, (table) => [
      index("items_title").on(table.title),
    ]);

    const result = syncSchema(database, { items: next }, { ignoreTables: ["ledger"] });

    expect(result.status).toBe("applied");
    expect(objects(database, "trigger")).toEqual(["ledger_t"]);
  });

  it("never reuses an AUTOINCREMENT key after a rebuild, even one whose row is gone", () => {
    const queue = sqliteTable("queue", { seq: integer("seq").primaryKey({ autoIncrement: true }), body: text("body").notNull() });
    const relaxed = sqliteTable("queue", { seq: integer("seq").primaryKey({ autoIncrement: true }), body: text("body") });
    const database = open();
    syncSchema(database, { queue });
    database.raw.exec(`INSERT INTO queue (body) VALUES ('a'), ('b'), ('c'); DELETE FROM queue WHERE body = 'c'`);

    const result = syncSchema(database, { queue: relaxed });

    expect(result.plan.changes).toContain("Rebuild table queue, keeping its rows");
    database.raw.exec(`INSERT INTO queue (body) VALUES ('next')`);
    expect(rows(database, "SELECT seq FROM queue WHERE body = 'next'")).toEqual([{ seq: 4 }]);
    expect(rows(database, "SELECT count(*) AS n FROM sqlite_sequence")).toEqual([{ n: 1 }]);
  });

  it("starts an AUTOINCREMENT table over only when no rows came across", () => {
    const queue = sqliteTable("queue", { seq: integer("seq").primaryKey({ autoIncrement: true }), body: text("body") });
    const database = open(`CREATE TABLE queue (seq integer PRIMARY KEY AUTOINCREMENT NOT NULL, body integer)`, `INSERT INTO queue (body) VALUES (1), (2)`);

    const result = syncSchema(database, { queue }, { allowDataLoss: true });

    expect(result.plan.discardedRows).toEqual(["queue"]);
    database.raw.exec(`INSERT INTO queue (body) VALUES ('first')`);
    expect(rows(database, "SELECT seq FROM queue")).toEqual([{ seq: 1 }]);
  });
});

describe("renames", () => {
  it("renames a table, its rows going with it", () => {
    const database = open(`CREATE TABLE old_t (id text PRIMARY KEY NOT NULL)`, `INSERT INTO old_t VALUES ('a')`);
    const t = sqliteTable("t", { id: text("id").primaryKey() });

    const result = syncSchema(database, { t }, { renames: { tables: { t: "old_t" } } });

    expect(result.plan.changes).toEqual(["Rename table old_t to t"]);
    expect(rows(database, "SELECT id FROM t")).toEqual([{ id: "a" }]);
    expect(objects(database, "table")).toEqual(["t"]);
  });

  it("renames a column and keeps its values, in a protected table", () => {
    const database = open(`CREATE TABLE t (id text PRIMARY KEY NOT NULL, name text NOT NULL)`, `CREATE INDEX t_name ON t (name)`, `INSERT INTO t VALUES ('a', 'x')`);
    const t = sqliteTable("t", { id: text("id").primaryKey(), fullName: text("full_name").notNull() }, (table) => [index("t_name").on(table.fullName)]);

    const result = syncSchema(database, { t }, { renames: { columns: { t: { full_name: "name" } } } });

    expect(rows(database, "SELECT full_name FROM t")).toEqual([{ full_name: "x" }]);
    expect(result.plan.dataLossRisks).toEqual([]);
    expect(syncSchema(database, { t }, { skipComparisonWhenUnchanged: false }).status).toBe("unchanged");
  });

  it("does both at once, counting rows under the old name", () => {
    const database = open(`CREATE TABLE old_t (id text PRIMARY KEY NOT NULL, name text NOT NULL)`, `INSERT INTO old_t VALUES ('a', 'x')`);
    const t = sqliteTable("t", { id: text("id").primaryKey(), fullName: text("full_name").notNull(), extra: text("extra").notNull() });

    expect(() => syncSchema(database, { t }, { renames: { tables: { t: "old_t" }, columns: { t: { full_name: "name" } } } })).toThrow(/extra is new and required/);
  });

  it("does nothing once applied, or for a name that is not there, and survives a rename left in place forever", () => {
    const database = open(`CREATE TABLE t (id text PRIMARY KEY NOT NULL)`);
    const t = sqliteTable("t", { id: text("id").primaryKey() });
    const renames = { tables: { t: "old_t", other: "t", absent: "also_absent" }, columns: { t: { id: "was_id", ghost: "id" }, nowhere: { a: "b" } } };

    const result = syncSchema(database, { t }, { renames, skipComparisonWhenUnchanged: false });

    expect(result.status).toBe("unchanged");
  });

  it("suggests a table rename when a table disappears and a like-shaped one appears", () => {
    const database = open(`CREATE TABLE old_t (id text PRIMARY KEY NOT NULL)`, `INSERT INTO old_t VALUES ('a')`);
    const t = sqliteTable("t", { id: text("id").primaryKey() });

    const result = syncSchema(database, { t }, { dryRun: true });

    expect(result.plan.renameHints).toEqual([{ table: "t", from: "old_t", to: "t", declare: `renames.tables["t"] = "old_t"` }]);
  });
});

describe("foreign keys", () => {
  const parent = sqliteTable("parent", { id: text("id").primaryKey(), note: text("note") });
  const child = sqliteTable("child", { id: text("id").primaryKey(), parentId: text("parent_id").references(() => parent.id, { onDelete: "cascade" }) });

  const populated = () => {
    const database = open("PRAGMA foreign_keys = ON");
    syncSchema(database, { parent, child });
    database.raw.exec(`INSERT INTO parent VALUES ('p', 'n'); INSERT INTO child VALUES ('c', 'p')`);
    return database;
  };

  it("rebuilds a parent with enforcement on without cascading away its children, then turns enforcement back on", () => {
    const database = populated();
    const nextParent = sqliteTable("parent", { id: text("id").primaryKey(), note: text("note").notNull().default("") });

    const result = syncSchema(database, { parent: nextParent, child });

    expect(result.status).toBe("applied");
    expect(rows(database, "SELECT id FROM child")).toEqual([{ id: "c" }]);
    expect(rows(database, "PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("rolls everything back when a rebuild would leave a row without its parent", () => {
    const database = populated();
    database.raw.exec("PRAGMA foreign_keys = OFF; INSERT INTO child VALUES ('orphan', 'nobody'); PRAGMA foreign_keys = ON");
    const nextParent = sqliteTable("parent", { id: text("id").primaryKey(), note: text("note").notNull().default("") });

    expect(() => syncSchema(database, { parent: nextParent, child })).toThrow(/missing parent/);

    expect(rows(database, "SELECT sql FROM sqlite_master WHERE name = 'parent'")[0]?.sql).not.toContain("DEFAULT");
    expect(rows(database, "PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("removes a parent table with enforcement on without cascading away the rows of a table that stays", () => {
    const database = populated();
    const free = sqliteTable("child", { id: text("id").primaryKey(), parentId: text("parent_id") });

    const result = syncSchema(database, { child: free }, { allowObjectRemoval: true, allowDataLoss: true });

    expect(result.plan.discardedRows).toEqual(["parent"]);
    expect(rows(database, "SELECT id, parent_id FROM child")).toEqual([{ id: "c", parent_id: "p" }]);
    expect(rows(database, "PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("reports the real failure when even turning enforcement back on fails", () => {
    const database = populated();
    const nextParent = sqliteTable("parent", { id: text("id").primaryKey(), note: text("note").notNull().default("") });
    const broken = {
      all: database.all,
      exec(statement: string) {
        if (statement === "PRAGMA foreign_keys = ON") throw new Error("connection is gone");
        if (statement.startsWith("INSERT INTO")) throw new Error("disk I/O error");
        database.exec(statement);
      },
    };

    expect(() => syncSchema(broken, { parent: nextParent, child })).toThrow("disk I/O error");
  });

  it("reports turning enforcement back on when that is the only failure", () => {
    const database = populated();
    const nextParent = sqliteTable("parent", { id: text("id").primaryKey(), note: text("note").notNull().default("") });
    const broken = {
      all: database.all,
      exec(statement: string) {
        if (statement === "PRAGMA foreign_keys = ON") throw new Error("connection is gone");
        database.exec(statement);
      },
    };

    expect(() => syncSchema(broken, { parent: nextParent, child })).toThrow("connection is gone");
  });

  it("sees a changed action as a change, with no loss", () => {
    const database = populated();
    const nextChild = sqliteTable("child", { id: text("id").primaryKey(), parentId: text("parent_id").references(() => parent.id, { onDelete: "set null" }) });

    const result = syncSchema(database, { parent, child: nextChild });

    expect(result.plan.changes).toContain("Rebuild table child, keeping its rows");
    expect(result.plan.dataLossRisks).toEqual([]);
    expect(rows(database, "SELECT on_delete FROM pragma_foreign_key_list('child')")).toEqual([{ on_delete: "SET NULL" }]);
  });
});

describe("the transaction", () => {
  it("rolls back on a failing statement and reports that statement's error, even when the rollback fails too", () => {
    const database = seeded();
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), note: text("note"), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]) }, (table) => [
      index("items_title").on(table.title),
    ]);
    const exec = database.exec;
    const failing = {
      ...database,
      exec(statement: string) {
        if (statement.startsWith("ALTER")) throw new Error("disk I/O error");
        if (statement === "ROLLBACK") {
          exec("ROLLBACK");
          throw new Error("cannot rollback - no transaction is active");
        }
        exec(statement);
      },
    };

    expect(() => syncSchema(failing, { items: next })).toThrow("disk I/O error");

    expect(columns(database, "items")).toEqual(["id", "title", "done", "tags"]);
  });

  it("does not record the schema as applied when the deployment failed", () => {
    const database = seeded();
    const before = rows(database, "PRAGMA user_version");
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]), note: text("note") }, (table) => [
      index("items_title").on(table.title),
    ]);

    expect(() => syncSchema(database, { items: next }, { afterDeploy: () => ["this is not sql"] })).toThrow();

    expect(rows(database, "PRAGMA user_version")).toEqual(before);
    expect(columns(database, "items")).toEqual(["id", "title", "done", "tags"]);
  });

  it("runs the hooks in order inside it, with the plan, and not at all when there is nothing to do", () => {
    const database = seeded();
    database.raw.exec("CREATE TABLE ledger (entry text)");
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]), note: text("note") }, (table) => [
      index("items_title").on(table.title),
    ]);
    const options = {
      beforeDeploy: () => [`INSERT INTO ledger VALUES ('before')`],
      afterDeploy: (plan: { changes: string[] }) => [`INSERT INTO ledger VALUES ('${plan.changes[0]}')`],
    };

    syncSchema(database, { items: next }, options);
    syncSchema(database, { items: next }, { ...options, skipComparisonWhenUnchanged: false });

    expect(rows(database, "SELECT entry FROM ledger")).toEqual([{ entry: "before" }, { entry: "Add column items.note" }]);
  });
});

describe("a dry run", () => {
  it("changes nothing, blocks nothing, and says what would happen", () => {
    const database = seeded();
    const next = sqliteTable("items", { id: text("id").primaryKey(), owner: text("owner").notNull() });

    const result = syncSchema(database, { items: next }, { dryRun: true });

    expect(result.status).toBe("previewed");
    expect(result.plan.blocked.map((risk) => risk.kind)).toContain("required-column-added");
    expect(database.log.filter((line) => !/^(SELECT|PRAGMA)/.test(line))).toEqual([]);
    expect(describeResult(result)).toContain("Blocked: items.owner is new and required");
  });
});

describe("describing a result", () => {
  it("says what was done, what was lost and what stayed", () => {
    const database = seeded();
    const next = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull() });

    const dropped = describeResult(syncSchema(database, { items: next }, { allowDataLoss: true }));
    expect(dropped).toContain("Applied");
    expect(dropped).toContain("Rebuild table items, keeping its rows");
    expect(dropped).toContain("Data loss: items.done is no longer in the schema");

    const again = seeded();
    const kept = describeResult(syncSchema(again, { items: next }));
    expect(kept).toContain("Schema unchanged.");
    expect(kept).toContain("Retained column: items.done");
    expect(kept).toContain("Retained index: items_title");
  });

  it("speaks of a dry run in the future, and of nothing to do as nothing to do", () => {
    const database = seeded();
    const added = sqliteTable("items", { id: text("id").primaryKey(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false), tags: text("tags", { mode: "json" }).notNull().default([]), note: text("note") }, (table) => [
      index("items_title").on(table.title),
    ]);

    expect(describeResult(syncSchema(database, { items: added }, { dryRun: true }))).toContain("Would apply 1 change(s).");
    expect(describeResult(syncSchema(database, { items }, { dryRun: true }))).toContain("Schema unchanged.");
  });
});

describe("what it refuses", () => {
  it("generated columns and views, before anything runs", () => {
    const generated = sqliteTable("g", { id: text("id").primaryKey(), upper: text("upper").generatedAlwaysAs(sql`upper(id)`) });
    expect(() => syncSchema(open(), { generated })).toThrow(/generated columns are not supported/);

    const view = sqliteView("v").as((builder) => builder.select().from(items));
    expect(() => syncSchema(open(), { items, view })).toThrow(/views are not supported/);
  });

  it("two tables of one name", () => {
    expect(() => describeSchema({ a: items, b: items })).toThrow(/two exports/);
  });

  it("anything that is not a connection, and an asynchronous connection on the synchronous call", () => {
    expect(() => syncSchema({} as never, { items })).toThrow(/needs a Drizzle SQLite database/);
    const asynchronous = { exec: async () => undefined, all: async () => [] };
    expect(() => syncSchema(asynchronous as never, { items })).toThrow(/Use syncSchemaAsync/);
  });

  it("ignores what a schema module exports that is not a table", () => {
    expect(describeSchema({ items, helper: () => 1, name: "x", nothing: null }).tables).toHaveLength(1);
  });
});

describe("comparing two schemas with no database", () => {
  const released = sqliteTable("outbox", { id: text("id").primaryKey(), body: text("body"), attempts: integer("attempts").notNull().default(0) });

  it("assumes every table holds rows, and so finds what would block on a device", () => {
    const next = sqliteTable("outbox", { id: text("id").primaryKey(), body: integer("body"), attempts: integer("attempts").notNull().default(0) });

    const plan = diffSchemas({ outbox: released }, { outbox: next }, { allowDataLoss: { except: [next] } });

    expect(plan.blocked).toMatchObject([{ kind: "type-changed", table: "outbox", column: "body" }]);
  });

  it("is clean for an additive change, and takes a model as either side", () => {
    const next = sqliteTable("outbox", { id: text("id").primaryKey(), body: text("body"), attempts: integer("attempts").notNull().default(0), via: text("via") });

    const plan = diffSchemas(describeSchema({ outbox: released }), describeSchema({ outbox: next }));

    expect(plan.blocked).toEqual([]);
    expect(plan.changes).toEqual(["Add column outbox.via"]);
  });
});

describe("the data-loss policy's shapes", () => {
  const next = sqliteTable("items", { id: text("id").primaryKey(), owner: text("owner").notNull() });

  it("takes names, tables, an exception list, and false", () => {
    const from = { items };
    const to = { items: next };
    expect(diffSchemas(from, to, { allowDataLoss: ["items"] }).blocked).toEqual([]);
    expect(diffSchemas(from, to, { allowDataLoss: [next] }).blocked).toEqual([]);
    expect(diffSchemas(from, to, { allowDataLoss: ["other"] }).blocked).not.toEqual([]);
    expect(diffSchemas(from, to, { allowDataLoss: { except: ["other"] } }).blocked).toEqual([]);
    expect(diffSchemas(from, to, { allowDataLoss: { except: ["items"] } }).blocked).not.toEqual([]);
    expect(diffSchemas(from, to, { allowDataLoss: false }).blocked).not.toEqual([]);
  });
});
