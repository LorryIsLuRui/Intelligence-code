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
            // ── 3. 滑动窗口 + overlap ─────────────────────────────────────────
            // 目标：把 parts 依次合并到 currentBlocks，直到"该收了"再收敛成一个 chunk。
            // 收敛后 finalizeChunk 会把末尾 overlapChars 个字符带入下一块，减少边界信息丢失。
            //
            // 执行示例（targetChars=20, maxChars=30, overlapChars=5）：
            //
            //   part="Hello world"(11)   currentLength=0  → 直接 push
            //     currentBlocks=["Hello world"]  currentLength=11
            //
            //   part="Foo bar baz"(11)   additionLength=11+2=13  currentLength+13=24 ≤ 30，未达目标 → 直接 push
            //     currentBlocks=["Hello world","Foo bar baz"]  currentLength=24
            //
            //   part="A long sentence"(15)  additionLength=15+2=17  currentLength+17=41 > 30 → wouldOverflowMax=true
            //     → finalizeChunk: chunks=["Hello world\n\nFoo bar baz"]
            //                      overlap="r baz"(末5字符)  currentBlocks=["r baz"]  currentLength=5
            //     → push "A long sentence"
            //       currentBlocks=["r baz","A long sentence"]  currentLength=5+2+15=22
            //
            //   最终 finalizeChunk(overlap=0): chunks 追加 "r baz\n\nA long sentence"
            // ─────────────────────────────────────────────────────────────────

            // SEP=2 对应 blocks.join('\n\n') 中每条边界的 '\n\n' 长度；
            // 首个 block 无分隔符，所以 currentLength===0 时不加。
            const SEP = 2;
            const additionLength =
                currentLength === 0 ? part.length : SEP + part.length;

            // 两种情况需要先收敛当前 chunk：
            // 1. wouldOverflowMax：加入本 part 后超出硬上限，被动截断；
            // 2. reachedTarget   ：当前已达目标大小，主动分块，保持粒度均匀。
            const wouldOverflowMax =
                currentLength > 0 && currentLength + additionLength > maxChars;
            const reachedTarget = currentLength >= targetChars;

            if (wouldOverflowMax || reachedTarget) {
                // finalizeChunk 写入 chunks，并把末尾 overlap 文本返回作为新 currentBlocks 起点。
                currentBlocks = finalizeChunk(
                    chunks,
                    currentBlocks,
                    overlapChars
                );
                // overlap 文本长度不固定，必须重算（不能增量推导）。
                currentLength = currentBlocks.join('\n\n').length;
            }

            currentBlocks.push(part);
            // flush 后 currentBlocks 可能含 overlap（length ≥ 1），也可能为空（length === 0）；
            // 增量计算避免每次重新 join 整个数组。
            currentLength =
                currentLength === 0
                    ? part.length
                    : currentLength + SEP + part.length;
        }
    }
    // 收尾兜底，确保剩余内容不丢失
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
