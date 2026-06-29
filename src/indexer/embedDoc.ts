/**
 * 将符号的稳定元信息平铺为"自然语言伪文档"，供 embedding 模型编码。
 *
 * 索引侧（write）与 检索侧（read）共用同一模板，确保 embedding 空间分布一致。
 *
 * 为什么不用 JSON.stringify？
 * 384 维通用 embedding 模型对 JSON 语法（花括号、引号、key名）的结构语义理解不好，
 * 注意力会浪费在解析语法格式上。平铺为自然语言描述文本后，模型能更直接地捕获语义。
 */

export interface EmbedDocInput {
    name: string;
    type: string;
    description: string | null;
    signature: string;
    behavior?: string[];
    sideEffects: string[];
    hooks: string[];
}

export function toEmbedDoc(input: EmbedDocInput): string {
    const lines: string[] = [];

    lines.push(`Type: ${input.type}`);
    lines.push(`Name: ${input.name}`);

    if (input.description) {
        lines.push(`Description: ${input.description}`);
    }

    if (input.signature) {
        lines.push(`Signature: ${input.signature}`);
    }

    if (input.behavior && input.behavior.length > 0) {
        lines.push(`Behavior: ${input.behavior.join(', ')}`);
    }

    lines.push(
        input.hooks.length > 0
            ? `Hooks: ${input.hooks.join(', ')}`
            : 'Hooks: none'
    );

    lines.push(
        input.sideEffects.length > 0
            ? `Side effects: ${input.sideEffects.join(', ')}`
            : 'Side effects: none'
    );

    return lines.join('\n');
}