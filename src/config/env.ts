import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

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

// 尝试从第三方项目目录加载 .env，按变量维度覆盖（只覆盖第三方明确配置的变量）
const clientProjectRoot = process.env.INDEX_ROOT || process.cwd();
const clientEnvPath = path.resolve(clientProjectRoot, '.env');
if (existsSync(clientEnvPath)) {
    console.error(`[Config] Merging .env from client project root: ${clientProjectRoot}`);
    // 手动解析第三方 .env，只覆盖其明确配置的变量
    const clientEnvContent = readFileSync(clientEnvPath, 'utf-8');
    for (const line of clientEnvContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        // 移除引号
        const cleanValue = value.replace(/^["']|["']$/g, '');
        if (key) {
            process.env[key] = cleanValue;
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
