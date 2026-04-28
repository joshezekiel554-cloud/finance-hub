import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { env } from "~/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __financeHubMysqlPool: mysql.Pool | undefined;
}

function createPool(): mysql.Pool {
  return mysql.createPool({
    uri: env.DATABASE_URL,
    connectionLimit: 10,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
}

export const pool: mysql.Pool = globalThis.__financeHubMysqlPool ?? createPool();

if (env.NODE_ENV !== "production") {
  globalThis.__financeHubMysqlPool = pool;
}

export const db = drizzle(pool, { schema, mode: "default" });

export type DB = typeof db;
