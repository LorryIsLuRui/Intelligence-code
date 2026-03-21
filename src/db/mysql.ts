import mysql, { type Pool } from "mysql2/promise";
import { env } from "../config/env.js";

let pool: Pool | null = null;

export function getMySqlPool(): Pool | null {
  if (!env.mysqlEnabled) {
    return null;
  }

  if (!pool) {
    pool = mysql.createPool({
      host: env.mysqlHost,
      port: env.mysqlPort,
      user: env.mysqlUser,
      password: env.mysqlPassword,
      database: env.mysqlDatabase,
      waitForConnections: true,
      connectionLimit: 10
    });
  }

  return pool;
}
