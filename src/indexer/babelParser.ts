/**
 * 使用 Babel 解析 JS/JSX 文件，提取导出声明以及无导出文件中的所有函数/类
 */
import * as babelParser from '@babel/parser';
import * as bt from '@babel/types';
import type { SymbolType } from '../types/symbol.js';
import type { IndexedSymbolRow } from './indexProject.js';
import {
    getRelativePathForDisplay,
    inferCategoryFromPath,
} from './heuristics.js';

/** 从 JS 文件内容解析导出的代码块 */
export function parseJsFile(
    filePath: string,
    content: string,
    projectRoot: string
): IndexedSymbolRow[] {
    const out: IndexedSymbolRow[] = [];
    const isJsx = filePath.endsWith('.jsx') || filePath.endsWith('.tsx');

    let ast: bt.File;
    try {
        ast = babelParser.parse(content, {
            sourceType: 'module',
            plugins: [
                'jsx',
                'typescript',
                'classPrivateMethods',
                'classPrivateProperties',
                'decorators-legacy',
                'doExpressions',
                'exportDefaultFrom',
                'functionBind',
                'logicalAssignment',
                'nullishCoalescingOperator',
                'objectRestSpread',
                'optionalChaining',
                'optionalCatchBinding',
            ],
            strictMode: false,
        });
    } catch (e) {
        console.error(`[babelParser] Failed to parse ${filePath}:`, e);
        return [];
    }

    // 第一轮：处理所有导出声明
    for (const stmt of ast.program.body) {
        const rows = processStatement(stmt, filePath, isJsx, projectRoot);
        out.push(...rows);
    }

    // 第二轮：如果没有任何导出，则扫描所有函数/类
    if (out.length === 0) {
        for (const stmt of ast.program.body) {
            const rows = scanAllDeclarations(
                stmt,
                filePath,
                isJsx,
                projectRoot
            );
            out.push(...rows);
        }
    }

    return out;
}

/** 处理导出的声明 */
function processStatement(
    stmt: bt.Statement,
    filePath: string,
    isJsx: boolean,
    projectRoot: string
): IndexedSymbolRow[] {
    const out: IndexedSymbolRow[] = [];

    // 处理命名导出: export function Foo() {}
    if (bt.isExportNamedDeclaration(stmt)) {
        const decl = stmt.declaration;
        if (!decl) return out;

        if (bt.isFunctionDeclaration(decl)) {
            const name = decl.id?.name;
            if (name) {
                out.push(
                    createRowFromFunction(
                        name,
                        decl,
                        filePath,
                        projectRoot,
                        isJsx
                    )
                );
            }
        } else if (bt.isClassDeclaration(decl)) {
            const name = decl.id?.name;
            if (name) {
                out.push(createRowFromClass(name, decl, filePath, projectRoot));
            }
        } else if (bt.isVariableDeclaration(decl)) {
            for (const declarator of decl.declarations) {
                if (
                    bt.isVariableDeclarator(declarator) &&
                    declarator.id &&
                    bt.isIdentifier(declarator.id)
                ) {
                    const name = declarator.id.name;
                    const init = declarator.init;
                    if (
                        name &&
                        (bt.isArrowFunctionExpression(init) ||
                            bt.isFunctionExpression(init))
                    ) {
                        const fnDecl = arrowToFunction(name, init);
                        out.push(
                            createRowFromFunction(
                                name,
                                fnDecl,
                                filePath,
                                projectRoot,
                                isJsx
                            )
                        );
                    }
                }
            }
        }
    }
    // 处理 module.exports = xxx
    else if (bt.isExpressionStatement(stmt)) {
        const expr = stmt.expression;
        if (
            bt.isAssignmentExpression(expr) &&
            bt.isMemberExpression(expr.left)
        ) {
            const left = expr.left;
            // module.exports = xxx
            if (
                bt.isIdentifier(left.object) &&
                left.object.name === 'module' &&
                bt.isIdentifier(left.property) &&
                left.property.name === 'exports'
            ) {
                const right = expr.right;
                if (bt.isObjectExpression(right)) {
                    for (const prop of right.properties) {
                        if (
                            bt.isObjectProperty(prop) &&
                            bt.isIdentifier(prop.key)
                        ) {
                            const name = prop.key.name;
                            const value = prop.value;
                            if (
                                bt.isFunctionExpression(value) ||
                                bt.isArrowFunctionExpression(value)
                            ) {
                                const fnDecl = arrowToFunction(
                                    name,
                                    bt.isArrowFunctionExpression(value)
                                        ? value
                                        : value
                                );
                                out.push(
                                    createRowFromFunction(
                                        name,
                                        fnDecl,
                                        filePath,
                                        projectRoot,
                                        isJsx
                                    )
                                );
                            }
                        }
                    }
                } else if (bt.isFunctionExpression(right)) {
                    const fnDecl = arrowToFunction('default', right);
                    out.push(
                        createRowFromFunction(
                            'default',
                            fnDecl,
                            filePath,
                            projectRoot,
                            isJsx
                        )
                    );
                } else if (bt.isArrowFunctionExpression(right)) {
                    const fnDecl = arrowToFunction('default', right);
                    out.push(
                        createRowFromFunction(
                            'default',
                            fnDecl,
                            filePath,
                            projectRoot,
                            isJsx
                        )
                    );
                }
            }
            // exports.xxx = xxx
            else if (
                bt.isIdentifier(left.object) &&
                left.object.name === 'exports'
            ) {
                const name = bt.isIdentifier(left.property)
                    ? left.property.name
                    : null;
                if (name) {
                    const right = expr.right;
                    if (
                        bt.isFunctionExpression(right) ||
                        bt.isArrowFunctionExpression(right)
                    ) {
                        const fnDecl = arrowToFunction(
                            name,
                            bt.isArrowFunctionExpression(right) ? right : right
                        );
                        out.push(
                            createRowFromFunction(
                                name,
                                fnDecl,
                                filePath,
                                projectRoot,
                                isJsx
                            )
                        );
                    }
                }
            }
        }
    }
    // 处理默认导出
    else if (bt.isExportDefaultDeclaration(stmt)) {
        const decl = stmt.declaration;
        if (bt.isFunctionDeclaration(decl)) {
            const name = decl.id?.name || 'default';
            out.push(
                createRowFromFunction(name, decl, filePath, projectRoot, isJsx)
            );
        } else if (bt.isClassDeclaration(decl)) {
            const name = decl.id?.name || 'default';
            out.push(createRowFromClass(name, decl, filePath, projectRoot));
        } else if (bt.isArrowFunctionExpression(decl)) {
            const fnDecl = arrowToFunction('default', decl);
            out.push(
                createRowFromFunction(
                    'default',
                    fnDecl,
                    filePath,
                    projectRoot,
                    isJsx
                )
            );
        } else if (bt.isFunctionExpression(decl)) {
            const fnDecl = arrowToFunction('default', decl);
            out.push(
                createRowFromFunction(
                    'default',
                    fnDecl,
                    filePath,
                    projectRoot,
                    isJsx
                )
            );
        }
    }

    return out;
}

/** 扫描无导出文件中的所有声明 */
function scanAllDeclarations(
    stmt: bt.Statement,
    filePath: string,
    isJsx: boolean,
    projectRoot: string
): IndexedSymbolRow[] {
    const out: IndexedSymbolRow[] = [];

    // 函数声明: function foo() {}
    if (bt.isFunctionDeclaration(stmt)) {
        const name = stmt.id?.name;
        if (name) {
            out.push(
                createRowFromFunction(name, stmt, filePath, projectRoot, isJsx)
            );
        }
    }
    // 类声明: class Foo {}
    else if (bt.isClassDeclaration(stmt)) {
        const name = stmt.id?.name;
        if (name) {
            out.push(createRowFromClass(name, stmt, filePath, projectRoot));
        }
    }
    // 变量声明: const foo = () => {}, const bar = function() {}
    else if (bt.isVariableDeclaration(stmt)) {
        for (const declarator of stmt.declarations) {
            if (
                bt.isVariableDeclarator(declarator) &&
                declarator.id &&
                bt.isIdentifier(declarator.id)
            ) {
                const name = declarator.id.name;
                const init = declarator.init;
                if (
                    name &&
                    (bt.isArrowFunctionExpression(init) ||
                        bt.isFunctionExpression(init))
                ) {
                    const fnDecl = arrowToFunction(name, init);
                    out.push(
                        createRowFromFunction(
                            name,
                            fnDecl,
                            filePath,
                            projectRoot,
                            isJsx
                        )
                    );
                }
            }
        }
    }

    return out;
}

/** 将 ArrowFunctionExpression 或 FunctionExpression 转换为 FunctionDeclaration */
function arrowToFunction(
    name: string,
    arrow: bt.ArrowFunctionExpression | bt.FunctionExpression
): bt.FunctionDeclaration {
    const body = arrow.body;
    const blockBody: bt.BlockStatement = bt.isBlockStatement(body)
        ? body
        : bt.blockStatement([bt.returnStatement(body)]);

    return {
        type: 'FunctionDeclaration',
        id: { type: 'Identifier', name },
        params: arrow.params,
        body: blockBody,
        generator: false,
        async: arrow.async,
        returnType: arrow.returnType,
        typeParameters: arrow.typeParameters,
    };
}

function createRowFromFunction(
    name: string,
    decl: bt.FunctionDeclaration,
    filePath: string,
    projectRoot: string,
    isJsx: boolean
): IndexedSymbolRow {
    const relPath = getRelativePathForDisplay(projectRoot, filePath);
    const category = inferCategoryFromPath(filePath);

    // 检测是否有 JSX
    const hasJsx = isJsx || containsJsx(decl);

    // 判断类型：
    // 1. 有 JSX = component
    // 2. 名字包含 selector = selector
    // 3. 大写开头（JSX 组件约定）= component
    // 4. 其他 = util
    const type: SymbolType = hasJsx
        ? 'component'
        : name.toLowerCase().includes('selector')
          ? 'selector'
          : isJsx && /^[A-Z]/.test(name)
            ? 'component'
            : 'util';

    const params = decl.params
        .filter((p): p is bt.Identifier => bt.isIdentifier(p))
        .map((p) => p.name);

    const hooks = extractHooksFromBody(decl);
    const sideEffects = extractSideEffects(decl);

    return {
        name,
        type,
        category,
        path: relPath,
        description: null,
        content: `function ${decl.id?.name || 'anonymous'}(${params.join(', ')}) { ... }`,
        meta: {
            kind: 'function',
            params,
            returnType: getReturnType(decl),
            ...(hooks.length ? { hooks } : {}),
            ...(sideEffects.length ? { sideEffects } : {}),
        },
    };
}

function createRowFromClass(
    name: string,
    _decl: bt.ClassDeclaration,
    filePath: string,
    projectRoot: string
): IndexedSymbolRow {
    const relPath = getRelativePathForDisplay(projectRoot, filePath);
    const category = inferCategoryFromPath(filePath);

    // 大写开头的类视为组件
    const type: SymbolType = /^[A-Z]/.test(name) ? 'component' : 'util';

    return {
        name,
        type,
        category,
        path: relPath,
        description: null,
        content: null,
        meta: { kind: 'class' },
    };
}

/** 简单检测是否包含 JSX */
function containsJsx(node: bt.Node): boolean {
    const jsxTags = ['JSXElement', 'JSXFragment'];
    let found = false;

    const visit = (n: bt.Node): void => {
        if (jsxTags.includes(n.type)) {
            found = true;
            return;
        }
        // 只遍历常见的包含子节点的属性
        const keys = [
            'body',
            'declarations',
            'arguments',
            'callee',
            'init',
            'left',
            'right',
            'consequent',
            'alternate',
        ];
        for (const key of keys) {
            const val = (n as unknown as Record<string, unknown>)[key];
            if (Array.isArray(val)) {
                for (const v of val) {
                    if (v && typeof v === 'object' && 'type' in v) {
                        visit(v as unknown as bt.Node);
                    }
                }
            } else if (val && typeof val === 'object' && 'type' in val) {
                visit(val as unknown as bt.Node);
            }
        }
    };

    visit(node);
    return found;
}

function getReturnType(fn: bt.FunctionDeclaration): string | undefined {
    if (!fn.returnType) return undefined;
    const rt = fn.returnType;
    if (bt.isTSTypeAnnotation(rt)) {
        const inner = rt.typeAnnotation;
        if (bt.isTSStringKeyword(inner)) return 'string';
        if (bt.isTSNumberKeyword(inner)) return 'number';
        if (bt.isTSBooleanKeyword(inner)) return 'boolean';
        if (bt.isTSVoidKeyword(inner)) return 'void';
        if (bt.isTSAnyKeyword(inner)) return 'any';
        if (bt.isTSUnknownKeyword(inner)) return 'unknown';
        if (bt.isTSNullKeyword(inner)) return 'null';
    }
    return undefined;
}

/** 副作用类型 */
type SideEffectType = 'network' | 'timer' | 'dom' | 'storage' | 'mutation';

/**
 * 遍历 Babel AST 节点，收集所有满足条件的回调
 */
function visitNodes(node: bt.Node, callback: (n: bt.Node) => void): void {
    callback(node);
    for (const key of Object.keys(node)) {
        const val = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(val)) {
            for (const v of val) {
                if (v && typeof v === 'object' && 'type' in v) {
                    visitNodes(v as bt.Node, callback);
                }
            }
        } else if (val && typeof val === 'object' && 'type' in val) {
            visitNodes(val as bt.Node, callback);
        }
    }
}

/**
 * 从函数体中提取 React Hooks（use 开头的函数调用）
 */
function extractHooksFromBody(fn: bt.FunctionDeclaration): string[] {
    const seen = new Set<string>();
    const body = fn.body;
    if (!body || !bt.isBlockStatement(body)) return [];

    visitNodes(body, (n) => {
        if (bt.isCallExpression(n)) {
            const callee = n.callee;
            if (bt.isIdentifier(callee) && callee.name.startsWith('use')) {
                seen.add(callee.name);
            }
        }
    });
    return [...seen].sort();
}

/**
 * 获取节点的文本表示（通过 AST 节点属性构建）
 */
function getNodeText(n: bt.Statement): string;
function getNodeText(n: bt.Expression): string;
function getNodeText(n: bt.Node): string {
    if (bt.isMemberExpression(n)) {
        const obj = getNodeText(n.object as bt.Expression);
        const prop = bt.isIdentifier(n.property) ? n.property.name : (bt.isLiteral(n.property) ? String(n.property.value) : '');
        return obj + (n.computed ? `[${prop}]` : `.${prop}`);
    }
    if (bt.isIdentifier(n)) {
        return n.name;
    }
    if (bt.isLiteral(n)) {
        return String(n.value);
    }
    if (bt.isCallExpression(n)) {
        return getNodeText(n.callee as bt.Expression) + '(...)';
    }
    if (bt.isAssignmentExpression(n)) {
        return getNodeText(n.left) + ' = ...';
    }
    return '';
}

/**
 * 静态分析函数体的副作用
 */
function extractSideEffects(fn: bt.FunctionDeclaration): SideEffectType[] {
    const effects = new Set<SideEffectType>();
    const body = fn.body;
    if (!body || !bt.isBlockStatement(body)) return [];

    const paramNames = new Set(
        fn.params
            .filter((p): p is bt.Identifier => bt.isIdentifier(p))
            .map((p) => p.name)
    );

    visitNodes(body, (n) => {
        // 1. 网络请求
        if (bt.isCallExpression(n)) {
            const calleeText =
                n.callee && 'name' in n.callee
                    ? (n.callee as bt.Identifier).name
                    : '';
            const calleeTextLower = calleeText.toLowerCase();
            if (
                calleeTextLower === 'fetch' ||
                calleeTextLower === 'axios' ||
                calleeTextLower === 'xhr' ||
                calleeTextLower === 'ajax' ||
                calleeText.startsWith('axios.') ||
                calleeTextLower.includes('request')
            ) {
                effects.add('network');
            }
            if (calleeTextLower.includes('xmlhttprequest')) {
                effects.add('network');
            }
        }

        // 2. 计时器
        if (bt.isCallExpression(n)) {
            const calleeName =
                n.callee && 'name' in n.callee
                    ? (n.callee as bt.Identifier).name
                    : '';
            if (
                calleeName === 'setTimeout' ||
                calleeName === 'setInterval' ||
                calleeName === 'requestAnimationFrame' ||
                calleeName === 'setImmediate'
            ) {
                effects.add('timer');
            }
        }

        // 3. DOM/全局对象操作
        if (bt.isExpressionStatement(n)) {
            const text = getNodeText(n.expression);
            if (
                /\bdocument\.\w+/.test(text) ||
                /\bwindow\.\w+/.test(text) ||
                /\bnavigator\.\w+/.test(text) ||
                /\blocation\.\w+/.test(text)
            ) {
                if (
                    /=/.test(text) &&
                    !text.includes('===') &&
                    !text.includes('==')
                ) {
                    effects.add('dom');
                }
            }
        }

        // 4. 存储操作
        if (bt.isCallExpression(n)) {
            const text = getNodeText(n as bt.Statement as bt.Expression);
            if (
                text.includes('localStorage') ||
                text.includes('sessionStorage') ||
                text.includes('cookie')
            ) {
                effects.add('storage');
            }
        }

        // 5. 入参修改
        if (bt.isAssignmentExpression(n)) {
            const leftText = getNodeText(n.left);
            for (const param of paramNames) {
                if (
                    leftText.startsWith(`${param}.`) ||
                    leftText.startsWith(`${param}[`)
                ) {
                    effects.add('mutation');
                    break;
                }
            }
        }
        if (bt.isCallExpression(n) && n.callee) {
            const calleeText = getNodeText(n.callee as bt.Expression);
            for (const param of paramNames) {
                if (
                    calleeText.startsWith(`${param}.`) ||
                    calleeText.startsWith(`${param}[`)
                ) {
                    // 检测 push/pop/splice 等 mutations
                    if (
                        /\.(push|pop|shift|unshift|splice|sort|reverse|fill)\(/.test(
                            calleeText
                        )
                    ) {
                        effects.add('mutation');
                        break;
                    }
                }
            }
        }
    });

    return [...effects].sort();
}
