/**
 * contextAssembler: RAG 上下文组装器。
 *
 * 完整流程：
 *   topK hits
 *     → 邻块扩展（getAdjacentChunks）：补全被截断的边界上下文
 *     → 去重（path + chunk_index）：避免重复块被重复计费
 *     → 相关性排序：命中块靠前，纯邻块靠后
 *     → 字符预算截断：超出 CONTEXT_MAX_CHARS 时丢弃末尾块
 *     → 文本渲染：拼成可直接注入 prompt 的 contextText
 *
 * 为什么需要邻块扩展？
 *   chunk 切分时按结构和字符数截断，单个 chunk 可能只包含一段话的前半句。
 *   取前后邻块（radius=1 即各一块）可以在不大幅增加 token 成本的前提下
 *   把被截断的上下文还原，显著降低 LLM 产生"幻觉引用"的概率。
 *
 * 为什么要字符预算？
 *   大多数 LLM 有 context window 限制。超出预算不仅导致截断错误，
 *   还会因为过长的无关文本降低模型对真正相关段落的注意力权重（"lost in the middle"问题）。
 *   控制预算 = 控制召回精度。
 */

import type { ChunkRepository } from '../repositories/chunkRepository.js';
import type { StoredDocumentChunk } from '../types/chunk.js';
import {
    CONTEXT_ADJACENT_RADIUS,
    CONTEXT_MAX_CHARS,
    CONTEXT_MAX_CHUNKS,
} from '../config/tuning.js';

export interface AssembledContext {
    /** 最终选入上下文的 chunk 列表，按相关性降序排列 */
    chunks: StoredDocumentChunk[];
    /** 拼装好的纯文本，可直接插入 prompt 的 system/user 消息 */
    contextText: string;
    /** 命中块数量（邻块扩展前） */
    hitCount: number;
    /** 邻块扩展后选入的总 chunk 数 */
    totalChunks: number;
    /** 是否因字符预算不足而截断了部分 chunk */
    truncated: boolean;
}

/**
 * 渲染单个 chunk 为可读文本块，附带来源元信息。
 *
 * 格式示例：
 *   [来源: qa-doc/topK.md · 第2块/共5块 · 相似度 0.87]
 *   topK 参数控制返回数量，默认值为...
 */
function renderChunk(chunk: StoredDocumentChunk): string {
    const parts: string[] = [`来源: ${chunk.path}`];
    parts.push(`第${chunk.chunkIndex + 1}块/共${chunk.chunkCount}块`);
    if (chunk.similarity != null) {
        parts.push(`相似度 ${chunk.similarity.toFixed(2)}`);
    }
    const header = `[${parts.join(' · ')}]`;
    return `${header}\n${chunk.content}`;
}

export class ContextAssembler {
    constructor(private readonly repo: ChunkRepository) {}

    /**
     * 组装 RAG 上下文。
     *
     * @param hits         来自 ChunkRepository.searchSemantic() 的 topK 结果（已按相似度降序）
     * @param opts.maxChars         覆盖 CONTEXT_MAX_CHARS，用于运行时动态调整 token 预算
     * @param opts.adjacentRadius   覆盖 CONTEXT_ADJACENT_RADIUS，0 表示不做邻块扩展
     * @param opts.maxChunks        覆盖 CONTEXT_MAX_CHUNKS
     */
    async assemble(
        hits: StoredDocumentChunk[],
        opts?: {
            maxChars?: number;
            adjacentRadius?: number;
            maxChunks?: number;
        }
    ): Promise<AssembledContext> {
        const maxChars = opts?.maxChars ?? CONTEXT_MAX_CHARS;
        const radius = opts?.adjacentRadius ?? CONTEXT_ADJACENT_RADIUS;
        const maxChunks = opts?.maxChunks ?? CONTEXT_MAX_CHUNKS;
        const hitCount = hits.length;

        // ── 步骤1：邻块扩展 ──────────────────────────────────────────────────
        // 对每个命中块并行拉取前后邻块，补全被切分边界截断的上下文。
        // 邻块本身没有 similarity 分数，排序时置于命中块之后。
        const expanded = await this.expandWithAdjacentChunks(hits, radius);

        // ── 步骤2：去重 ───────────────────────────────────────────────────────
        // 多个命中块扩展后可能重叠，以 path+chunk_index 为键去重，保留先出现的版本
        // （命中块在前，保留其 similarity；邻块在后，若与命中块重叠则丢弃邻块副本）。
        const deduped = deduplicateChunks(expanded);

        // ── 步骤3：排序 ───────────────────────────────────────────────────────
        // similarity 有值（命中块）> similarity 无值（纯邻块）；同类内部按相似度降序。
        const sorted = sortChunks(deduped);

        // ── 步骤4：字符预算截断 ───────────────────────────────────────────────
        const { selected, truncated } = applyBudget(
            sorted,
            maxChars,
            maxChunks
        );

        // ── 步骤5：文本渲染 ───────────────────────────────────────────────────
        const contextText = selected.map(renderChunk).join('\n\n---\n\n');

        return {
            chunks: selected,
            contextText,
            hitCount,
            totalChunks: selected.length,
            truncated,
        };
    }

    /**
     * 对每个命中块并行拉取邻块，返回命中块 + 所有邻块的扁平列表（含重复，由后续去重处理）。
     * radius=0 时跳过数据库查询，直接返回原始命中列表。
     */
    private async expandWithAdjacentChunks(
        hits: StoredDocumentChunk[],
        radius: number
    ): Promise<StoredDocumentChunk[]> {
        if (radius <= 0 || hits.length === 0) return [...hits];

        // 并行拉取，避免串行 N 次查询放大延迟。
        const adjacentGroups = await Promise.all(
            hits.map((hit) =>
                this.repo.getAdjacentChunks(hit.path, hit.chunkIndex, radius)
            )
        );

        // 命中块在前，邻块紧随其后（之后去重时命中块的 similarity 会被保留）。
        const result: StoredDocumentChunk[] = [...hits];
        for (const group of adjacentGroups) {
            result.push(...group);
        }
        return result;
    }
}

/** 以 `${path}::${chunkIndex}` 为键去重，保留先出现的副本（命中块的 similarity 优先）。 */
function deduplicateChunks(
    chunks: StoredDocumentChunk[]
): StoredDocumentChunk[] {
    const seen = new Set<string>();
    const result: StoredDocumentChunk[] = [];
    for (const chunk of chunks) {
        const key = `${chunk.path}::${chunk.chunkIndex}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(chunk);
        }
    }
    return result;
}

/**
 * 排序规则：
 * 1. 有 similarity（命中块）排在无 similarity（纯邻块）之前
 * 2. 同类内部按 similarity 降序
 * 3. 纯邻块内部保持原有顺序（path + chunkIndex 升序，保证上下文连贯）
 */
function sortChunks(chunks: StoredDocumentChunk[]): StoredDocumentChunk[] {
    return [...chunks].sort((a, b) => {
        const aHasSim = a.similarity != null;
        const bHasSim = b.similarity != null;
        if (aHasSim && !bHasSim) return -1;
        if (!aHasSim && bHasSim) return 1;
        if (aHasSim && bHasSim)
            return (b.similarity ?? 0) - (a.similarity ?? 0);
        // 纯邻块按路径+索引保持文档顺序
        const pathCmp = a.path.localeCompare(b.path);
        return pathCmp !== 0 ? pathCmp : a.chunkIndex - b.chunkIndex;
    });
}

/**
 * 从排好序的 chunk 列表中按字符预算和数量上限截取子集。
 * 按顺序累加字符数，第一个超出预算的 chunk 及之后的全部丢弃。
 */
function applyBudget(
    chunks: StoredDocumentChunk[],
    maxChars: number,
    maxChunks: number
): { selected: StoredDocumentChunk[]; truncated: boolean } {
    const selected: StoredDocumentChunk[] = [];
    let totalChars = 0;

    for (const chunk of chunks) {
        if (selected.length >= maxChunks) {
            return { selected, truncated: true };
        }
        const chunkChars = renderChunk(chunk).length;
        if (totalChars + chunkChars > maxChars && selected.length > 0) {
            return { selected, truncated: true };
        }
        selected.push(chunk);
        totalChars += chunkChars;
    }

    return { selected, truncated: false };
}
