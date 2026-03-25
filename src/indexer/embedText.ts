import type { IndexedSymbolRow } from "./indexProject.js";

function briefMeta(meta: Record<string, unknown>): string {
  const keys = ["props", "params", "properties", "hooks"] as const;
  const parts: string[] = [];
  for (const k of keys) {
    const v = meta[k];
    if (Array.isArray(v)) {
      const strs = v.filter((x): x is string => typeof x === "string");
      if (strs.length) parts.push(`${k}: ${strs.slice(0, 24).join(", ")}`);
    }
  }
  return parts.join("; ");
}

/**
 * 拼成一段供向量模型编码的文本（名称、路径、注释、meta 摘要、源码片段）。
 */
export function indexedRowToEmbedText(row: IndexedSymbolRow): string {
  const metaBit = briefMeta(row.meta);
  return [
    `${row.type} ${row.name}`,
    row.path,
    row.description ?? "",
    metaBit,
    (row.content ?? "").slice(0, 1200)
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}
