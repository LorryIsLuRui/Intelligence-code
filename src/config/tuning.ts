/**
 * tuning.ts — 所有可调参数的集中配置。
 *
 * 生产环境中需要多次微调的阈值、权重和限制值均在此定义，
 * 禁止在业务代码里直接写魔法数字。
 */

// ─── Chunk 切分参数 (chunkText.ts) ───────────────────────────────────────────

/** 目标 chunk 字符数：达到此值后尽快在下一个边界处收敛当前块 */
export const CHUNK_TARGET_CHARS = 900;
/** 单个 chunk 最大字符数：超过此值必须做二次切分 */
export const CHUNK_MAX_CHARS = 1200;
/** 相邻 chunk 的重叠字符数：用于减少边界信息丢失 */
export const CHUNK_OVERLAP_CHARS = 120;
/** 句子/换行边界的最小位置比例：不足此比例则不回退到该边界，避免生成过短的 chunk */
export const CHUNK_SENTENCE_BREAK_MIN_RATIO = 0.6;
/** chunk 摘要的最大字符数（仅用于展示与 embedding 辅助信息） */
export const CHUNK_SUMMARY_MAX_CHARS = 160;

// ─── Chunk 语义检索参数 (chunkRepository.ts) ─────────────────────────────────

/** 最低 cosine 相似度：低于此值的 chunk 不返回给调用方 */
export const CHUNK_SIMILARITY_THRESHOLD = 0;
/** 语义检索默认返回的 chunk 数量上限 */
export const CHUNK_TOP_K = 8;

// ─── Symbol 语义检索参数 (symbolRepository.ts) ───────────────────────────────

/** 最低 cosine 相似度：低于此值的 symbol 不返回给调用方 */
export const SYMBOL_SIMILARITY_THRESHOLD = 0;
/** 语义检索默认返回的 symbol 数量上限 */
export const SYMBOL_TOP_K = 20;

// ─── Embedding 文本截断 (embedText.ts) ──────────────────────────────────────

/** 源码片段送入 embedding 前的最大字符数，超出部分截断 */
export const EMBED_MAX_CONTENT_LENGTH = 1200;

// ─── 排名权重 (ranking.ts) ────────────────────────────────────────────────────

/** 综合排名四维度权重，总和须为 1 */
export const RANK_WEIGHTS = {
    textMatch: 0.5,
    usage: 0.3,
    recency: 0.1,
    commonPath: 0.1,
} as const;

/** 每匹配到一个 callee 名称所增加的分数 */
export const CALLEE_MATCH_SCORE_PER_MATCH = 0.05;
/** callee 匹配分数的上限（防止大量 callee 匹配主导总分） */
export const CALLEE_MATCH_SCORE_MAX = 0.2;

/**
 * Token 重叠度评分阶梯（按顺序匹配，首个满足条件的阶梯生效）。
 * - minMatches: 查询 token 中至少命中的数量
 * - minRatio: 命中比例下限
 * - score: 对应的文本匹配分数
 */
export const TOKEN_OVERLAP_TIERS = [
    { minMatches: 4, minRatio: 0.45, score: 0.78 },
    { minMatches: 3, minRatio: 0.3, score: 0.68 },
    { minMatches: 2, minRatio: 0.18, score: 0.56 },
] as const;

/** 非 token-overlap 类型的文本匹配固定分数 */
export const TEXT_MATCH_SCORES = {
    nameContains: 0.85,
    descriptionContains: 0.65,
    weak: 0.2,
} as const;

/**
 * 时效性评分阶梯（按 maxDays 升序评估，首个满足条件的阶梯生效）。
 * - maxDays: 创建距今天数上限
 * - score: 对应的时效分数
 */
export const RECENCY_SCORE_TIERS = [
    { maxDays: 7, score: 1.0 },
    { maxDays: 30, score: 0.8 },
    { maxDays: 90, score: 0.6 },
    { maxDays: 180, score: 0.4 },
] as const;
/** 无 createdAt 时使用的默认时效分数 */
export const RECENCY_SCORE_DEFAULT = 0.4;
/** createdAt 超出所有阶梯（>180天）时的最低时效分数 */
export const RECENCY_SCORE_OLDEST = 0.25;

/** 路径含 /common/ 或 /shared/ 的符号所获得的路径维度分数 */
export const COMMON_PATH_SCORE_YES = 1;
/** 路径不在 common/shared 目录时的路径维度分数 */
export const COMMON_PATH_SCORE_NO = 0.35;

/** 使用频率评分的 log 底数除数（值越大，曲线越平坦） */
export const USAGE_SCORE_LOG_DIVISOR = 3;

/** 语义相似度高于此值时，输出"语义相似度高"标签 */
export const SEMANTIC_REASON_THRESHOLD_HIGH = 0.55;
/** 语义相似度高于此值时，输出"语义相关"标签 */
export const SEMANTIC_REASON_THRESHOLD_MED = 0.4;
/** 使用频率分高于此值时，输出"使用频率高"标签 */
export const USAGE_REASON_THRESHOLD_HIGH = 0.6;

// ─── 推荐质量门控阈值 (recommendationService.ts) ─────────────────────────────

/** 候选通过质量门控所需的最低综合分数 */
export const MIN_RECOMMENDATION_SCORE = {
    semantic: 0.5,
    keyword: 0.45,
} as const;

/** 语义模式下文本维度分数须达到的下限（用于高置信度路径） */
export const MIN_SEMANTIC_TEXT_MATCH_SCORE = 0.6;
/** 名称/路径字面命中时，放宽的综合分数下限 */
export const MIN_LITERAL_MATCH_SCORE = 0.18;
/** props/hooks 结构字段全部命中时，放宽的综合分数下限 */
export const REQUIRED_FIELD_FALLBACK_MIN_SCORE = 0.4;

/** 字面命中（名称或文件名匹配查询词）时，对优先级分数增加的值 */
export const LITERAL_MATCH_PRIORITY_BOOST = 0.22;
/** 路径为 demo/example 风格时，对优先级分数扣减的值 */
export const DEMO_PATH_PRIORITY_PENALTY = 0.18;
/** 文件名为 index.js/ts/tsx/jsx 时对优先级分数的加成（优先推荐组件目录入口文件） */
export const INDEX_FILE_PRIORITY_BOOST = 0.18;
/** 同目录中存在 index 文件时，对其他非入口子文件的优先级扣减（避免 menu.js / panel.js 等内部实现抢占推荐位） */
export const SAME_DIR_INDEX_EXISTS_PENALTY = 0.25;

// ─── 搜索工具结果过滤 (tools/searchSymbols.ts) ───────────────────────────────

/** 最终返回结果所需的最低综合评分 */
export const SEARCH_SCORE_THRESHOLD = 0.45;
/** 最终返回的 symbol 数量上限 */
export const SEARCH_TOP_K = 20;

// ─── RAG 上下文组装参数 (services/contextAssembler.ts) ───────────────────────

/** 每个命中 chunk 向前后各扩展的邻块数量（减少边界截断信息丢失） */
export const CONTEXT_ADJACENT_RADIUS = 1;
/** 注入 prompt 的上下文总字符数预算（超出则从相似度最低的 chunk 开始截断） */
export const CONTEXT_MAX_CHARS = 6000;
/** 邻块扩展后保留的最大 chunk 数量 */
export const CONTEXT_MAX_CHUNKS = 12;
