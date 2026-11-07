import type { ColumnModel, ForeignKeyModel, SchemaModel, TableModel } from "./model";

/** The database as it is: the same description as the schema, plus what a table rebuild has to put back. */
export interface DatabaseSnapshot extends SchemaModel {
  views: { name: string; sql: string }[];
  triggers: { name: string; table: string; sql: string }[];
}

export type MasterRow = { type: string; name: string; tableName: string; sql: string | null };
export type ColumnRow = { tableName: string; name: string; type: string; required: number; dflt: string | null; pk: number; hidden: number };
export type ForeignKeyRow = { tableName: string; id: number; seq: number; target: string; fromColumn: string; toColumn: string | null; onUpdate: string; onDelete: string };

const USER_OBJECTS = `m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;

export const MASTER_QUERY = `SELECT m.type AS type, m.name AS name, m.tbl_name AS tableName, m.sql AS sql FROM sqlite_master m WHERE ${USER_OBJECTS}`;
export const COLUMNS_QUERY = `SELECT m.name AS tableName, c.name AS name, c.type AS type, c."notnull" AS required, c.dflt_value AS dflt, c.pk AS pk, c.hidden AS hidden FROM sqlite_master m JOIN pragma_table_xinfo(m.name) c WHERE m.type = 'table' AND ${USER_OBJECTS} ORDER BY m.name, c.cid`;
export const FOREIGN_KEYS_QUERY = `SELECT m.name AS tableName, f.id AS id, f.seq AS seq, f."table" AS target, f."from" AS fromColumn, f."to" AS toColumn, f.on_update AS onUpdate, f.on_delete AS onDelete FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND ${USER_OBJECTS} ORDER BY m.name, f.id, f.seq`;

/**
 * SQL reduced to what it means for comparison: no quoting, no spaces, one case,
 * string literals untouched. Drizzle's tooling, SQLite and this library all
 * quote differently, and none of that is a change.
 */
export function normalizeSql(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === "'") {
      let end = at + 1;
      while (end < text.length) {
        if (text.charAt(end) === "'") {
          if (text.charAt(end + 1) !== "'") break;
          end += 1;
        }
        end += 1;
      }
      out += text.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    if (!/[\s"`[\];]/.test(char)) out += char.toLowerCase();
    at += 1;
  }
  return out.replace(/^createindexifnotexists/, "createindex").replace(/^createuniqueindexifnotexists/, "createuniqueindex");
}

/** A default as a value: SQLite keeps `false` as written and strips a default's outer parentheses, so `(1)`, `1` and `true` agree. */
export function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  let text = value.trim();
  while (/^\(.*\)$/s.test(text) && balanced(text.slice(1, -1))) text = text.slice(1, -1).trim();
  const lowered = text.toLowerCase();
  if (lowered === "null") return null;
  if (lowered === "true") return "1";
  if (lowered === "false") return "0";
  return normalizeSql(text);
}

function balanced(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (const char of text) {
    if (char === "'") inString = !inString;
    else if (!inString && char === "(") depth += 1;
    else if (!inString && char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** The named CHECK constraints out of a CREATE TABLE. SQLite has no pragma for them. */
export function readChecks(createTable: string): { name: string; expression: string }[] {
  const checks: { name: string; expression: string }[] = [];
  const start = /CONSTRAINT\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+CHECK\s*\(/gi;
  for (let match = start.exec(createTable); match; match = start.exec(createTable)) {
    let depth = 1;
    let inString = false;
    let at = start.lastIndex;
    for (; at < createTable.length && depth > 0; at += 1) {
      const char = createTable.charAt(at);
      if (char === "'") inString = !inString;
      else if (!inString && char === "(") depth += 1;
      else if (!inString && char === ")") depth -= 1;
    }
    const name = (match[1] as string).replace(/^["`[]|["`\]]$/g, "");
    checks.push({ name, expression: createTable.slice(start.lastIndex, at - 1) });
    start.lastIndex = at;
  }
  return checks;
}

export function buildSnapshot(master: readonly MasterRow[], columnRows: readonly ColumnRow[], foreignKeyRows: readonly ForeignKeyRow[]): DatabaseSnapshot {
  const tables: TableModel[] = [];
  const isVirtual = (row: MasterRow) => row.type === "table" && /^\s*CREATE\s+VIRTUAL\b/i.test(row.sql ?? "");
  // A virtual table keeps its data in ordinary tables named after it (search_data, search_idx). They are its, not ours.
  const shadowPrefixes = master.filter(isVirtual).map((row) => `${row.name}_`);
  for (const row of master) {
    if (row.type !== "table" || isVirtual(row) || shadowPrefixes.some((prefix) => row.name.startsWith(prefix))) continue;
    const createSql = row.sql ?? "";
    const own = columnRows.filter((column) => column.tableName === row.name && Number(column.hidden) === 0);
    const autoIncrement = /\bAUTOINCREMENT\b/i.test(createSql);
    const columns = own.map<ColumnModel>((column) => ({
      name: column.name,
      type: column.type,
      notNull: Number(column.required) === 1,
      primaryKey: Number(column.pk),
      defaultSql: column.dflt,
      autoIncrement: autoIncrement && Number(column.pk) > 0,
    }));
    tables.push({
      name: row.name,
      columns,
      indexes: master
        .filter((index) => index.type === "index" && index.tableName === row.name && index.sql)
        .map((index) => ({ name: index.name, unique: /^\s*CREATE\s+UNIQUE\b/i.test(index.sql as string), sql: index.sql as string })),
      foreignKeys: readForeignKeys(foreignKeyRows.filter((foreignKey) => foreignKey.tableName === row.name)),
      checks: readChecks(createSql),
    });
  }
  return {
    tables,
    views: master.filter((row) => row.type === "view" && row.sql).map((row) => ({ name: row.name, sql: row.sql as string })),
    triggers: master.filter((row) => row.type === "trigger" && row.sql).map((row) => ({ name: row.name, table: row.tableName, sql: row.sql as string })),
  };
}

function readForeignKeys(rows: readonly ForeignKeyRow[]): ForeignKeyModel[] {
  const byId = new Map<number, ForeignKeyModel>();
  for (const row of rows) {
    const foreignKey = byId.get(row.id) ?? { columns: [], table: row.target, foreignColumns: [], onUpdate: row.onUpdate.toLowerCase(), onDelete: row.onDelete.toLowerCase() };
    foreignKey.columns.push(row.fromColumn);
    foreignKey.foreignColumns.push(row.toColumn ?? "");
    byId.set(row.id, foreignKey);
  }
  return [...byId.values()];
}

/** How to ask which tables hold rows, in compound selects SQLite's limit of 500 terms will take. */
export function rowProbes(tables: readonly string[]): string[] {
  const probes: string[] = [];
  for (let at = 0; at < tables.length; at += 200) {
    const terms = tables.slice(at, at + 200).map((name) => `SELECT '${name.replace(/'/g, "''")}' AS name, EXISTS (SELECT 1 FROM "${name.replace(/"/g, '""')}") AS hasRows`);
    probes.push(terms.join(" UNION ALL "));
  }
  return probes;
}
