# Moving from drizzle-kit migrations

A database built by `drizzle-kit` migrations already matches its schema, so the first run usually changes nothing. Column order differences are ignored and so is the quoting `drizzle-kit` uses. There is no data step.

## 1. Check it on your real history before deleting anything

Do this first, while the SQL files still exist. For each version you have shipped, build the database that version left and see what the library would do with it:

```ts
import { DatabaseSync } from "node:sqlite";
import { describeResult, syncSchema } from "drizzle-schemasync";
import * as schema from "./schema";

const raw = new DatabaseSync(":memory:");
for (const statement of sqlFromThatRelease) raw.exec(statement);

const connection = { exec: (s) => raw.exec(s), all: (q) => raw.prepare(q).all() };
console.log(describeResult(syncSchema(connection, schema, { ...options, dryRun: true })));
```

Your latest release should say `Schema unchanged.` Older ones should list only what you expect. Anything under `Blocked:` needs a decision before you continue.

## 2. Read your migrations for data changes

A schema difference cannot express a migration that did more than change the schema. Search for them:

```bash
grep -lE '^(INSERT|UPDATE|DELETE)' drizzle/*.sql | xargs grep -LE '__new_'
```

`INSERT` statements inside `__new_` rebuilds are the tool's own copies and need nothing. Hand-written statements need a home. Decide whether each still matters to a device that has not run it yet, and move the ones that do to `beforeDeploy` or `afterDeploy`. Often the answer is that a rule covers it. Clearing a table when its shape changes, for example, is what `discardedRows` and an `afterDeploy` hook do on every change from now on.

## 3. Decide what is protected

List the tables holding data that exists nowhere else, then read the code that reads them. A table can look refillable and still be load-bearing: one that a cleanup job uses to decide which other rows are stale, for example, has to be protected along with those rows.

## 4. Replace the migrator

```diff
-import { migrate } from "drizzle-orm/expo-sqlite/migrator";
-import migrations from "./drizzle/migrations";
-migrate(db, migrations);
+import { expoSqlite, syncSchema } from "drizzle-schemasync";
+syncSchema(expoSqlite(sqlite), schema, options);
```

Keep `__drizzle_migrations` for one release cycle by adding it to `ignoreTables`. A build you roll back to still reads that table to decide what to run, and if it is gone that build replays every migration against tables that already exist.

## 5. Delete the files

```bash
rm -rf drizzle drizzle.config.ts
npm uninstall drizzle-kit
```

Remove the generate script and any step that bundled SQL into the app.

## 6. Add the CI check

Compare the current schema with your last release's using `diffSchemas`, so that a change that would block on a device fails the pull request. See [Catching a bad change in CI](../README.md#catching-a-bad-change-in-ci).

## Upgrade tests

Tests that built an old database by replaying part of your migration history have nothing to replay any more. Write the old table in the test as plain `CREATE TABLE` SQL, with only the tables that test touches. The sync creates everything else. That makes the starting point of each test easier to read than a migration number was.
