/**
 * astNormalizerJs.ts
 *
 * JS/JSX 文件的语义签名提取，对应 ts-morph 版的 extractNormalizedSignature。
 * Babel AST 没有类型信息，通过以下策略补偿：
 *   1. 有 JSDoc → 从 @param / @returns 提取类型
 *   2. 无 JSDoc → 参数类型标记为 $unknown，签名仍可区分结构形态
 *
 * 与 TS 版行为对齐：
 *   - 参数名   → 丢弃，替换为 $p
 *   - 函数体   → 替换为 {}
 *   - 默认值存在性保留（=$default），默认值内容丢弃
 *   - rest 参数保留 ... 前缀
 *   - 解构参数保留结构形态（{} / []），无法展开内部字段
 */

import { createHash } from 'node:crypto';
import * as t from '@babel/types';
import type { CodeSymbol } from '../types/symbol.js';
import { makeParamPlaceholder } from './paramPlaceholder.js';

// ─────────────────────────────────────────────
// JSDoc 类型提取
// ─────────────────────────────────────────────
function getJSDoc(node: any): string | null {
    const comments = node.leadingComments;
    if (!comments || comments.length === 0) return null;

    const jsdoc = comments.find(
        (c: any) => c.value.includes('@param') || c.value.includes('@returns')
    );

    return jsdoc ? jsdoc.value : null;
}

interface JSDocInfo {
    params: Record<string, string>;
    returnType?: string;
}
function parseJSDoc(jsdoc: string): JSDocInfo {
    const params: Record<string, string> = {};
    let returnType: string | undefined;

    const paramRegex = /@param\s+\{([^}]+)\}\s+(\w+)/g;
    const returnRegex = /@returns?\s+\{([^}]+)\}/;

    let match;

    while ((match = paramRegex.exec(jsdoc))) {
        const [, type, name] = match;
        params[name] = normalizeType(type);
    }

    const returnMatch = jsdoc.match(returnRegex);
    if (returnMatch) {
        returnType = normalizeType(returnMatch[1]);
    }

    return { params, returnType };
}
function normalizeType(type: string): string {
    type = type.trim().toLowerCase();

    if (type.includes('window') || type.includes('htmlelement')) {
        return 'object';
    }

    if (type.includes('string')) return 'string';
    if (type.includes('number')) return 'number';
    if (type.includes('boolean')) return 'boolean';
    if (type.includes('array')) return 'array';
    if (type.includes('object')) return 'object';

    if (type.includes('promise')) {
        const inner = type.match(/promise<(.+)>/);
        return inner ? `Promise<${normalizeType(inner[1])}>` : 'Promise';
    }

    return 'unknown';
}

function normalizeObjectPattern(param: any, jsdoc?: JSDocInfo): string {
    const props = param.properties
        .map((p: any) => {
            if (p.type === 'ObjectProperty' && p.key?.name) {
                const name = p.key.name;
                const type = jsdoc?.params[name] ?? 'unknown';
                return `${name}:${type}`;
            }
            if (p.type === 'RestElement' && p.argument?.name) {
                return `...${p.argument.name}:unknown`;
            }
            return 'unknown';
        })
        .sort();

    return `{${props.join(';')}}`;
}

function normalizeParam(
    param: any,
    fallbackName: string,
    jsdoc?: JSDocInfo
): string {
    if (param.type === 'Identifier') {
        const type = jsdoc?.params[param.name] ?? 'unknown';
        return `${fallbackName}:${type}`;
    }

    if (param.type === 'ObjectPattern') {
        return normalizeObjectPattern(param, jsdoc);
    }

    if (param.type === 'AssignmentPattern') {
        const left = normalizeParam(param.left, fallbackName, jsdoc);
        return `${left}=$default`;
    }

    if (param.type === 'RestElement') {
        if (param.argument?.type === 'Identifier') {
            const type = jsdoc?.params[param.argument.name] ?? 'unknown';
            return `...${fallbackName}:${type}`;
        }
        if (param.argument?.type === 'ObjectPattern') {
            return `...${normalizeObjectPattern(param.argument, jsdoc)}`;
        }
    }

    return `${fallbackName}:unknown`;
}
function inferTypeFromExpression(expr: t.Node): string {
    if (t.isStringLiteral(expr)) return 'string';
    if (t.isNumericLiteral(expr)) return 'number';
    if (t.isBooleanLiteral(expr)) return 'boolean';
    if (t.isArrayExpression(expr)) return 'array';
    if (t.isObjectExpression(expr)) return 'object';

    return 'unknown';
}
function inferReturnType(node: t.Function | t.ArrowFunctionExpression): string {
    if (!node.body) return 'unknown';

    if (t.isBlockStatement(node.body)) {
        const returnStmt = node.body.body.find(t.isReturnStatement);

        if (returnStmt && returnStmt.argument) {
            return inferTypeFromExpression(returnStmt.argument);
        }
    }

    if (!t.isBlockStatement(node.body)) {
        return inferTypeFromExpression(node.body);
    }

    return 'unknown';
}
function normalizeFunction(node: any) {
    const jsdocText = getJSDoc(node);
    const jsdoc = jsdocText ? parseJSDoc(jsdocText) : undefined;

    const params = node.params.map((p: any, i: number) =>
        normalizeParam(p, makeParamPlaceholder(i), jsdoc)
    );

    const returnType = jsdoc?.returnType ?? inferReturnType(node);

    return `fn(${params.join(',')})=>${returnType}`;
}

function normalizeArrowFunction(node: t.ArrowFunctionExpression) {
    const jsdocText = getJSDoc(node);
    const jsdoc = jsdocText ? parseJSDoc(jsdocText) : undefined;

    const params = node.params.map((p: any, i: number) =>
        normalizeParam(p, makeParamPlaceholder(i), jsdoc)
    );
    // const params = node.params.map((p, i) => normalizeParam(p, `$p${i}`));

    const returnType = jsdoc?.returnType ?? inferReturnType(node);

    return `fn(${params.join(',')})=>${returnType}`;
}
function normalizeClass(node: t.ClassDeclaration): string {
    const methods = node.body.body
        .filter(t.isClassMethod)
        .map((m) => {
            const name = t.isIdentifier(m.key) ? m.key.name : 'unknown';
            return `${name}():unknown`;
        })
        .sort();

    return `class{${methods.join(';')}}`;
}
function traverseNode(node: t.Node, cb: (n: t.Node) => void) {
    cb(node);

    for (const key in node) {
        const value = (node as any)[key];

        if (Array.isArray(value)) {
            value.forEach((v) => {
                if (v && typeof v.type === 'string') {
                    traverseNode(v, cb);
                }
            });
        } else if (value && typeof value.type === 'string') {
            traverseNode(value, cb);
        }
    }
}
export function inferBehaviorFromJS(node: t.Node): string[] {
    const behavior: string[] = [];

    // 遍历 AST
    traverseNode(node, (n) => {
        // fetch / axios
        if (t.isCallExpression(n) && t.isIdentifier(n.callee)) {
            const name = n.callee.name.toLowerCase();

            if (name.includes('fetch') || name.includes('axios')) {
                behavior.push('performs network request');
            }

            if (name.includes('settimeout')) {
                behavior.push('uses timer');
            }
        }

        if (
            t.isCallExpression(n) &&
            t.isMemberExpression(n.callee) &&
            t.isIdentifier(n.callee.property)
        ) {
            const prop = n.callee.property.name;
            if (
                prop === 'getBoundingClientRect' ||
                prop === 'getComputedStyle'
            ) {
                behavior.push('reads dom layout');
            }
        }

        // localStorage
        if (
            t.isMemberExpression(n) &&
            t.isIdentifier(n.object) &&
            n.object.name === 'localStorage'
        ) {
            behavior.push('uses local storage');
        }
    });

    return Array.from(new Set(behavior));
}
export function extractNormalizedSignatureJS(node: t.Node): string {
    if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) {
        return normalizeFunction(node);
    }

    if (t.isArrowFunctionExpression(node)) {
        return normalizeArrowFunction(node);
    }

    if (t.isClassDeclaration(node)) {
        return normalizeClass(node);
    }

    return '';
}
export function computeSemanticHashJs(
    row: Pick<CodeSymbol, 'name' | 'type' | 'description' | 'meta'> & {
        node: any;
    }
): Array<string> {
    const signature = extractNormalizedSignatureJS(row.node);

    const behavior = inferBehaviorFromJS(row.node);
    const meta = row.meta || {};
    const stable = {
        name: row.name,
        type: row.type,
        description: row.description ?? null,
        signature,
        behavior: behavior.sort(),
        sideEffects: [
            ...((meta.sideEffects as string[] | undefined) ?? []),
        ].sort(),
        hooks: [...((meta.hooks as string[] | undefined) ?? [])].sort(),
    };
    const stableStr = JSON.stringify(stable);
    return [createHash('sha256').update(stableStr).digest('hex'), stableStr];
}
