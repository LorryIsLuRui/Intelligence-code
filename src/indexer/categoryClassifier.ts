/**
 * category 分类器：三层融合（规则 + embedding + LLM）
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { createEmbeddingClient } from '../services/embeddingClient.js';
import { cosineSimilarity } from '../services/vectorMath.js';
import { inferCategoryFromPath, inferCategoryFromName } from './heuristics.js';
import { IndexedSymbolRow } from './indexProject.js';

// 1. 定义 category label space
const CATEGORIES = [
    'network',
    'form',
    'validation',
    'format',
    'state',
    'ui',
    'storage',
    'math',
    'hook',
    'utils',
    'component',
    'service',
] as const;
type Category = (typeof CATEGORIES)[number];

// 2. 预计算 category embeddings（缓存）
let categoryEmbeddingsCache: Array<{
    name: Category;
    embedding: number[];
}> | null = null;

export async function initCategoryEmbeddings(): Promise<void> {
    if (!env.embeddingServiceUrl) return;
    const client = createEmbeddingClient(env.embeddingServiceUrl);
    const embeddings = await Promise.all(
        CATEGORIES.map(async (c) => {
            const [vec] = await client.embed([c]);
            return { name: c, embedding: vec };
        })
    );
    categoryEmbeddingsCache = embeddings;
}

// 3. embedding 层
const EMBEDDING_THRESHOLD = 0.5;

// TODO: 这里有问题，embedding是语义模板向量，categoryEmbeddingsCache是单个词的向量，相似度必然是<0.3
function categoryFromEmbedding(embedding: number[]): Category | null {
    if (!categoryEmbeddingsCache) return null;
    let best: Category = 'utils';
    let maxScore = -Infinity;
    for (const c of categoryEmbeddingsCache) {
        const score = cosineSimilarity(embedding, c.embedding);
        if (score > maxScore) {
            maxScore = score;
            best = c.name;
        }
    }
    return maxScore < EMBEDDING_THRESHOLD ? null : best;
}

// 4. LLM 层（带缓存）
const LLM_CACHE_TTL = 24 * 60 * 60 * 1000;
const OLLAMA_URL = 'http://127.0.0.1:11434/v1/chat/completions';
// 可根据本地实际情况调整模型名称，例如：'llama3.2:3b'、'llama3.1:8b'
const OLLAMA_MODEL = 'llama3.2:3b';
const llmCategoryCache = new Map<
    string,
    { category: Category; timestamp: number }
>();

async function categoryFromLLM(
    stableStr: string | null
): Promise<Category | null> {
    if (!stableStr) return null;
    const cacheKey = createHash('sha256')
        .update(stableStr)
        .digest('hex')
        .slice(0, 16);
    const cached = llmCategoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < LLM_CACHE_TTL)
        return cached.category;
    const prompt = `给一段代码语义说明，在下面列出来的所有类别中找到最相符的类别，请直接返回命中的原始字符串，没有命中不用返回。
    代码语义:${stableStr}
    类别合集: ${CATEGORIES.join(', ')}`;
    try {
        const body = {
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.4,
            stream: false,
        };
        const res = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = (await res.json()) as any;
        const content = data.choices?.[0]?.message?.content
            ?.trim()
            ?.toLowerCase();
        const category = CATEGORIES.find((c) => content.includes(c));
        if (category) {
            llmCategoryCache.set(cacheKey, { category, timestamp: Date.now() });
            return category;
        }
    } catch (e) {
        console.error('[categoryFromLLM]', e);
    }
    return null;
}

// 5. 三层融合
export async function resolveCategory(
    rows: Array<IndexedSymbolRow>,
    vecs: number[][]
): Promise<Array<IndexedSymbolRow>> {
    const pros = rows.map(async (r, i) => {
        const { name } = r;
        const ruleCategory =
            inferCategoryFromPath(r.path) || inferCategoryFromName(name);
        // console.error(`===from ruleCategory`, name, ruleCategory);
        if (ruleCategory) {
            return {
                ...r,
                category: ruleCategory,
            };
        }
        // TODO: 这里有问题，embedding是语义模板向量，categoryEmbeddingsCache是单个词的向量，相似度必然是<0.3
        const emd = categoryFromEmbedding(vecs[i]);
        // console.error(`===from categoryFromEmbedding`, name, emd);
        if (emd) {
            return {
                ...r,
                category: emd,
            };
        }
        const cateLlm = await categoryFromLLM(r.content);
        // console.error(`===from categoryFromLLM`, name, cateLlm);
        return {
            ...r,
            category: cateLlm,
        };
    });
    const newRows: Array<IndexedSymbolRow> = await Promise.all(pros);
    return newRows;
}
