/**
 * evalTrace.ts — 推荐主链各阶段符号 ID 追踪，仅在 evalMode=true 时填充。
 *
 * 用于 eval CLI 做 per-symbol 失败分类（误杀分析），
 * 判断 expected symbol 在哪个阶段丢失：
 *   semanticIds → reusableIds → combinedIds → qualifiedIds → returnedIds
 */

/** 推荐主链各阶段存活的 symbol ID（跨所有 query 变体取 union） */
export interface EvalTrace {
    /** 语义/关键词搜索阶段命中的 symbol ID（任意 query 变体出现即计入） */
    semanticIds: number[];
    /** 通过 isReusableCandidate 可复用过滤的 symbol ID */
    reusableIds: number[];
    /** 最终进入排序候选池的 symbol ID（category 过滤 + reusability 过滤后） */
    combinedIds: number[];
    /** 通过质量门控（isStrongEnoughRecommendation）的 symbol ID */
    qualifiedIds: number[];
    /** 最终返回给调用方的 symbol ID（recommended + alternatives） */
    returnedIds: number[];
}

/** per-symbol 失败类型，用于误杀分析报告 */
export type SymbolFailureType =
    | 'no_semantic_recall' // 语义/关键词搜索完全没有召回该 symbol
    | 'reusability_filtered' // isReusableCandidate 过滤掉（路径含 test/demo 等）
    | 'structure_filtered' // 进入了语义候选但在 combined 阶段丢失（category 等过滤）
    | 'ranked_below_topk' // combined 里有但质量门控前排名不够
    | 'quality_gate_rejected' // 进入排序但未通过 isStrongEnoughRecommendation
    | 'found'; // 成功出现在最终结果中

/**
 * 根据 EvalTrace 对单个 expected symbol 进行失败分类。
 * @param symbolId DB 中的 symbol.id（需提前通过名称解析）
 * @param trace 该次推荐调用的 EvalTrace
 */
export function classifySymbolFailure(
    symbolId: number,
    trace: EvalTrace
): SymbolFailureType {
    if (trace.returnedIds.includes(symbolId)) return 'found';
    if (!trace.semanticIds.includes(symbolId)) return 'no_semantic_recall';
    if (!trace.reusableIds.includes(symbolId)) return 'reusability_filtered';
    if (!trace.combinedIds.includes(symbolId)) return 'structure_filtered';
    if (!trace.qualifiedIds.includes(symbolId)) return 'ranked_below_topk';
    return 'quality_gate_rejected';
}
