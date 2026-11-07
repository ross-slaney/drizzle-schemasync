# drizzle-schemasync

**Your Drizzle schema is your database. No migration files.**

Compare your Drizzle schema with a live SQLite database and apply the difference, on the device, at startup, with one call. Made for apps where every client has its own database: Expo on phones and the web, offline-first apps, desktop apps, a database per tenant.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ross-slaney/drizzle-schemasync/actions/workflows/ci.yml/badge.svg)](https://github.com/ross-slaney/drizzle-schemasync/actions/workflows/ci.yml)

```ts
import { expoSqlite, syncSchema } from "drizzle-schemasync";
import { openDatabaseSync } from "expo-sqlite";

import * as schema from "./schema";

const sqlite = openDatabaseSync("app.db");

syncSchema(expoSqlite(sqlite), schema);
```

That call reads the tables out of your schema module, reads what the database file actually holds, works out the difference and applies it in one transaction. A fresh install, a phone one version behind and a phone twenty versions behind all run the same code and end up in the same place.

Your Drizzle tables are the only schema definition you maintain. There is no `drizzle/` folder, no journal, no snapshots, no generate step and no bundling of SQL into your app.

This is the SQLite and Drizzle sibling of [EFCore.SchemaSync](https://github.com/ross-slaney/EFCore.SchemaSync), which does the same for EF Core and SQL Server, and it uses the same option names and the same stance on data loss.

## Contents

- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [What happens to your data](#what-happens-to-your-data)
- [Things the schema does not mention](#things-the-schema-does-not-mention)
- [Options](#options)
- [Results and errors](#results-and-errors)
- [Renames](#renames)
- [Hooks: fixing data during a change](#hooks-fixing-data-during-a-change)
- [Catching a bad change in CI](#catching-a-bad-change-in-ci)
- [Fast restarts](#fast-restarts)
- [Should you use this?](#should-you-use-this)
- [Moving from drizzle-kit migrations](docs/moving-from-drizzle-migrations.md)
- [Limitations](#limitations)
- [Tests](#tests)
- [Releasing](#releasing)

## How it works

1. **Describe.** `getTableConfig` from `drizzle-orm/sqlite-core` gives every table's columns, keys, defaults, indexes, foreign keys and checks. This runs in Hermes and the browser, where `drizzle-kit` cannot.
2. **Inspect.** `sqlite_master` and SQLite's table-valued pragmas give the same description of the file. Quoting, spacing and the order columns were added in are not differences.
3. **Plan.** A pure function compares the two and decides, table by table, what to do and what it would cost. It never touches the database.
4. **Apply.** Everything runs in one transaction. A failure rolls it all back and reports the statement that failed.

SQLite can add a column in place, and the plan uses that when it can. Any other change to a table goes through the [rebuild SQLite documents](https://www.sqlite.org/lang_altertable.html#otheralter): create the new table, copy the rows, drop the old one, rename the new one, put back its indexes, triggers and views. Using one path for everything means no dependence on your SQLite version and none of `ALTER TABLE`'s special cases.

## Getting started

```bash
npm install https://github.com/ross-slaney/drizzle-schemasync/releases/download/v0.1.1/drizzle-schemasync-0.1.1.tgz
```

`drizzle-orm` is a peer dependency. There are no others.

**A driver with synchronous calls** (expo-sqlite on a phone, better-sqlite3, `node:sqlite`, sql.js): call `syncSchema`. A Drizzle database works directly.

```ts
const db = drizzle(sqlite, { schema });
syncSchema(db, schema);
```

**A driver with asynchronous calls** (expo-sqlite on the web, libSQL, D1): call `syncSchemaAsync`. It runs the same logic and sends the same statements in the same order.

```ts
await syncSchemaAsync(expoSqliteAsync(sqlite), schema);
```

On the web, use the asynchronous calls even though expo-sqlite offers synchronous ones. Its browser bridge times a synchronous call out after a fixed spin, and creating twenty tables on a slow disk takes longer than that.

**Any other driver** needs two functions:

```ts
syncSchema({ exec: (statement) => mine.run(statement), all: (query) => mine.query(query) }, schema);
```

Call it once when the database opens, before anything reads from it.

## What happens to your data

By default every table is protected, the same as `AllowDataLoss = false` in EFCore.SchemaSync. A change that could lose data on a table holding rows stops the deployment before it starts. A table with no rows has nothing to lose and never blocks.

Many local databases are mostly a copy of what a server holds. Say which tables can be refilled and the rest takes care of itself:

```ts
syncSchema(connection, schema, {
  allowDataLoss: { except: [outbox, pendingUploads] }, // only these hold data the server does not have
  allowObjectRemoval: true,
});
```

| Change, on a table with rows | Allowed table | Protected table |
| --- | --- | --- |
| New table, nullable column, column with a default, new index | Done in place | Done in place |
| Default changed, `NOT NULL` removed, foreign key changed | Rebuilt, rows kept | Rebuilt, rows kept |
| Column becomes required and has a default | Rebuilt, nulls filled from the default | Rebuilt, nulls filled from the default |
| Column removed | Rebuilt, column gone, rows kept | Column stays, unread, listed in `retained` |
| Column removed that is `NOT NULL` with no default | Rebuilt, column gone, rows kept | **Blocked**: inserts would fail if it stayed |
| New required column with no default | Rows discarded | **Blocked** |
| Column becomes required with no default | Rows discarded | **Blocked** |
| Column type changed | Rows discarded | **Blocked** |
| Primary key changed | Rows discarded | **Blocked** |
| New unique index or new `CHECK` | Rows discarded | **Blocked** |

"Rows discarded" is reported in `plan.discardedRows`, so you can make whatever tracks those rows forget them in the same transaction. See [hooks](#hooks-fixing-data-during-a-change).

A protected table keeps a removed column because that is what makes rollback safe. If you ship a build that adds a column and then roll back, the older build sees a column it does not know. It leaves it alone instead of refusing to start.

Allowed tables lose values only in the cases the table lists. A rebuild that can keep rows keeps them, so a device that is offline right after an update still shows its data.

## Things the schema does not mention

Tables and indexes the schema does not name are kept and listed in `plan.retained`, unless you pass `allowObjectRemoval: true`. Dropping a table that holds rows also needs that table to be allowed by `allowDataLoss`. Triggers and views are not managed, and they survive rebuilds.

`ignoreTables` names tables this library never reads, changes or drops, whatever the other options say.

## Options

```ts
syncSchema(connection, schema, {
  allowDataLoss: false,               // or true, ["a", tableB], or { except: ["a", tableB] }
  allowObjectRemoval: false,          // drop tables and indexes the schema does not mention
  ignoreTables: [],                   // never touch these
  renames: { tables: {}, columns: {} }, // see Renames
  dryRun: false,                      // compare and report, change nothing, block nothing
  skipComparisonWhenUnchanged: true,  // see Fast restarts
  beforeDeploy: (plan) => [],         // statements to run first, in the transaction
  afterDeploy: (plan) => [],          // statements to run last, in the transaction
});
```

## Results and errors

```ts
const result = syncSchema(connection, schema);

result.status;            // "unchanged" | "applied" | "previewed"
result.skippedComparison; // true when the fingerprint matched and the database was not read
result.plan.statements;   // the SQL, in order
result.plan.changes;      // the same in words
result.plan.dataLossRisks;// losses the policy allowed, which happened
result.plan.blocked;      // losses it did not allow (only seen on a dry run; otherwise it throws)
result.plan.discardedRows;// tables whose rows are gone
result.plan.retained;     // tables, columns and indexes kept
result.plan.renameHints;  // likely renames you have not declared

console.log(describeResult(result));
// Applied 3 change(s).
//   Add column items.note
//   Rebuild table schedules, keeping its rows
//   Drop column schedules.title
//   Data loss: schedules.title is no longer in the schema; its values go.
```

| Error | Meaning | State of the database |
| --- | --- | --- |
| `SchemaChangesBlockedError` | A protected table would lose data. `.blocked` and `.renameHints` say what and why. | Untouched. Nothing ran. |
| `UnsupportedSchemaError` | The schema uses something this library cannot compare, such as a generated column. | Untouched. Nothing ran. |
| Any other error | A statement failed. The error is that statement's, even if the rollback failed too. | Rolled back. |

Do not answer `SchemaChangesBlockedError` by deleting the database, even if your app recreates a database that will not open. The tables it protects are the ones you said cannot be refilled.

## Renames

Without a hint, a rename looks like a drop and an add. The library never guesses, because a wrong guess moves data into the wrong column. It suggests instead:

```
Schema changes would lose data and were not applied:
  t.full_name is new and required with no default.
  If it was renamed, declare renames.columns["t"]["full_name"] = "name".
```

Declare it and the values move:

```ts
syncSchema(connection, schema, {
  renames: {
    tables: { new_table_name: "old_table_name" },
    columns: { table_name: { new_column: "old_column" } },
  },
});
```

A rename applies only when the old name exists and the new one does not, so it is safe to leave in place forever. On a phone you should leave it there, because a device that was offline for a year still needs it.

For tables you allow to lose data, you usually do not need a rename at all. The old column goes, the new one arrives empty and the next sync fills it.

## Hooks: fixing data during a change

`beforeDeploy` and `afterDeploy` return statements that run in the same transaction as the change. They run only when there is something to do.

The common case is keeping a local sync cursor honest. When rows are discarded, whatever says those rows are up to date has to forget them:

```ts
afterDeploy: ({ discardedRows }) =>
  discardedRows.map((table) => `DELETE FROM sync_state WHERE entity = '${table}'`),
```

`beforeDeploy` is where a one-off fix goes: shortening values, removing duplicates before a unique index, and so on. A block still stops the deployment before hooks run, because the check happens first. If the fix is what makes a change safe, allow the loss for that table in the same release.

## Catching a bad change in CI

Nobody reviews a plan on a phone, so the review happens before the release. `diffSchemas` compares two schemas with no database, assuming every table holds rows. Compare with the schema of your last release:

```ts
import { diffSchemas } from "drizzle-schemasync";

import * as released from "./released-schema"; // from your last release's tag
import * as current from "./schema";

const plan = diffSchemas(released, current, syncOptions);

expect(plan.blocked).toEqual([]);
console.log(plan.changes); // what every device will do
```

A change that would be blocked on a device then fails your pull request instead.

`createStatements(schema)` returns the SQL for a fresh database, which is handy for tests and for reading what a schema produces.

## Fast restarts

After a successful run the library stores a fingerprint of the schema and policy in `PRAGMA user_version`. The next run reads that one number, and if it matches, it stops. Comparing happens once per schema change on each device, not on every launch.

If something else in your app owns `user_version`, pass `skipComparisonWhenUnchanged: false`. The library then leaves the number alone and compares every time, which reads a few system tables and costs a few milliseconds.

## Should you use this?

Versioned migrations are the standard for a reason. They exist because a server database is the only copy of its data and has many environments that must change the same way, under review. A wrong guess about a rename destroys the only copy, so people write each step down and approve it. Prisma's and Atlas's docs both recommend versioned migrations for production on those grounds, and they are right about server databases.

A database on a device is different:

| | A server database | A database on each device |
| --- | --- | --- |
| Who owns the data | The database | The server, in most apps. The device has a copy. |
| Who approves a change | A person, before it runs | Nobody can. It has to be safe by policy. |
| Path to the new version | One deployment after another | Any version to any version. Devices skip releases. |
| Rolling back | Down migrations | Often impossible for the user. Extra columns have to be harmless. |

Core Data's lightweight migration and Realm's automatic migration already work this way, because native mobile developers have had this problem for a long time. Migration files came to phones along with ORMs written for servers.

**Use it** when the data in the file is a copy of something else, or when you can name the tables that are not.

**Keep migrations** when the SQLite file is the only copy of the data and every table matters, when changes must be approved statement by statement, or when you run a shared server database. For Postgres and MySQL, look at `drizzle-kit push` or [Atlas](https://atlasgo.io).

`drizzle-kit push` is the same idea, but it is a Node command-line tool. It needs `fs` and `net`, asks its questions at a prompt, and cannot run on a device. This library does the on-device part.

## Limitations

- SQLite only. Other databases do not have a per-client problem to solve.
- Generated columns and `sqliteView` are rejected with `UnsupportedSchemaError` rather than ignored. Create views in `afterDeploy`.
- `casing` on the Drizzle instance is not read. Name your columns in the schema.
- Column order is not compared. A database that grew by `ADD COLUMN` keeps its order, so read columns by name.
- Unnamed `CHECK` constraints in a table you created by hand are not seen. Drizzle always names them.
- Adding a unique index or a `CHECK` is treated as losing rows whenever the table has any, without looking at whether they would actually conflict. That errs on the safe side, but it may discard rows that would have been fine.
- `PRAGMA user_version` is used for the fingerprint unless you turn that off.
- Discarding a parent table's rows while a child table keeps rows pointing at them fails the foreign key check and rolls back. Allow the loss on the child too, or drop the foreign key.
- Two connections must not run this at once. Hold a lock if your platform allows two, such as a Web Lock in a browser.

## Tests

```bash
npm test
```

The tests run on real SQLite (`node:sqlite`) and on sql.js through Drizzle. They include a matrix taking every test schema to every other with rows present, checking that a second run compares for real and finds nothing, and a check that a database built by `drizzle-kit`'s own migrations needs no change at all.

## Releasing

Publish a GitHub release tagged `vX.Y.Z`, matching `version` in `package.json`. The workflow tests, packs and attaches the tarball to the release. If the repository has an `NPM_TOKEN` secret it also publishes to npm.

## License

[MIT](LICENSE)
