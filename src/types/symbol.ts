export type SymbolType = "component" | "util" | "selector" | "type";

export interface CodeSymbol {
  id: number;
  name: string;
  type: SymbolType;
  category: string | null;
  path: string;
  description: string | null;
  content: string | null;
  meta: Record<string, unknown> | null;
  usageCount: number;
  createdAt?: string | null;
  /** Phase 5：入库向量（工具响应里通常会去掉以减小 payload） */
  embedding?: number[] | null;
}
