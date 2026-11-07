import { sql } from "drizzle-orm";

/** The two things this library asks of a SQLite connection. */
export interface Connection {
  exec(statement: string): unknown;
  all<T>(query: string): T[];
}

export interface AsyncConnection {
  exec(statement: string): unknown;
  all<T>(query: string): T[] | Promise<T[]>;
}

/** A Drizzle database on any SQLite driver: `run` and `all` taking a query. */
export interface DrizzleLike {
  run(query: ReturnType<typeof sql.raw>): unknown;
  all(query: ReturnType<typeof sql.raw>): unknown;
}

export type SyncTarget = Connection | DrizzleLike;
export type AsyncTarget = AsyncConnection | DrizzleLike;

function isConnection(target: object): target is Connection {
  return typeof (target as Connection).exec === "function" && typeof (target as Connection).all === "function";
}

export function toConnection(target: SyncTarget | AsyncTarget): AsyncConnection {
  if (isConnection(target)) return target;
  const database = target as DrizzleLike;
  if (typeof database.run !== "function" || typeof database.all !== "function") {
    throw new TypeError("syncSchema needs a Drizzle SQLite database or an object with exec(statement) and all(query).");
  }
  return {
    exec: (statement) => database.run(sql.raw(statement)),
    all: <T>(query: string) => database.all(sql.raw(query)) as T[] | Promise<T[]>,
  };
}

/** expo-sqlite's `SQLiteDatabase`, on the phone's synchronous calls. */
export function expoSqlite(database: { execSync(source: string): void; getAllSync<T>(source: string): T[] }): Connection {
  return {
    exec: (statement) => database.execSync(statement),
    all: <T>(query: string) => database.getAllSync<T>(query),
  };
}

/** expo-sqlite's `SQLiteDatabase`, on its asynchronous calls: the way in on the web, where a long synchronous call times out. */
export function expoSqliteAsync(database: { execAsync(source: string): Promise<void>; getAllAsync<T>(source: string): Promise<T[]> }): AsyncConnection {
  return {
    exec: (statement) => database.execAsync(statement),
    all: <T>(query: string) => database.getAllAsync<T>(query),
  };
}
