import dotenv from "dotenv";

dotenv.config();

const requiredWhenEnabled = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_DATABASE"] as const;

export const env = {
  mysqlEnabled: process.env.MYSQL_ENABLED === "true",
  mysqlHost: process.env.MYSQL_HOST ?? "127.0.0.1",
  mysqlPort: Number(process.env.MYSQL_PORT ?? "3306"),
  mysqlUser: process.env.MYSQL_USER ?? "root",
  mysqlPassword: process.env.MYSQL_PASSWORD ?? "",
  mysqlDatabase: process.env.MYSQL_DATABASE ?? "code_intelligence",
  /** symbols 表名，可通过 MYSQL_SYMBOLS_TABLE 环境变量配置 */
  mysqlSymbolsTable: process.env.MYSQL_SYMBOLS_TABLE ?? "symbols",
  /** Phase 5：指向 Python FastAPI 嵌入服务根 URL，如 http://127.0.0.1:8765 */
  embeddingServiceUrl: (process.env.EMBEDDING_SERVICE_URL ?? "").trim()
};

export function validateEnv(): void {
  if (!env.mysqlEnabled) {
    return;
  }

  for (const key of requiredWhenEnabled) {
    if (!process.env[key]) {
      throw new Error(`Missing environment variable: ${key}`);
    }
  }
}
