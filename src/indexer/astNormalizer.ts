/**
 * astNormalizer.ts
 * 对 ts-morph Node 做语义级标准化，生成 semantic_hash。
 *
 * 去掉：参数名、泛型参数名、函数体实现、空白格式、字面量值
 * 保留：参数类型结构、返回类型、sideEffects、hooks
 */

import { createHash } from 'node:crypto';
import { Node, ParameterDeclaration, SyntaxKind } from 'ts-morph';
import type { CodeSymbol } from '../types/symbol.js';

// ─────────────────────────────────────────────
// 内置类型白名单：不替换为 $T
// ─────────────────────────────────────────────
const BUILTIN_TYPES = new Set([
    'string',
    'number',
    'boolean',
    'void',
    'null',
    'undefined',
    'never',
    'unknown',
    'any',
    'object',
    'symbol',
    'bigint',
    'Promise',
    'Array',
    'Record',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Partial',
    'Required',
    'Readonly',
    'Pick',
    'Omit',
    'Exclude',
    'Extract',
    'NonNullable',
    'ReturnType',
    'InstanceType',
    'React',
    'ReactNode',
    'ReactElement',
    'FC',
    'MouseEvent',
    'KeyboardEvent',
    'ChangeEvent',
    'HTMLElement',
    'HTMLDivElement',
    'HTMLInputElement',
    'CSSProperties',
    'RefObject',
    'MutableRefObject',
]);

function normalizeTypeName(name: string): string {
    if (BUILTIN_TYPES.has(name)) return name;
    if (/^T[A-Z]/.test(name) || (name.length === 1 && /[A-Z]/.test(name)))
        return '$T';
    return name;
}

function normalizeTypeString(typeStr: string): string {
    return typeStr
        .replace(/\b([A-Z][A-Za-z0-9]*)\b/g, (match) =>
            normalizeTypeName(match)
        )
        .replace(/\s+/g, ' ')
        .trim();
}
// 从类型节点提取属性列表（递归处理嵌套对象）
function extractPropertiesFromType(typeNode: Node): string[] {
    const props: string[] = [];

    // 处理 { a: string, b: number } 这种字面量对象类型
    if (Node.isTypeLiteral(typeNode)) {
        for (const member of typeNode.getMembers()) {
            if (Node.isPropertySignature(member)) {
                const name = member.getName();
                const typeNode = member.getTypeNode();
                const typeStr = typeNode
                    ? normalizeTypeString(typeNode.getText())
                    : '$unknown';
                const optional = member.hasQuestionToken() ? '?' : '';
                props.push(`${name}${optional}:${typeStr}`);
            }
        }
    }

    // 处理交叉类型 A & B
    if (Node.isIntersectionTypeNode(typeNode)) {
        for (const member of typeNode.getChildren()) {
            if (Node.isTypeLiteral(member)) {
                props.push(...extractPropertiesFromType(member));
            }
        }
    }

    return props;
}

// ─────────────────────────────────────────────
// normalizeNode：递归遍历 AST，输出标准化字符串
// ─────────────────────────────────────────────
export function normalizeNode(node: Node): string {
    const paramNames = new Map<string, string>();
    let paramIdx = 0;

    function allocParam(name: string): string {
        if (!paramNames.has(name)) paramNames.set(name, `$p${paramIdx++}`);
        return paramNames.get(name)!;
    }

    function visit(n: Node): string {
        const kind = n.getKind();

        // 函数体 → {}（不关心实现）
        if (kind === SyntaxKind.Block) return '{}';

        // 参数：只保留类型，去参数名
        if (Node.isParameterDeclaration(n)) {
            const nameNode = n.getNameNode();
            const typeNode = n.getTypeNode();
            const typeStr = typeNode
                ? normalizeTypeString(typeNode.getText())
                : '$unknown';
            const prefix = n.isRestParameter() ? '...' : '';
            const suffix = n.hasInitializer() ? '=$default' : '';

            // 解构参数：{ userId, options }: Config → {}:Config
            if (
                Node.isObjectBindingPattern(nameNode) ||
                Node.isArrayBindingPattern(nameNode)
            ) {
                return `${prefix}{}:${typeStr}${suffix}`;
            }
            allocParam(n.getName());
            return `${prefix}$p:${typeStr}${suffix}`;
        }

        // 泛型参数：T / TData → $T
        if (Node.isTypeParameterDeclaration(n)) {
            const constraint = n.getConstraint();
            return `$T${constraint ? ` extends ${normalizeTypeString(constraint.getText())}` : ''}`;
        }

        // 类型引用：标准化名称
        if (Node.isTypeReference(n)) return normalizeTypeString(n.getText());

        // JSX：只记录存在
        if (Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n))
            return '<JSX/>';

        // 字面量 → 占位符
        if (kind === SyntaxKind.StringLiteral) return '"$s"';
        if (
            kind === SyntaxKind.NumericLiteral ||
            kind === SyntaxKind.BigIntLiteral
        )
            return '$n';
        if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword)
            return '$b';

        const children = n.getChildren();
        if (children.length === 0) return n.getText();
        return children.map(visit).join('');
    }

    return visit(node).replace(/\s+/g, ' ').trim();
}
function normalizeParameter(
    param: ParameterDeclaration,
    index: number
): string {
    const typeNode = param.getTypeNode();
    const typeStr = typeNode
        ? normalizeTypeWithStructure(typeNode)
        : '$unknown';
    const prefix = param.isRestParameter() ? '...' : '';
    const suffix = param.hasInitializer() ? '=$default' : '';

    const nameNode = param.getNameNode();
    // 解构参数：{ id, opts }: Config → { id: $d, opts: $d }:{id:xx, opts:xx}
    if (
        Node.isObjectBindingPattern(nameNode) ||
        Node.isArrayBindingPattern(nameNode)
    ) {
        const elements = nameNode.getElements();
        const destrProps: string[] = [];

        for (const el of elements) {
            if (Node.isOmittedExpression(el)) continue;

            const elAny = el as any;
            const name = elAny.getName?.() ?? 'unknown';

            // 检查是否有问号（可选属性）
            const hasQ = el
                .getChildren()
                .some((c) => c.getKind() === SyntaxKind.QuestionToken);

            // 检查是否有默认值，有则使用默认值的类型
            const initializer = el.getInitializer();
            let valueType: string;
            if (initializer) {
                // 用初始值表达式的类型
                valueType = normalizeTypeWithStructure(initializer);
            } else {
                valueType = '$d';
            }

            destrProps.push(`${name}${hasQ ? '?' : ''}:${valueType}`);
        }

        // 排序 key
        destrProps.sort();

        return `${prefix}{${destrProps.join(',')}}:${typeStr}${suffix}`;
    }

    return `${prefix}$p${index}:${typeStr}${suffix}`;
}

function normalizeTypeWithStructure(typeNode: Node): string {
    // 如果是类型字面量 { name: string, age: number }
    if (Node.isTypeLiteral(typeNode)) {
        const props = typeNode
            .getMembers()
            .filter(Node.isPropertySignature)
            .map((prop) => {
                const propTypeNode = prop.getTypeNode();
                const propType = propTypeNode
                    ? normalizeTypeWithStructure(propTypeNode)
                    : '$unknown';
                return `${prop.getName()}${prop.hasQuestionToken() ? '?' : ''}:${propType}`;
            });

        return `{${props.join(',')}}`;
    }

    // 如果是类型引用（e.g. Param, Array<string>, Promise<User>）
    if (Node.isTypeReference(typeNode)) {
        const typeName = typeNode.getTypeName().getText();

        // 优先处理泛型参数（不管是否在白名单中）
        const typeArgs = typeNode.getTypeArguments();
        if (typeArgs.length > 0) {
            const normalizedArgs = typeArgs.map((arg) =>
                normalizeTypeWithStructure(arg)
            );
            return `${typeName}<${normalizedArgs.join(',')}>`;
        }

        // 没有泛型参数时，检查是否是基础类型
        if (BUILTIN_TYPES.has(typeName)) {
            return typeName;
        }

        // 无泛型的类型引用，尝试解析实际类型
        try {
            const type = typeNode.getType();
            const symbol = type.getSymbol();
            if (symbol) {
                const declarations = symbol.getDeclarations();
                if (declarations.length > 0) {
                    const decl = declarations[0];
                    // 如果是接口声明，递归处理
                    if (Node.isInterfaceDeclaration(decl)) {
                        const props = decl.getProperties().map((prop) => {
                            const propTypeNode = prop.getTypeNode();
                            const propType = propTypeNode
                                ? normalizeTypeWithStructure(propTypeNode)
                                : '$unknown';
                            return `${prop.getName()}${prop.hasQuestionToken() ? '?' : ''}:${propType}`;
                        });
                        return `{${props.join(',')}}`;
                    }
                    // 如果是类型别名
                    if (Node.isTypeAliasDeclaration(decl)) {
                        const aliasedType = decl.getTypeNode();
                        if (aliasedType) {
                            return normalizeTypeWithStructure(aliasedType);
                        }
                    }
                }
            }
        } catch (e) {
            // 解析失败，回退到类型名
        }

        return typeName;
    }

    // 其他情况（联合类型、交叉类型、基础类型等）
    return normalizeTypeString(typeNode.getText());
}

export function extractNormalizedSignature(node: Node): string {
    // 函数声明 / 箭头函数 / 函数表达式
    if (
        Node.isFunctionDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node)
    ) {
        const typeParams = Node.isFunctionDeclaration(node)
            ? node.getTypeParameters().map((tp) => normalizeNode(tp))
            : [];
        const params = node
            .getParameters()
            .sort()
            .map((p, i) => normalizeParameter(p, i));
        console.error('===params', params, typeParams);
        const retNode = node.getReturnTypeNode?.();
        const returnType = retNode
            ? normalizeTypeString(retNode.getText())
            : '$inferred';
        const tpStr = typeParams.length ? `<${typeParams.join(',')}>` : '';
        return `fn${tpStr}(${params.join(',')})=>${returnType}`;
    }

    // 变量声明（const foo = () => {}）
    if (Node.isVariableDeclaration(node)) {
        const init = node.getInitializer();
        if (
            init &&
            (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
        ) {
            return extractNormalizedSignature(init);
        }
        return normalizeNode(node);
    }
    // interface：提取所有属性，模板化名称
    if (Node.isInterfaceDeclaration(node)) {
        const props = node.getProperties().map((prop) => {
            const typeNode = prop.getTypeNode();
            const typeStr = typeNode
                ? normalizeTypeString(typeNode.getText())
                : '$unknown';
            const optional = prop.hasQuestionToken() ? '?' : '';
            return `${prop.getName()}${optional}:${typeStr}`;
        });
        const extendsClause = node.getExtends();
        const extendsStr = extendsClause.length
            ? ` extends ${extendsClause.map((e) => normalizeTypeString(e.getText())).join(',')}`
            : '';
        return `interface{${props.sort().join(';')}}${extendsStr}`;
    }

    // type alias（对象类型）：提取结构化信息
    if (Node.isTypeAliasDeclaration(node)) {
        const typeNode = node.getTypeNode();
        if (typeNode) {
            // 处理 type Foo = { ... }
            const props = extractPropertiesFromType(typeNode);
            if (props.length > 0) {
                return `type{${props.sort().join(';')}}`;
            }
        }
        return normalizeNode(node);
    }

    // class：只取方法签名列表
    if (Node.isClassDeclaration(node)) {
        const methods = node
            .getMethods()
            .sort()
            .map((m) => {
                const params = m
                    .getParameters()
                    .sort()
                    .map((p) => normalizeNode(p));
                const retNode = m.getReturnTypeNode();
                const ret = retNode
                    ? normalizeTypeString(retNode.getText())
                    : '$inferred';
                return `${m.getName()}(${params.sort().join(',')})=>${ret}`;
            });
        return `class{${methods.join(';')}}`;
    }

    return normalizeNode(node);
}

// ─────────────────────────────────────────────
// computeSemanticHash
// 纳入：标准化签名 + name + type + description + sideEffects + hooks
// 排除：参数名、实现、格式、callers/callees
// ─────────────────────────────────────────────
export function computeSemanticHash(
    row: Pick<CodeSymbol, 'name' | 'type' | 'description' | 'meta'> & {
        node?: Node;
    }
): string {
    const node = row.node || null;
    const meta = row.meta || {};
    const stable = {
        name: row.name,
        type: row.type,
        description: row.description ?? null,
        signature: node ? extractNormalizedSignature(node) : '',
        sideEffects: [
            ...((meta.sideEffects as string[] | undefined) ?? []),
        ].sort(),
        hooks: [...((meta.hooks as string[] | undefined) ?? [])].sort(),
    };
    // console.error('==computeSemanticHash stable object:', stable);
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// ─────────────────────────────────────────────
// computeFileHash：对文件原始内容
// ─────────────────────────────────────────────
export function computeFileHash(fileContent: string): string {
    return createHash('sha256').update(fileContent).digest('hex');
}
