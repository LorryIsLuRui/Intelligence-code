/**
 * queryRewriter.ts — 本地关键词提取 + LLM Query Rewrite 管道。
 *
 * 流程：
 *   rawQuery ─→ extractQueryKeywords ─→ 纯净特征词池 [form, input, error, label]
 *   rawQuery + keywords ─→ callLLMToRewrite ─→ English pseudo-doc
 *                         "Looking for a FormInput component that handles text input
 *                          with error validation messaging and standard form attributes."
 */

import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// ─── Step 1: 本地毫秒级纯净特征词提取 ──────────────────────────────────────────

/** 代码领域的通用噪音词：BM25 不需要这些词过滤，反而会淹没有效 token */
const GENERIC_CODE_TOKENS = new Set([
    'component',
    'components',
    'hook',
    'hooks',
    'util',
    'utils',
    'utility',
    'function',
    'functions',
    'func',
    'class',
    'classes',
    'type',
    'types',
    'interface',
    'interfaces',
    'page',
    'pages',
    'screen',
    'screens',
    'app',
    'application',
    'module',
    'modules',
    'service',
    'services',
    'provider',
    'providers',
    'config',
    'configuration',
    'helper',
    'helpers',
    'tool',
    'tools',
    'common',
    'shared',
    'base',
    'core',
    'main',
    'index',
]);

/**
 * 从用户原始查询中提取纯净代码特征词。
 * - 英文标识符：保留 >= 2 字符的词，过滤通用噪音词
 * - 中文：拆分为 bigram
 * - 返回去重后的小写词列表
 */
export function extractQueryKeywords(rawQuery: string): string[] {
    const tokens = new Set<string>();
    const normalized = rawQuery.trim().toLowerCase();

    // 英文字母/数字/下划线 token
    for (const match of normalized.matchAll(/[a-z0-9_]+/g)) {
        const token = match[0];
        if (token.length >= 2 && !GENERIC_CODE_TOKENS.has(token)) {
            tokens.add(token);
        }
    }

    // 拆解 camelCase / PascalCase：useFormInput → use, form, input
    for (const token of [...tokens]) {
        const parts = token.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
        if (parts.length > 1) {
            for (const part of parts) {
                const lower = part.toLowerCase();
                if (lower.length >= 2 && !GENERIC_CODE_TOKENS.has(lower)) {
                    tokens.add(lower);
                }
            }
        }
    }

    // 中文 bigram（相邻两个字符为一组）
    for (const match of rawQuery.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const text = match[0];
        for (let i = 0; i < text.length - 1; i++) {
            tokens.add(text.slice(i, i + 2));
        }
    }

    return [...tokens];
}

// ─── Step 2: LLM Query Rewrite（检索侧: query → 英文 prose）───────────────

const REWRITE_CACHE_TTL = 3600; // 1 小时（Redis TTL，单位秒）

/** 懒初始化 Redis 客户端，连接失败时静默降级 */
let _redis: Redis | null | undefined;
function getRedis(): Redis | null {
    if (_redis === undefined) {
        try {
            _redis = new Redis(env.redisUrl, {
                maxRetriesPerRequest: 1,
                enableReadyCheck: false,
                lazyConnect: true,
            });
        } catch {
            _redis = null;
        }
    }
    return _redis;
}

/** 关闭 Redis 连接（进程退出时调用） */
export function closeRedis(): void {
    if (_redis && _redis.status !== 'close' && _redis.status !== 'end') {
        _redis.disconnect();
    }
    _redis = undefined;
}

/**
 * 根据用户原始 query + 纯净特征词，调用本地 Ollama LLM 生成英文自然语言伪文档。
 * 结果会被缓存（Redis），缓存 key = sha256(rawQuery + keywords)。
 */
export async function callLLMToRewrite(
    rawQuery: string,
    keywords: string[]
): Promise<string> {
    const cacheKey =
        'rewrite:' +
        createHash('sha256')
            .update(rawQuery + '|' + keywords.join(','))
            .digest('hex');

    // Redis 缓存检查
    const redis = getRedis();
    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return cached;
        } catch {
            // Redis 不可用时静默降级
        }
    }

    const prompt = buildRewritePrompt(rawQuery, keywords);
    const prose = await callOllama(prompt);

    // 写入 Redis 缓存
    if (redis) {
        try {
            await redis.setex(cacheKey, REWRITE_CACHE_TTL, prose);
        } catch {
            // 静默降级
        }
    }

    return prose;
}

function buildRewritePrompt(rawQuery: string, keywords: string[]): string {
    return [
        'You are a code retrieval engineer. Your task is to write a short, precise English sentence describing the React component or function the user is looking for.',
        '',
        'Rules:',
        '- Output ONLY the English sentence, no JSON, no markdown, no explanation.',
        '- Describe the purpose and key characteristics naturally in plain English.',
        '- Use the provided code keywords where appropriate.',
        '- If the user query is already in English, incorporate it directly.',
        '',
        `User query: ${rawQuery}`,
        `Code keywords: ${keywords.join(', ')}`,
        '',
        'English description:',
    ].join('\n');
}

export async function callOllama(prompt: string): Promise<string> {
    const url = `${env.ollamaBaseUrl}/v1/chat/completions`;
    const body = {
        model: env.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        stream: false,
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        throw new Error(
            `Ollama API error: ${res.status} ${res.statusText}`
        );
    }

    const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
        throw new Error('Ollama returned empty response');
    }

    return content;
}

// ─── Step 3: Code → LLM Prose（索引侧: 代码元信息 → 英文 prose）──────────────

interface CodeMetadata {
    name: string;
    type: string;
    description: string | null;
    signature?: string;
    hooks?: string[];
    sideEffects?: string[];
    path?: string;
}

const CODE_PROSE_CACHE_TTL = 86400; // 24 小时（Redis TTL，单位秒）

/**
 * 给定代码符号的元信息，用 LLM 生成自然英文描述。
 * 结果与检索侧 `callLLMToRewrite` 产出的 prose 处于同一自然语言分布，
 * 确保两端 embedding 空间对齐。
 *
 * 缓存 key 优先使用 semanticHash（由调用方传入），否则基于 code 元信息计算。
 */
export async function codeToLLMProse(
    code: CodeMetadata,
    cacheKey?: string
): Promise<string | null> {
    const key =
        cacheKey
            ? `codeprose:${cacheKey}`
            : 'codeprose:' +
              createHash('sha256')
                  .update(
                      JSON.stringify({
                          name: code.name,
                          type: code.type,
                          description: code.description,
                          signature: code.signature ?? '',
                          hooks: code.hooks ?? [],
                          sideEffects: code.sideEffects ?? [],
                      })
                  )
                  .digest('hex');

    // Redis 缓存检查
    const redis = getRedis();
    if (redis) {
        try {
            const cached = await redis.get(key);
            if (cached) return cached;
        } catch {
            // 静默降级
        }
    }

    const prompt = buildCodeProsePrompt(code);
    let prose: string;
    try {
        prose = await callOllama(prompt);
    } catch {
        return null; // LLM 不可用时返回 null，调用方自行回退
    }

    // 写入 Redis 缓存
    if (redis) {
        try {
            await redis.setex(key, CODE_PROSE_CACHE_TTL, prose);
        } catch {
            // 静默降级
        }
    }

    return prose;
}

function buildCodeProsePrompt(code: CodeMetadata): string {
    const lines: string[] = [
        'You are a code documentation engineer. Given a code symbol with the following metadata, write a short, precise English sentence describing it.',
        '',
        'Rules:',
        '- Output ONLY a single natural English sentence, no JSON, no markdown, no labels.',
        '- Describe the purpose and key characteristics naturally.',
        '- Mention the symbol name, its type, and what it does.',
        '- If hooks or side effects are listed, mention them naturally.',
        '',
        `Name: ${code.name}`,
        `Type: ${code.type}`,
    ];

    if (code.description) {
        lines.push(`Description: ${code.description}`);
    }
    if (code.signature) {
        lines.push(`Signature: ${code.signature}`);
    }
    if (code.hooks && code.hooks.length > 0) {
        lines.push(`Hooks: ${code.hooks.join(', ')}`);
    }
    if (code.sideEffects && code.sideEffects.length > 0) {
        lines.push(`Side effects: ${code.sideEffects.join(', ')}`);
    }
    lines.push('', 'English description:');
    return lines.join('\n');
}