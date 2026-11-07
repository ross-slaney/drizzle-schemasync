import type { DataLossRisk, RenameHint } from "./plan";

/** The schema asks for something this library cannot compare or build. Nothing has run. */
export class UnsupportedSchemaError extends Error {
  override name = "UnsupportedSchemaError";
}

/**
 * The change would lose rows or values a table was not allowed to lose. Nothing
 * has run. Declare a rename, make the change additive, or allow the loss.
 */
export class SchemaChangesBlockedError extends Error {
  override name = "SchemaChangesBlockedError";
  readonly blocked: readonly DataLossRisk[];
  readonly renameHints: readonly RenameHint[];

  constructor(blocked: readonly DataLossRisk[], renameHints: readonly RenameHint[]) {
    const lines = blocked.map((risk) => `  ${risk.message}`);
    const hints = renameHints.map((hint) => `  If it was renamed, declare ${hint.declare}.`);
    super(["Schema changes would lose data and were not applied:", ...lines, ...hints].join("\n"));
    this.blocked = blocked;
    this.renameHints = renameHints;
  }
}
