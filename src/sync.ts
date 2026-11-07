import { toConnection, type AsyncConnection, type AsyncTarget, type Connection, type SyncTarget } from "./connection";
import { SchemaChangesBlockedError } from "./errors";
import { buildSnapshot, COLUMNS_QUERY, FOREIGN_KEYS_QUERY, MASTER_QUERY, rowProbes, type ColumnRow, type DatabaseSnapshot, type ForeignKeyRow, type MasterRow } from "./inspect";
import { describeSchema, fingerprint, type SchemaModel, type SchemaSource } from "./model";
import { describePolicy, planChanges, plansTableDrop, type PlanOptions, type SchemaPlan } from "./plan";

export interface SchemaSyncOptions extends PlanOptions {
  /** Compare and report. Nothing changes, and nothing is blocked: the risks are in the plan. */
  dryRun?: boolean;
  /**
   * Skip the comparison when this schema is the last one applied, recorded in
   * `PRAGMA user_version`. Turn it off if something else owns that number.
   * @default true
   */
  skipComparisonWhenUnchanged?: boolean;
  /** Statements to run first, in the same transaction, when there is something to do. Fix data before a change here. */
  beforeDeploy?: (plan: SchemaPlan) => readonly string[];
  /** Statements to run last, in the same transaction, when there is something to do. Forget what `plan.discardedRows` made stale here. */
  afterDeploy?: (plan: SchemaPlan) => readonly string[];
}

export interface SchemaSyncResult {
  /** `unchanged`: the database already matched. `applied`: it does now. `previewed`: a dry run. */
  status: "unchanged" | "applied" | "previewed";
  plan: SchemaPlan;
  /** True when the fingerprint matched and the database was not read at all. */
  skippedComparison: boolean;
}

type Step = { exec: string } | { all: string };

const EMPTY_PLAN: SchemaPlan = { statements: [], changes: [], dataLossRisks: [], blocked: [], discardedRows: [], retained: [], renameHints: [] };

function* query<T>(text: string): Generator<Step, T[], T[]> {
  return yield { all: text };
}

function* run(text: string): Generator<Step, void, unknown> {
  yield { exec: text };
}

/*
 * The whole deployment as a sequence of database calls. The synchronous and
 * asynchronous entry points only differ in how they answer each step, so a
 * phone and a browser run one piece of logic, statement for statement.
 */
function* deploy(schema: SchemaSource | SchemaModel, options: SchemaSyncOptions): Generator<Step, SchemaSyncResult, any> {
  const desired = describeSchema(schema);
  const track = options.skipComparisonWhenUnchanged !== false;
  const mark = fingerprint(desired, describePolicy(options));

  if (track && !options.dryRun) {
    const [row] = yield* query<{ user_version: number }>("PRAGMA user_version");
    if (Number(row?.user_version) === mark) return { status: "unchanged", plan: EMPTY_PLAN, skippedComparison: true };
  }

  const actual: DatabaseSnapshot = buildSnapshot(
    yield* query<MasterRow>(MASTER_QUERY),
    yield* query<ColumnRow>(COLUMNS_QUERY),
    yield* query<ForeignKeyRow>(FOREIGN_KEYS_QUERY),
  );

  const holdingRows = new Set<string>();
  const ignored = new Set(options.ignoreTables ?? []);
  for (const probe of rowProbes(actual.tables.map((table) => table.name).filter((name) => !ignored.has(name)))) {
    for (const row of yield* query<{ name: string; hasRows: number }>(probe)) {
      if (Number(row.hasRows) === 1) holdingRows.add(row.name);
    }
  }

  const plan = planChanges(actual, desired, options, (table) => holdingRows.has(table));

  if (options.dryRun) return { status: "previewed", plan, skippedComparison: false };
  if (plan.blocked.length > 0) throw new SchemaChangesBlockedError(plan.blocked, plan.renameHints);

  if (plan.statements.length === 0) {
    if (track) yield* run(`PRAGMA user_version = ${mark}`);
    return { status: "unchanged", plan, skippedComparison: false };
  }

  const [foreignKeys] = yield* query<{ foreign_keys: number }>("PRAGMA foreign_keys");
  // SQLite ignores this inside a transaction, and a DROP TABLE would otherwise delete the rows that reference the table.
  const suspend = plansTableDrop(plan) && Number(foreignKeys?.foreign_keys) === 1;
  if (suspend) yield* run("PRAGMA foreign_keys = OFF");
  let failed = false;
  try {
    yield* run("BEGIN");
    try {
      for (const statement of options.beforeDeploy?.(plan) ?? []) yield* run(statement);
      for (const statement of plan.statements) yield* run(statement);
      for (const statement of options.afterDeploy?.(plan) ?? []) yield* run(statement);
      if (suspend) {
        const broken = yield* query<{ table: string; parent: string }>("PRAGMA foreign_key_check");
        if (broken.length > 0) {
          const first = broken[0] as { table: string; parent: string };
          throw new Error(`The schema change left ${broken.length} row(s) with a missing parent, the first in ${first.table} pointing at ${first.parent}.`);
        }
      }
      if (track) yield* run(`PRAGMA user_version = ${mark}`);
      yield* run("COMMIT");
    } catch (error) {
      failed = true;
      // SQLite may already have ended the transaction on its own. The statement's error is the one that says why.
      try {
        yield* run("ROLLBACK");
      } catch {
        // Reported: the original error.
      }
      throw error;
    }
  } finally {
    if (suspend) {
      try {
        yield* run("PRAGMA foreign_keys = ON");
      } catch (error) {
        // A connection too broken for this has already said why. Otherwise this is the failure to report.
        if (!failed) throw error;
      }
    }
  }
  return { status: "applied", plan, skippedComparison: false };
}

function perform(step: Step, connection: Connection | AsyncConnection): unknown {
  return "exec" in step ? connection.exec(step.exec) : connection.all(step.all);
}

/**
 * Make the database match the schema, now, on this thread. For a driver with
 * synchronous calls: expo-sqlite on a phone, better-sqlite3, node:sqlite, sql.js.
 * Throws {@link SchemaChangesBlockedError} before changing anything when a change
 * would lose data the policy protects; any other failure rolls everything back.
 */
export function syncSchema(target: SyncTarget, schema: SchemaSource | SchemaModel, options: SchemaSyncOptions = {}): SchemaSyncResult {
  const connection = toConnection(target);
  const steps = deploy(schema, options);
  let next = steps.next();
  while (!next.done) {
    let answer: unknown;
    try {
      answer = perform(next.value, connection);
      if (answer !== null && typeof (answer as PromiseLike<unknown>)?.then === "function") {
        throw new TypeError("This connection is asynchronous. Use syncSchemaAsync.");
      }
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(answer);
  }
  return next.value;
}

/** {@link syncSchema} for a driver whose calls return promises: expo-sqlite on the web, libSQL, D1. */
export async function syncSchemaAsync(target: AsyncTarget, schema: SchemaSource | SchemaModel, options: SchemaSyncOptions = {}): Promise<SchemaSyncResult> {
  const connection = toConnection(target);
  const steps = deploy(schema, options);
  let next = steps.next();
  while (!next.done) {
    let answer: unknown;
    try {
      answer = await perform(next.value, connection);
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(answer);
  }
  return next.value;
}

/** What a result did, in words, for a log line. */
export function describeResult(result: SchemaSyncResult): string {
  const { plan, status } = result;
  const lines =
    plan.changes.length === 0
      ? ["Schema unchanged."]
      : [`${status === "applied" ? "Applied" : "Would apply"} ${plan.changes.length} change(s).`, ...plan.changes.map((change) => `  ${change}`)];
  for (const risk of plan.dataLossRisks) lines.push(`  Data loss: ${risk.message}`);
  for (const risk of plan.blocked) lines.push(`  Blocked: ${risk.message}`);
  for (const object of plan.retained) lines.push(`  Retained ${object.type}: ${object.type === "column" ? `${object.table}.` : ""}${object.name}`);
  return lines.join("\n");
}
