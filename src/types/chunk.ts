export interface ChunkedDocumentInput {
    sourceId?: string | null;
    title: string;
    path: string;
    content: string;
    category?: string | null;
    summary?: string | null;
    metadata?: Record<string, unknown> | null;
}

export interface ChunkingOptions {
    targetChars?: number;
    maxChars?: number;
    overlapChars?: number;
}

export interface BuiltDocumentChunk {
    sourceId: string | null;
    title: string;
    path: string;
    chunkIndex: number;
    chunkCount: number;
    content: string;
    summary: string | null;
    category: string | null;
    meta: Record<string, unknown> | null;
    semanticHash: string;
}

export interface StoredDocumentChunk extends BuiltDocumentChunk {
    id: number;
    embedding?: number[] | null;
    similarity?: number;
    createdAt?: string | null;
    updatedAt?: string | null;
}
