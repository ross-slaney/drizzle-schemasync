import { describeSchema, type SchemaModel, type SchemaSource } from "./model";
import { planChanges, type PlanOptions, type SchemaPlan } from "./plan";

export { describeResult, syncSchema, syncSchemaAsync, type SchemaSyncOptions, type SchemaSyncResult } from "./sync";
export { expoSqlite, expoSqliteAsync, type AsyncConnection, type AsyncTarget, type Connection, type DrizzleLike, type SyncTarget } from "./connection";
export { SchemaChangesBlockedError, UnsupportedSchemaError } from "./errors";
export { createStatements, describeSchema, type CheckModel, type ColumnModel, type ForeignKeyModel, type IndexModel, type SchemaModel, type SchemaSource, type TableModel } from "./model";
export { tableName, type DataLossKind, type DataLossPolicy, type DataLossRisk, type PlanOptions, type RenameHint, type RetainedObject, type SchemaPlan, type TableRef } from "./plan";

/**
 * What going from one schema to another would do, with no database: every table
 * is assumed to hold rows, the worst case. Run it in CI against the schema of
 * your last release, and a change that would be blocked on a device fails there.
 */
export function diffSchemas(from: SchemaSource | SchemaModel, to: SchemaSource | SchemaModel, options: PlanOptions = {}): SchemaPlan {
  return planChanges({ ...describeSchema(from), views: [], triggers: [] }, describeSchema(to), options);
}
