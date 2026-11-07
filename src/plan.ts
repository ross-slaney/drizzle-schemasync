import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";

import { normalizeDefault, normalizeSql, type DatabaseSnapshot } from "./inspect";
import { columnSql, createTableSql, quote, type ColumnModel, type ForeignKeyModel, type IndexModel, type SchemaModel, type TableModel } from "./model";

/*
 * The comparison. Pure: a snapshot of the database, the schema, the policy and
 * which tables hold rows go in; statements and a report come out. Everything
 * that can go wrong for a person's data is decided here, so everything that can
 * go wrong is testable without a database.
 *
 * SQLite can add a column in place. Every other change to a table goes through
 * the rebuild SQLite documents: build the new table beside the old one, copy,
 * drop, rename. That one path works on every SQLite version and has none of
 * ALTER's special cases.
 */

export type TableRef = string | SQLiteTable;

/** Which tables may lose rows or values: none (the default), all, the ones named, or all but the ones named. */
export type DataLossPolicy = boolean | readonly TableRef[] | { readonly except: readonly TableRef[] };

export interface PlanOptions {
  /** See {@link DataLossPolicy}. A table that holds no rows has nothing to lose and never blocks. */
  allowDataLoss?: DataLossPolicy;
  /** Drop tables and indexes the schema does not mention. Off, they stay and are listed in `retained`. */
  allowObjectRemoval?: boolean;
  /** Tables this library never reads, changes or drops. */
  ignoreTables?: readonly string[];
  /** What things used to be called. Applied once: an old name that is gone, or a new name that exists, does nothing. */
  renames?: {
    /** `{ newName: "oldName" }` */
    tables?: Readonly<Record<string, string>>;
    /** `{ table: { newName: "oldName" } }`, by the table's new name. */
    columns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
}

export type DataLossKind =
  | "table-dropped"
  | "column-dropped"
  | "required-column-added"
  | "not-null-added"
  | "type-changed"
  | "primary-key-changed"
  | "unique-index-added"
  | "check-changed";

export interface DataLossRisk {
  kind: DataLossKind;
  table: string;
  column?: string;
  message: string;
}

export interface RetainedObject {
  type: "table" | "column" | "index";
  table: string;
  name: string;
}

export interface RenameHint {
  table: string;
  from: string;
  to: string;
  /** The exact option to add. */
  declare: string;
}

export interface SchemaPlan {
  /** What will run, in order, inside one transaction. Hooks add to this when it runs. */
  statements: string[];
  /** The same in words. */
  changes: string[];
  /** Losses the policy allows. These happen. */
  dataLossRisks: DataLossRisk[];
  /** Losses the policy does not allow. Any of these stops the whole deployment before it starts. */
  blocked: DataLossRisk[];
  /** Tables whose rows are gone afterwards: discarded, or dropped with the table. A replica refills these. */
  discardedRows: string[];
  /** Things kept because nothing allowed removing them. */
  retained: RetainedObject[];
  renameHints: RenameHint[];
}

export function tableName(table: TableRef): string {
  return is(table, SQLiteTable) ? getTableConfig(table).name : (table as string);
}

function lossPolicy(policy: DataLossPolicy | undefined): (table: string) => boolean {
  if (policy === undefined || policy === false) return () => false;
  if (policy === true) return () => true;
  if ("except" in policy) {
    const kept = new Set(policy.except.map(tableName));
    return (table) => !kept.has(table);
  }
  const allowed = new Set(policy.map(tableName));
  return (table) => allowed.has(table);
}

/** The policy as plain data, so that loosening or tightening it counts as a change worth comparing for. */
export function describePolicy(options: PlanOptions): unknown {
  const loss = options.allowDataLoss ?? false;
  const names = (tables: readonly TableRef[]) => tables.map(tableName).sort();
  return {
    loss: typeof loss === "boolean" ? loss : "except" in loss ? { except: names(loss.except) } : names(loss),
    removal: options.allowObjectRemoval ?? false,
    ignored: [...(options.ignoreTables ?? [])].sort(),
    renames: options.renames ?? null,
  };
}

function sameType(a: string, b: string): boolean {
  return normalizeSql(a) === normalizeSql(b);
}

function foreignKeyKey(foreignKey: ForeignKeyModel): string {
  return JSON.stringify([foreignKey.columns, foreignKey.table, foreignKey.foreignColumns, foreignKey.onUpdate, foreignKey.onDelete]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

/** `ADD COLUMN` takes a plain value as a default, and a NOT NULL column has to have one. */
function canAddInPlace(column: ColumnModel): boolean {
  if (column.primaryKey > 0) return false;
  const value = normalizeDefault(column.defaultSql);
  if (value === null) return !column.notNull;
  return /^(-?[\d.]+(e-?\d+)?|'.*'|x'[0-9a-f]*')$/is.test(value);
}

const keyOf = (table: TableModel) =>
  table.columns
    .filter((column) => column.primaryKey > 0)
    .sort((a, b) => a.primaryKey - b.primaryKey)
    .map((column) => column.name)
    .join(",");

const mentions = (index: IndexModel, column: string) => new RegExp(`(^|[^a-z0-9_])${column.toLowerCase().replace(/[^a-z0-9_]/g, "\\$&")}([^a-z0-9_]|$)`).test(normalizeSql(index.sql));

export function planChanges(actual: DatabaseSnapshot, desired: SchemaModel, options: PlanOptions = {}, hasRows: (table: string) => boolean = () => true): SchemaPlan {
  const lossAllowed = lossPolicy(options.allowDataLoss);
  const ignored = new Set(options.ignoreTables ?? []);
  const removal = options.allowObjectRemoval ?? false;
  const plan: SchemaPlan = { statements: [], changes: [], dataLossRisks: [], blocked: [], discardedRows: [], retained: [], renameHints: [] };
  const wanted = new Map(desired.tables.map((table) => [table.name, table]));

  const risk = (allowed: boolean, kind: DataLossKind, table: string, message: string, column?: string) => {
    (allowed ? plan.dataLossRisks : plan.blocked).push({ kind, table, ...(column ? { column } : {}), message });
  };

  // The database as the renames leave it, and what each table was called when its rows were counted.
  const current = new Map<string, TableModel>(actual.tables.filter((table) => !ignored.has(table.name)).map((table) => [table.name, table]));
  const originally = new Map<string, string>();
  const rowsIn = (name: string) => hasRows(originally.get(name) ?? name);
  const renameStatements: string[] = [];

  for (const [to, from] of Object.entries(options.renames?.tables ?? {})) {
    const table = current.get(from);
    if (!table || current.has(to) || !wanted.has(to)) continue;
    renameStatements.push(`ALTER TABLE ${quote(from)} RENAME TO ${quote(to)}`);
    plan.changes.push(`Rename table ${from} to ${to}`);
    current.delete(from);
    current.set(to, { ...table, name: to });
    originally.set(to, originally.get(from) ?? from);
  }
  for (const [name, columns] of Object.entries(options.renames?.columns ?? {})) {
    const table = current.get(name);
    const target = wanted.get(name);
    if (!table || !target) continue;
    for (const [to, from] of Object.entries(columns)) {
      const column = table.columns.find((candidate) => candidate.name === from);
      if (!column || table.columns.some((candidate) => candidate.name === to) || !target.columns.some((candidate) => candidate.name === to)) continue;
      renameStatements.push(`ALTER TABLE ${quote(name)} RENAME COLUMN ${quote(from)} TO ${quote(to)}`);
      plan.changes.push(`Rename column ${name}.${from} to ${to}`);
      current.set(name, { ...current.get(name)!, columns: current.get(name)!.columns.map((candidate) => (candidate.name === from ? { ...candidate, name: to } : candidate)) });
    }
  }

  const body: string[] = [];
  const rebuilt: string[] = [];
  const created = desired.tables.filter((table) => !current.has(table.name));
  const leftOver = [...current.values()].filter((table) => !wanted.has(table.name));

  for (const table of leftOver) {
    const similar = created.find((candidate) => sameSet(candidate.columns.map((c) => c.name), table.columns.map((c) => c.name)));
    if (similar) plan.renameHints.push({ table: similar.name, from: table.name, to: similar.name, declare: `renames.tables["${similar.name}"] = "${table.name}"` });
    if (!removal) {
      plan.retained.push({ type: "table", table: table.name, name: table.name });
      continue;
    }
    const rows = rowsIn(table.name);
    if (rows) risk(lossAllowed(table.name), "table-dropped", table.name, `Table ${table.name} has rows and is no longer in the schema.`);
    if (rows && !lossAllowed(table.name)) continue;
    body.push(`DROP TABLE ${quote(table.name)}`);
    plan.changes.push(`Drop table ${table.name}`);
    if (rows) plan.discardedRows.push(table.name);
  }

  for (const target of desired.tables) {
    const existing = current.get(target.name);
    if (existing) planTable(existing, target);
  }

  for (const table of created) {
    body.push(createTableSql(table));
    plan.changes.push(`Create table ${table.name}`);
    for (const index of table.indexes) {
      body.push(index.sql);
      plan.changes.push(`Create index ${index.name} on ${table.name}`);
    }
  }

  function planTable(existing: TableModel, target: TableModel) {
    const name = target.name;
    const rows = rowsIn(name);
    const allowed = lossAllowed(name);
    const before = new Map(existing.columns.map((column) => [column.name, column]));
    const after = new Map(target.columns.map((column) => [column.name, column]));
    const added = target.columns.filter((column) => !before.has(column.name));
    const removed = existing.columns.filter((column) => !after.has(column.name));

    const rowLoss: { kind: DataLossKind; column?: string; message: string }[] = [];
    let changed = false;
    const tightened = new Set<string>();
    for (const column of target.columns) {
      const was = before.get(column.name);
      if (!was) continue;
      const defaultsDiffer = normalizeDefault(was.defaultSql) !== normalizeDefault(column.defaultSql);
      if (!sameType(was.type, column.type)) {
        rowLoss.push({ kind: "type-changed", column: column.name, message: `${name}.${column.name} changes type from ${was.type} to ${column.type}.` });
      }
      if (!sameType(was.type, column.type) || was.notNull !== column.notNull || defaultsDiffer || was.autoIncrement !== column.autoIncrement) changed = true;
      if (!was.notNull && column.notNull) {
        if (normalizeDefault(column.defaultSql) === null) rowLoss.push({ kind: "not-null-added", column: column.name, message: `${name}.${column.name} becomes required with no default.` });
        else tightened.add(column.name);
      }
    }
    for (const column of added) {
      if (column.notNull && normalizeDefault(column.defaultSql) === null) {
        rowLoss.push({ kind: "required-column-added", column: column.name, message: `${name}.${column.name} is new and required with no default.` });
      }
    }
    const keyChanged = keyOf(existing) !== keyOf(target);
    if (keyChanged) rowLoss.push({ kind: "primary-key-changed", message: `${name} changes primary key from (${keyOf(existing)}) to (${keyOf(target)}).` });

    const checksBefore = existing.checks.map((check) => `${check.name}:${normalizeSql(check.expression)}`);
    const checksAfter = target.checks.map((check) => `${check.name}:${normalizeSql(check.expression)}`);
    const checksChanged = !sameSet(checksBefore, checksAfter);
    if (checksAfter.some((check) => !checksBefore.includes(check))) rowLoss.push({ kind: "check-changed", message: `${name} has a new CHECK that existing rows may fail.` });

    const foreignKeysChanged = !sameSet(existing.foreignKeys.map(foreignKeyKey), target.foreignKeys.map(foreignKeyKey));

    const indexBefore = new Map(existing.indexes.map((index) => [index.name, index]));
    const isNewIndex = (index: IndexModel) => normalizeSql(indexBefore.get(index.name)?.sql ?? "") !== normalizeSql(index.sql);
    for (const index of target.indexes) {
      if (index.unique && isNewIndex(index)) rowLoss.push({ kind: "unique-index-added", message: `${name} has a new unique index ${index.name} that existing rows may break.` });
    }

    for (const column of removed) {
      const similar = added.find((candidate) => sameType(candidate.type, column.type));
      if (similar) plan.renameHints.push({ table: name, from: column.name, to: similar.name, declare: `renames.columns["${name}"]["${similar.name}"] = "${column.name}"` });
    }

    let keepRows = true;
    if (rows && rowLoss.length > 0) {
      for (const loss of rowLoss) risk(allowed, loss.kind, name, loss.message, loss.column);
      if (!allowed) return;
      keepRows = false;
      plan.discardedRows.push(name);
    }

    // A protected table never loses a column. One that cannot get in the way of an insert stays, unread.
    const retainedColumns: ColumnModel[] = [];
    let dropped = removed;
    if (rows && keepRows && !allowed && removed.length > 0) {
      dropped = [];
      let stuck = false;
      for (const column of removed) {
        if (column.notNull && normalizeDefault(column.defaultSql) === null) {
          risk(false, "column-dropped", name, `${name}.${column.name} is no longer in the schema, is required and has no default, so it cannot stay and cannot be dropped.`, column.name);
          stuck = true;
        } else {
          retainedColumns.push(column);
          plan.retained.push({ type: "column", table: name, name: column.name });
        }
      }
      if (stuck) return;
    } else if (rows && keepRows) {
      for (const column of removed) risk(true, "column-dropped", name, `${name}.${column.name} is no longer in the schema; its values go.`, column.name);
    }

    const needsRebuild = !keepRows || changed || dropped.length > 0 || keyChanged || checksChanged || foreignKeysChanged || added.some((column) => !canAddInPlace(column));

    const extraIndexes = existing.indexes.filter((index) => !target.indexes.some((candidate) => candidate.name === index.name));

    if (!needsRebuild) {
      for (const index of extraIndexes) {
        if (removal) {
          body.push(`DROP INDEX ${quote(index.name)}`);
          plan.changes.push(`Drop index ${index.name}`);
        } else {
          plan.retained.push({ type: "index", table: name, name: index.name });
        }
      }
      for (const column of added) {
        body.push(`ALTER TABLE ${quote(name)} ADD COLUMN ${columnSql(column, false)}`);
        plan.changes.push(`Add column ${name}.${column.name}`);
      }
      for (const index of target.indexes) {
        if (!isNewIndex(index)) continue;
        if (indexBefore.has(index.name)) body.push(`DROP INDEX ${quote(index.name)}`);
        body.push(index.sql);
        plan.changes.push(`${indexBefore.has(index.name) ? "Change" : "Create"} index ${index.name} on ${name}`);
      }
      return;
    }

    rebuilt.push(name);
    const temporary = `__schemasync_new_${name}`;
    const shape: TableModel = { ...target, columns: [...target.columns, ...retainedColumns] };
    body.push(createTableSql(shape, temporary));
    const copied = shape.columns.filter((column) => before.has(column.name));
    if (keepRows && copied.length > 0) {
      const names = copied.map((column) => quote(column.name)).join(", ");
      const values = copied.map((column) => (tightened.has(column.name) ? `COALESCE(${quote(column.name)}, ${column.defaultSql})` : quote(column.name))).join(", ");
      body.push(`INSERT INTO ${quote(temporary)} (${names}) SELECT ${values} FROM ${quote(name)}`);
      // AUTOINCREMENT promises a key is never reused, which needs the high-water mark and not just the highest key left.
      if (existing.columns.some((column) => column.autoIncrement) && target.columns.some((column) => column.autoIncrement)) {
        const table = (value: string) => value.replace(/'/g, "''");
        body.push(`DELETE FROM sqlite_sequence WHERE name = '${table(temporary)}'`);
        body.push(`INSERT INTO sqlite_sequence (name, seq) SELECT '${table(temporary)}', seq FROM sqlite_sequence WHERE name = '${table(name)}'`);
      }
    }
    body.push(`DROP TABLE ${quote(name)}`);
    body.push(`ALTER TABLE ${quote(temporary)} RENAME TO ${quote(name)}`);
    plan.changes.push(keepRows ? `Rebuild table ${name}, keeping its rows` : `Rebuild table ${name}, discarding its rows`);
    for (const column of added) plan.changes.push(`Add column ${name}.${column.name}`);
    for (const column of dropped) plan.changes.push(`Drop column ${name}.${column.name}`);

    for (const index of target.indexes) body.push(index.sql);
    for (const index of extraIndexes) {
      if (removal) {
        plan.changes.push(`Drop index ${index.name}`);
      } else if (dropped.some((column) => mentions(index, column.name))) {
        plan.changes.push(`Drop index ${index.name}, whose column is gone`);
      } else {
        body.push(index.sql);
        plan.retained.push({ type: "index", table: name, name: index.name });
      }
    }
  }

  // A rebuild renames a table into place, and SQLite refuses that while a view or a trigger names something missing. They step aside and come back.
  const stepAside: string[] = [];
  const comeBack: string[] = [];
  if (rebuilt.length > 0) {
    for (const trigger of actual.triggers) {
      if (ignored.has(trigger.table)) continue;
      stepAside.push(`DROP TRIGGER ${quote(trigger.name)}`);
      if (wanted.has(trigger.table) || (!removal && current.has(trigger.table))) comeBack.push(trigger.sql);
    }
    for (const view of actual.views) {
      stepAside.push(`DROP VIEW ${quote(view.name)}`);
      comeBack.push(view.sql);
    }
  }

  plan.statements = [...stepAside, ...renameStatements, ...body, ...comeBack];
  return plan;
}

/** Whether the plan drops a table, a rebuild's included: with foreign keys on, that would delete the rows that reference it. */
export function plansTableDrop(plan: SchemaPlan): boolean {
  return plan.statements.some((statement) => statement.startsWith("DROP TABLE "));
}
