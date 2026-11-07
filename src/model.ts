import { is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable, SQLiteView } from "drizzle-orm/sqlite-core";

import { UnsupportedSchemaError } from "./errors";

/*
 * One description of a database, used for both sides of the comparison: what
 * the Drizzle schema asks for (describeSchema) and what the file holds
 * (inspect.ts). The planner never sees Drizzle or a connection.
 */

export interface ColumnModel {
  name: string;
  /** The declared type, as written. Compared without regard to case or spaces. */
  type: string;
  notNull: boolean;
  /** Position in the primary key, from 1. Zero when the column is not part of it. */
  primaryKey: number;
  /** The default as SQL text, or null when the column has none. */
  defaultSql: string | null;
  autoIncrement: boolean;
}

export interface IndexModel {
  name: string;
  unique: boolean;
  /** The statement that creates it. */
  sql: string;
}

export interface ForeignKeyModel {
  columns: string[];
  table: string;
  foreignColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface CheckModel {
  name: string;
  expression: string;
}

export interface TableModel {
  name: string;
  columns: ColumnModel[];
  indexes: IndexModel[];
  foreignKeys: ForeignKeyModel[];
  checks: CheckModel[];
}

export interface SchemaModel {
  tables: TableModel[];
}

/** What `import * as schema` gives you, or a plain object of tables. */
export type SchemaSource = Record<string, unknown>;

export function isSchemaModel(source: SchemaSource | SchemaModel): source is SchemaModel {
  return Array.isArray((source as SchemaModel).tables) && (source as SchemaModel).tables.every((table) => typeof table?.name === "string" && Array.isArray(table?.columns));
}

const dialect = new SQLiteSyncDialect();

/** SQL with its parameters written in place and columns named bare, the form an index or a check stores. */
function renderSql(value: SQL): string {
  return dialect.sqlToQuery(new SQL(value.queryChunks).inlineParams(), "indexes").sql;
}

export function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: unknown, where: string): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
  throw new UnsupportedSchemaError(`${where}: a default of type ${typeof value} cannot be written as SQL.`);
}

function defaultOf(column: ReturnType<typeof getTableConfig>["columns"][number], where: string): string | null {
  const value: unknown = column.default;
  if (value === undefined) return null;
  if (is(value, SQL)) {
    const text = renderSql(value);
    return /^\(.*\)$/s.test(text) || /^current_(time|date|timestamp)$/i.test(text) ? text : `(${text})`;
  }
  return literal(column.mapToDriverValue(value), where);
}

function action(value: string | undefined): string {
  return (value ?? "no action").toLowerCase();
}

function createIndexSql(name: string, table: string, unique: boolean, columns: string[], where?: string): string {
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(table)} (${columns.join(", ")})${where ? ` WHERE ${where}` : ""}`;
}

function describeTable(table: SQLiteTable): TableModel {
  const config = getTableConfig(table);
  const name = config.name;
  const compositeKey = config.primaryKeys[0]?.columns.map((column) => column.name) ?? [];
  if (config.primaryKeys.length > 1) throw new UnsupportedSchemaError(`${name}: a table has one primary key.`);

  const columns = config.columns.map<ColumnModel>((column) => {
    const where = `${name}.${column.name}`;
    if (column.generated) throw new UnsupportedSchemaError(`${where}: generated columns are not supported yet.`);
    const position = compositeKey.indexOf(column.name) + 1;
    return {
      name: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
      primaryKey: column.primary ? 1 : position,
      defaultSql: defaultOf(column, where),
      autoIncrement: Boolean((column as { autoIncrement?: boolean }).autoIncrement),
    };
  });

  const indexes: IndexModel[] = config.indexes.map((index) => {
    const { name: indexName, columns: indexColumns, unique, where } = index.config;
    const rendered = indexColumns.map((column) => (is(column, SQL) ? renderSql(column) : quote(column.name)));
    return { name: indexName, unique, sql: createIndexSql(indexName, name, unique, rendered, where ? renderSql(where) : undefined) };
  });
  const seen = new Set(indexes.map((index) => index.name));
  const addUnique = (uniqueName: string, uniqueColumns: string[]) => {
    if (seen.has(uniqueName)) return;
    seen.add(uniqueName);
    indexes.push({ name: uniqueName, unique: true, sql: createIndexSql(uniqueName, name, true, uniqueColumns.map(quote)) });
  };
  // Drizzle's own tooling makes every unique constraint a named unique index, so a database it built matches this.
  for (const column of config.columns) {
    if (column.isUnique) addUnique(column.uniqueName ?? `${name}_${column.name}_unique`, [column.name]);
  }
  for (const constraint of config.uniqueConstraints) addUnique(constraint.getName() ?? `${name}_${constraint.columns.map((column) => column.name).join("_")}_unique`, constraint.columns.map((column) => column.name));

  const foreignKeys = config.foreignKeys.map<ForeignKeyModel>((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      table: getTableConfig(reference.foreignTable).name,
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onUpdate: action(foreignKey.onUpdate),
      onDelete: action(foreignKey.onDelete),
    };
  });

  const checks = config.checks.map<CheckModel>((check) => ({ name: check.name, expression: renderSql(check.value) }));

  return { name, columns, indexes, foreignKeys, checks };
}

/** The tables a schema module asks for. Anything else it exports (types, relations, helpers) is not schema. */
export function describeSchema(schema: SchemaSource | SchemaModel): SchemaModel {
  if (isSchemaModel(schema)) return schema;
  const tables: TableModel[] = [];
  const names = new Set<string>();
  for (const [key, value] of Object.entries(schema)) {
    if (is(value, SQLiteView)) throw new UnsupportedSchemaError(`${key}: views are not supported yet. Create them in afterDeploy.`);
    if (!is(value, SQLiteTable)) continue;
    const table = describeTable(value);
    if (names.has(table.name)) throw new UnsupportedSchemaError(`${table.name}: two exports name the same table.`);
    names.add(table.name);
    tables.push(table);
  }
  return { tables };
}

/** A column's definition inside CREATE TABLE or ADD COLUMN. A lone primary key is written here, a shared one on the table. */
export function columnSql(column: ColumnModel, singleKey: boolean): string {
  const parts = [quote(column.name), column.type];
  if (singleKey && column.primaryKey > 0) parts.push(column.autoIncrement ? "PRIMARY KEY AUTOINCREMENT" : "PRIMARY KEY");
  if (column.defaultSql !== null) parts.push(`DEFAULT ${column.defaultSql}`);
  if (column.notNull) parts.push("NOT NULL");
  return parts.join(" ");
}

function foreignKeySql(foreignKey: ForeignKeyModel): string {
  const from = foreignKey.columns.map(quote).join(", ");
  const to = foreignKey.foreignColumns.map(quote).join(", ");
  return `FOREIGN KEY (${from}) REFERENCES ${quote(foreignKey.table)} (${to}) ON UPDATE ${foreignKey.onUpdate} ON DELETE ${foreignKey.onDelete}`;
}

/** CREATE TABLE for a table, under `as` when it is being built beside the one it replaces. */
export function createTableSql(table: TableModel, as: string = table.name): string {
  const key = table.columns.filter((column) => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey);
  const lines = table.columns.map((column) => columnSql(column, key.length === 1));
  if (key.length > 1) lines.push(`PRIMARY KEY (${key.map((column) => quote(column.name)).join(", ")})`);
  for (const foreignKey of table.foreignKeys) lines.push(foreignKeySql(foreignKey));
  for (const check of table.checks) lines.push(`CONSTRAINT ${quote(check.name)} CHECK (${check.expression})`);
  return `CREATE TABLE ${quote(as)} (\n  ${lines.join(",\n  ")}\n)`;
}

/** Every statement a fresh database needs, for seeding a test or reading what the schema makes. */
export function createStatements(schema: SchemaSource | SchemaModel): string[] {
  const statements: string[] = [];
  for (const table of describeSchema(schema).tables) {
    statements.push(createTableSql(table));
    for (const index of table.indexes) statements.push(index.sql);
  }
  return statements;
}

/** Raised when the planner changes what it would do with an unchanged schema, so databases compare once more. */
const PLANNER_VERSION = 1;

/**
 * FNV-1a over the model and whatever else decides the outcome: small enough for
 * `PRAGMA user_version`, never zero, stable across runs and platforms.
 */
export function fingerprint(model: SchemaModel, policy: unknown = null): number {
  const text = `${PLANNER_VERSION}:${JSON.stringify(policy)}:${JSON.stringify(model)}`;
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1 || 1;
}
