export type SymbolType = 'component' | 'util' | 'selector' | 'type';

export interface CodeSymbol {
    id: number;
    name: string;
    type: SymbolType; // component/util{包括class}/selector/type{type和interface都是这个类型，区别在meta里}
    category: string | null;
    path: string;
    description: string | null;
    content: string | null;
    meta: Record<string, unknown> | null;
    usageCount: number; // 被检索到的次数，初始为 0
    createdAt?: string | null;
    /** Phase 5：入库向量（工具响应里通常会去掉以减小 payload） */
    embedding?: number[] | null;
}
export type MetaKindType = 'class' | 'interface' | 'typeAlias' | 'function';
