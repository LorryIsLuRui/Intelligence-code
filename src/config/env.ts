import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 解析命令行参数 --key=value 格式，注入到 process.env
for (const arg of process.argv) {
    const match = arg.match(/^--([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
        process.env[match[1]] = match[2];
    }
}

// MCP Server 本地 .env 路径（固定指向项目根目录）
const MCP_SERVER_ROOT = path.resolve(__dirname, '..', '..', './dist'); // MCP Server 根目录
const MCP_SERVER_ENV_PATH = path.resolve(MCP_SERVER_ROOT, '.env');
dotenv.config({
    path: MCP_SERVER_ENV_PATH,
    override: false, // 不覆盖已存在的变量
});

/**
 * 从指定项目根目录加载 .env 到 process.env
 * 行为：优先使用第三方显式设置的值，否则保留 MCP Server 本地配置
 */
export function loadProjectDotenv(projectRoot: string): void {
    const envPath = path.resolve(projectRoot, '.env');
    if (!existsSync(envPath)) {
        return;
    }

    const content = readFileSync(envPath, 'utf-8');

    // 第一步：收集第三方 .env 中所有显式定义的 key
    const thirdPartyKeys = new Set<string>();
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        if (!key) continue;
        thirdPartyKeys.add(key);
    }

    // 第二步：如果某个 key 是第三方显式定义的，则覆盖（不管值是什么）
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        value = value.replace(/^["']|["']$/g, '');
        if (!key) continue;

        // 只有当第三方显式定义了这个 key 时才覆盖
        if (thirdPartyKeys.has(key)) {
            process.env[key] = value;
        }
    }
}

// 外部传入的 env 已在上一步保留，这里确保环境变量已正确设置
for (const arg of process.argv) {
    const match = arg.match(/^--([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
        process.env[match[1]] = match[2];
    }
}

const requiredWhenEnabled = [
    'MYSQL_HOST',
    'MYSQL_USER',
    'MYSQL_DATABASE',
] as const;
console.error(
    `[Config] MYSQL_HOST: ${process.env.MYSQL_HOST},
    MYSQL_USER: ${process.env.MYSQL_USER},
    MYSQL_DATABASE: ${process.env.MYSQL_DATABASE},
    EMBEDDING_SERVICE_URL: ${process.env.EMBEDDING_SERVICE_URL},
    MYSQL_SYMBOLS_TABLE: ${process.env.MYSQL_SYMBOLS_TABLE}
    `
);
export const env = {
    mysqlHost: process.env.MYSQL_HOST ?? '127.0.0.1',
    mysqlPort: Number(process.env.MYSQL_PORT ?? '3306'),
    mysqlUser: process.env.MYSQL_USER ?? 'root',
    mysqlPassword: process.env.MYSQL_PASSWORD ?? '',
    mysqlDatabase: process.env.MYSQL_DATABASE ?? 'code_intelligence',
    /** symbols 表名，可通过 MYSQL_SYMBOLS_TABLE 环境变量配置 */
    mysqlSymbolsTable: process.env.MYSQL_SYMBOLS_TABLE ?? 'symbols',
    /** Phase 5：指向 Python FastAPI 嵌入服务根 URL，如 http://127.0.0.1:8765 */
    embeddingServiceUrl: (process.env.EMBEDDING_SERVICE_URL ?? '').trim(),
    /** Redis 连接 URL，供 BullMQ embedding worker 使用 */
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
};

export function validateEnv(): void {
    for (const key of requiredWhenEnabled) {
        if (!process.env[key]) {
            throw new Error(`Missing environment variable: ${key}`);
        }
    }
}
