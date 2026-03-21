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
}
