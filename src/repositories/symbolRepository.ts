import type { Pool, RowDataPacket } from "mysql2/promise";
import { getMySqlPool } from "../db/mysql.js";
import type { CodeSymbol, SymbolType } from "../types/symbol.js";

interface SymbolRow extends RowDataPacket {
  id: number;
  name: string;
  type: SymbolType;
  category: string | null;
  path: string;
  description: string | null;
  content: string | null;
  meta: string | null;
  usage_count: number;
  created_at?: string | null;
}

const inMemorySymbols: CodeSymbol[] = [
  {
    id: 1,
    name: "FormInput",
    type: "component",
    category: "form",
    path: "src/components/FormInput.tsx",
    description: "A reusable form input with validation",
    content: null,
    meta: { props: ["value", "onChange", "error"], hooks: ["useForm"] },
    usageCount: 18,
    createdAt: new Date().toISOString()
  },
  {
    id: 2,
    name: "formatDate",
    type: "util",
    category: "date",
    path: "src/utils/date.ts",
    description: "Format date to YYYY-MM-DD",
    content: null,
    meta: { params: ["input"], returnType: "string" },
    usageCount: 40,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString()
  }
];

function mapRow(row: SymbolRow): CodeSymbol {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    category: row.category,
    path: row.path,
    description: row.description,
    content: row.content,
    meta: row.meta ? JSON.parse(row.meta) : null,
    usageCount: row.usage_count,
    createdAt: row.created_at ?? null
  };
}

function getMetaArray(meta: Record<string, unknown> | null, key: string): string[] {
  if (!meta) return [];
  const value = meta[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export class SymbolRepository {
  private pool: Pool | null;

  constructor() {
    this.pool = getMySqlPool();
  }

  async search(query: string, type?: SymbolType): Promise<CodeSymbol[]> {
    if (!this.pool) {
      const q = query.toLowerCase();
      return inMemorySymbols.filter((s) => {
        const typeOk = type ? s.type === type : true;
        return typeOk && (s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q));
      });
    }

    const params: Array<string> = [`%${query}%`];
    let sql = `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at
      FROM symbols
      WHERE (name LIKE ? OR description LIKE ?)
    `;
    params.push(`%${query}%`);

    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }

    sql += " ORDER BY usage_count DESC LIMIT 20";

    const [rows] = await this.pool.query<SymbolRow[]>(sql, params);
    return rows.map(mapRow);
  }

  async getByName(name: string): Promise<CodeSymbol | null> {
    if (!this.pool) {
      return inMemorySymbols.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? null;
    }

    const [rows] = await this.pool.query<SymbolRow[]>(
      `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at
      FROM symbols
      WHERE name = ?
      LIMIT 1
      `,
      [name]
    );

    if (rows.length === 0) {
      return null;
    }

    return mapRow(rows[0]);
  }

  async searchByStructure(
    fields: string[],
    opts?: { type?: SymbolType; category?: string; limit?: number }
  ): Promise<CodeSymbol[]> {
    const normalized = fields.map((f) => f.trim()).filter(Boolean);
    if (normalized.length === 0) return [];
    const type = opts?.type;
    const category = opts?.category?.trim();
    const limit = opts?.limit ?? 20;

    const matchesAll = (symbol: CodeSymbol) => {
      const typeOk = type ? symbol.type === type : true;
      const categoryOk = category
        ? (symbol.category ?? "").toLowerCase().includes(category.toLowerCase())
        : true;
      if (!typeOk || !categoryOk) return false;
      const propPool = [
        ...getMetaArray(symbol.meta, "props"),
        ...getMetaArray(symbol.meta, "params"),
        ...getMetaArray(symbol.meta, "properties"),
        ...getMetaArray(symbol.meta, "hooks")
      ].map((v) => v.toLowerCase());
      return normalized.every((field) => propPool.includes(field.toLowerCase()));
    };

    if (!this.pool) {
      return inMemorySymbols.filter(matchesAll).slice(0, limit);
    }

    const params: Array<string | number> = [];
    let sql = `
      SELECT id, name, type, category, path, description, content, CAST(meta AS CHAR) AS meta, usage_count, created_at
      FROM symbols
      WHERE 1 = 1
    `;

    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    if (category) {
      sql += " AND category LIKE ?";
      params.push(`%${category}%`);
    }
    sql += " ORDER BY usage_count DESC LIMIT ?";
    params.push(Math.max(limit * 5, 50));

    const [rows] = await this.pool.query<SymbolRow[]>(sql, params);
    return rows.map(mapRow).filter(matchesAll).slice(0, limit);
  }
}
