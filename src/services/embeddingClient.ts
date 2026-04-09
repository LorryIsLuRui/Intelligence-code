export interface EmbeddingClient {
    embed(texts: string[]): Promise<number[][]>;
}

export function createEmbeddingClient(baseUrl: string): EmbeddingClient {
    const root = baseUrl.replace(/\/$/, '');
    return {
        async embed(texts: string[]): Promise<number[][]> {
            if (texts.length === 0) return [];
            const res = await fetch(`${root}/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts }),
                signal: AbortSignal.timeout(180_000),
            });
            if (!res.ok) {
                const t = await res.text().catch(() => '');
                throw new Error(
                    `embedding service HTTP ${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`
                );
            }
            const data = (await res.json()) as { embeddings?: number[][] };
            if (!data.embeddings || !Array.isArray(data.embeddings)) {
                throw new Error(
                    'embedding service returned invalid JSON (missing embeddings)'
                );
            }
            return data.embeddings;
        },
    };
}

export async function embedAll(
    client: EmbeddingClient,
    texts: string[],
    chunkSize = 48
): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
        const chunk = texts.slice(i, i + chunkSize);
        const vecs = await client.embed(chunk);
        if (vecs.length !== chunk.length) {
            throw new Error(
                `embedding service returned ${vecs.length} vectors for ${chunk.length} texts`
            );
        }
        out.push(...vecs);
    }
    return out;
}
