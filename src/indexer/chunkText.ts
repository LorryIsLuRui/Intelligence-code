import { createHash } from 'node:crypto';
import {
    CHUNK_MAX_CHARS,
    CHUNK_OVERLAP_CHARS,
    CHUNK_SENTENCE_BREAK_MIN_RATIO,
    CHUNK_SUMMARY_MAX_CHARS,
    CHUNK_TARGET_CHARS,
} from '../config/tuning.js';
import type {
    BuiltDocumentChunk,
    ChunkedDocumentInput,
    ChunkingOptions,
} from '../types/chunk.js';

/**
 * chunkText: 文本 chunk 切分器。
 *
 * 当前策略是“语义结构切分 + 轻量 overlap”，适合知识库、Markdown、说明文档：
 * 1. 先按结构拆块：标题、普通段落、代码块。
 * 2. 尽量保持代码块完整，不在 fence 中间切开。
 * 3. 再按 target/max 字符数聚合，优先让 chunk 落在目标区间内。
 * 4. 对超长单块再做二次切分，优先在句号、换行等自然边界处截断。
 * 5. 上一个 chunk 的尾部会以 overlap 形式带到下一个 chunk，减少边界信息丢失。
 *
 * 目标不是做“绝对平均”的固定窗口，而是优先保留结构语义，再用 overlap 补边界。
 */

type TextBlock = {
    kind: 'heading' | 'paragraph' | 'code';
    text: string;
};

// 统一换行并去掉首尾空白，避免切分时混入无意义差异。
function normalizeText(content: string): string {
    return content.replace(/\r\n/g, '\n').trim();
}

// 第一阶段：先按 Markdown 风格结构拆成 heading / paragraph / code 三类 block。
function splitCodeAwareBlocks(content: string): TextBlock[] {
    const normalized = normalizeText(content);
    if (!normalized) return [];

    const lines = normalized.split('\n');
    const blocks: TextBlock[] = [];
    let buffer: string[] = [];
    let inCodeFence = false; // 追踪是否在代码块内，避免误把代码内容当普通文本切分。

    const flushParagraphs = () => {
        if (buffer.length === 0) return;
        const text = buffer.join('\n').trim();
        buffer = [];
        if (!text) return;
        const kind = text.startsWith('#') ? 'heading' : 'paragraph';
        blocks.push({ kind, text });
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            if (inCodeFence) {
                buffer.push(line);
                blocks.push({ kind: 'code', text: buffer.join('\n').trim() });
                buffer = [];
                inCodeFence = false;
            } else {
                flushParagraphs();
                inCodeFence = true;
                buffer.push(line);
            }
            continue;
        }

        if (inCodeFence) {
            buffer.push(line);
            continue;
        }

        if (trimmed.startsWith('#')) {
            flushParagraphs();
            blocks.push({ kind: 'heading', text: trimmed });
            continue;
        }

        if (!trimmed) {
            flushParagraphs();
            continue;
        }

        buffer.push(line);
    }

    flushParagraphs();
    return blocks;
}

// 第二阶段：如果某个单独 block 过长，再按自然边界做窗口切分，并保留 overlap。
function sliceWithOverlap(
    text: string,
    maxChars: number,
    overlapChars: number
): string[] {
    const normalized = text.trim();
    if (!normalized) return [];
    if (normalized.length <= maxChars) return [normalized];

    const out: string[] = [];
    let start = 0;

    while (start < normalized.length) {
        let end = Math.min(start + maxChars, normalized.length);

        if (end < normalized.length) {
            const window = normalized.slice(start, end);
            // 优先回退到更自然的句子/换行边界，避免把一句话截成两半。
            const sentenceBreak = Math.max(
                window.lastIndexOf('. '),
                window.lastIndexOf('。'),
                window.lastIndexOf('! '),
                window.lastIndexOf('? '),
                window.lastIndexOf('\n')
            );
            if (
                sentenceBreak >
                Math.floor(maxChars * CHUNK_SENTENCE_BREAK_MIN_RATIO)
            ) {
                // 边界不能太靠前，否则可能导致过多 chunk 和过短的上下文，设置一个阈值（如 maxChars 的 60%）来平衡。
                end = start + sentenceBreak + 1;
            }
        }

        out.push(normalized.slice(start, end).trim());
        if (end >= normalized.length) break;
        start = Math.max(end - overlapChars, start + 1);
    }

    return out.filter(Boolean);
}

// 将当前累计 block 收敛成一个 chunk，并把末尾 overlap 作为下一块的前缀上下文。
function finalizeChunk(
    chunks: string[],
    currentBlocks: string[],
    overlapChars: number
): string[] {
    if (currentBlocks.length === 0) return [];
    const chunk = currentBlocks.join('\n\n').trim();
    if (!chunk) return [];
    chunks.push(chunk);
    if (overlapChars <= 0) return [];
    // 从上一个 chunk 末尾切出 overlapChars 长度的文本，作为下一 chunk 的前置上下文，减少边界信息丢失。
    const tail = chunk.slice(-overlapChars).trim();
    return tail ? [tail] : [];
}

// 对外主入口：结构切分优先，其次按 target/max 控制块大小，最后用 overlap 补边界。
export function splitTextIntoChunks(
    content: string,
    options: ChunkingOptions = {}
): string[] {
    const targetChars = options.targetChars ?? CHUNK_TARGET_CHARS;
    const maxChars = options.maxChars ?? CHUNK_MAX_CHARS;
    const overlapChars = options.overlapChars ?? CHUNK_OVERLAP_CHARS;
    // 1. 语义切分：按照结构拆分（eg: ```, #）
    const blocks = splitCodeAwareBlocks(content);
    if (blocks.length === 0) return [];

    const chunks: string[] = []; // 每一个元素是如下结构组成的字符串：0-首行，之后的索引对应值都是：上一个 chunk 的末尾 overlap 文本 + 当前 block 文本，块与块之间用双换行分隔。
    let currentBlocks: string[] = [];
    let currentLength = 0;

    for (const block of blocks) {
        // 2. 自然边界切分：每一个block再按照[.。!?、换行等]自然边界切分
        const oversizedParts =
            block.text.length > maxChars
                ? sliceWithOverlap(block.text, maxChars, overlapChars)
                : [block.text];

        for (const part of oversizedParts) {
            // 3. overlap 滑动窗口：每当累计块接近目标大小或即将超出上限时，先把当前块收敛成一个 chunk，再开始下一块。每个新块的开头会带上前一个块末尾 overlapChars 长度的文本，减少边界信息丢失。
            const additionLength =
                currentLength === 0 ? part.length : part.length + 2;
            const wouldOverflowMax =
                currentLength > 0 && currentLength + additionLength > maxChars;
            const reachedTarget = currentLength >= targetChars;

            // 已接近目标大小或即将超出上限时，先收敛当前 chunk，再开始下一块。
            if (wouldOverflowMax || reachedTarget) {
                currentBlocks = finalizeChunk(
                    chunks,
                    currentBlocks,
                    overlapChars
                );
                currentLength = currentBlocks.join('\n\n').length;
            }
            currentBlocks.push(part);
            currentLength = currentBlocks.join('\n\n').length;
        }
    }

    finalizeChunk(chunks, currentBlocks, 0);
    return chunks;
}

// 截取 chunk，做chunk embedding 时的摘要展示，提升检索结果的可读性和判断相关性的效率。
function buildChunkSummary(content: string): string | null {
    const flattened = content.replace(/\s+/g, ' ').trim();
    if (!flattened) return null;
    return flattened.slice(0, CHUNK_SUMMARY_MAX_CHARS);
}

// chunk hash 以 path + chunkIndex + content 生成，用于稳定标识具体分块。
function computeChunkHash(
    path: string,
    chunkIndex: number,
    content: string
): string {
    return createHash('sha256')
        .update(`${path}#${chunkIndex}\n${content}`)
        .digest('hex');
}

// 将原始文档输入转为可入库的 chunk 记录，附带索引、总块数、摘要和 semantic hash。
export function buildDocumentChunks(
    document: ChunkedDocumentInput,
    options: ChunkingOptions = {}
): BuiltDocumentChunk[] {
    const chunks = splitTextIntoChunks(document.content, options);
    return chunks.map((content, index) => ({
        sourceId: document.sourceId ?? null,
        title: document.title,
        path: document.path,
        chunkIndex: index,
        chunkCount: chunks.length,
        content,
        summary: buildChunkSummary(content),
        category: document.category ?? null,
        meta: document.metadata ?? null,
        semanticHash: computeChunkHash(document.path, index, content),
    }));
}
