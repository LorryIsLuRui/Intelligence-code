import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');

// 解析命令行参数 --key=value 格式，注入到 process.env
for (const arg of process.argv) {
    const match = arg.match(/^--([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
        process.env[match[1]] = match[2];
    }
}

// 加载本地 .env（外部传入的 env 已经在 process.env 中，override: false 不会覆盖它们）
dotenv.config({
    path: path.resolve(projectRoot, '.env'),
    override: false,
});

// 尝试从第三方项目目录加载 .env（INDEX_ROOT 或 cwd）
const clientProjectRoot = process.env.INDEX_ROOT || process.cwd();
console.error(
    `[Config] Loading .env from client project root: ${clientProjectRoot}`
);
dotenv.config({
    path: path.resolve(clientProjectRoot, '.env'),
    override: true,
});

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
    `[Config] MYSQL_ENABLED: ${process.env.MYSQL_ENABLED},
    MYSQL_HOST: ${process.env.MYSQL_HOST},
    MYSQL_USER: ${process.env.MYSQL_USER},
    MYSQL_DATABASE: ${process.env.MYSQL_DATABASE},
    EMBEDDING_SERVICE_URL: ${process.env.EMBEDDING_SERVICE_URL},
    MYSQL_SYMBOLS_TABLE: ${process.env.MYSQL_SYMBOLS_TABLE}
    `
);
export const env = {
    mysqlEnabled: process.env.MYSQL_ENABLED === 'true',
    mysqlHost: process.env.MYSQL_HOST ?? '127.0.0.1',
    mysqlPort: Number(process.env.MYSQL_PORT ?? '3306'),
    mysqlUser: process.env.MYSQL_USER ?? 'root',
    mysqlPassword: process.env.MYSQL_PASSWORD ?? '',
    mysqlDatabase: process.env.MYSQL_DATABASE ?? 'code_intelligence',
    /** symbols 表名，可通过 MYSQL_SYMBOLS_TABLE 环境变量配置 */
    mysqlSymbolsTable: process.env.MYSQL_SYMBOLS_TABLE ?? 'symbols',
    /** Phase 5：指向 Python FastAPI 嵌入服务根 URL，如 http://127.0.0.1:8765 */
    embeddingServiceUrl: (process.env.EMBEDDING_SERVICE_URL ?? '').trim(),
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
