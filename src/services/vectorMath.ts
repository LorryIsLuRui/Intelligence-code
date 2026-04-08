// 计算两个向量的余弦相似度，返回值在 -1 到 1 之间，1 表示完全相似，0 表示不相关，-1 表示完全相反。
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length !== a.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom === 0) return 0;
    return dot / denom;
}
