import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Priority 1 (highest): Third-party CLI args --KEY=VALUE ───────────────────
// 记录哪些 key 来自命令行，任何后续加载都不得覆盖
export const CLI_KEYS = new Set<string>();
for (const arg of process.argv) {
    const match = arg.match(/^--([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
        process.env[match[1]] = match[2];
        CLI_KEYS.add(match[1]);
    }
}

// ─── Priority 3 (lowest): Local MCP repo .env ─────────────────────────────────
// override: false → 只填补尚未设置的 key，不覆盖 CLI 参数
// dev 模式: __dirname = src/config → ../../ = 项目根目录
// prod 模式: __dirname = dist/config → ../../ = 项目根目录
const MCP_SERVER_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (existsSync(MCP_SERVER_ENV_PATH)) {
    dotenv.config({ path: MCP_SERVER_ENV_PATH, override: false });
}

/**
 * 加载第三方项目的 .env 文件（Priority 2）。
 *
 * 优先级规则：
 *   第三方 CLI 参数（P1） > 第三方 .env（P2） > 本地 MCP .env（P3）
 *
 * - CLI 参数在 CLI_KEYS 中已记录，永不覆盖
 * - 第三方 .env 中的 key 覆盖本地 MCP .env（即 P2 > P3）
 *
 * 应在进程启动后、任何 env.xxx 读取前尽早调用一次。
 */
export function loadProjectDotenv(projectRoot: string): Set<string> {
    const envPath = path.resolve(projectRoot, '.env');
    if (!existsSync(envPath)) return new Set();

    // dotenv.parse 只解析文件，不写 process.env
    const parsed = dotenv.parse(readFileSync(envPath));
    const loadedKeys = new Set<string>();

    for (const [key, value] of Object.entries(parsed)) {
        if (CLI_KEYS.has(key)) continue; // P1 CLI args 永不被覆盖
        process.env[key] = value; // P2 第三方 .env 覆盖 P3 本地 .env
        loadedKeys.add(key);
    }
    return loadedKeys;
}

// ─── env 对象：getter 懒读取，确保 loadProjectDotenv() 后立即生效 ────────────
// 每次访问 env.xxx 都从 process.env 实时读取，避免快照冻结问题
export const env = {
    /** PostgreSQL 连接字符串，如 postgresql://user:pass@host:5432/db */
    get pgUrl() {
        return (
            process.env.PG_URL ??
            'postgresql://postgres:devpassword@127.0.0.1:5432/code_intelligence' // TODO: 替换为公网实例地址
        );
    },
    /** symbols 表名，可通过 SYMBOLS_TABLE 环境变量配置 */
    get symbolsTable() {
        return process.env.SYMBOLS_TABLE ?? 'symbols';
    },
    /** Python FastAPI 嵌入服务根 URL，如 http://127.0.0.1:8765 */
    get embeddingServiceUrl() {
        return (process.env.EMBEDDING_SERVICE_URL ?? '').trim();
    },
    /** Redis 连接 URL，供 BullMQ embedding worker 使用 */
    get redisUrl() {
        return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    },
};

export function validateEnv(): void {
    if (!process.env.PG_URL) {
        console.warn(
            '[Config] PG_URL not set, using default: postgresql://postgres:devpassword@127.0.0.1:5432/code_intelligence'
        );
    }
}
