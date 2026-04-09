/**
 * 从 AST 抽取写入 `symbols.meta` 的结构化字段（props/params、hooks、返回值、类型成员等）。
 */
import {
    Node,
    SyntaxKind,
    type ArrowFunction,
    type FunctionDeclaration,
    type FunctionExpression,
} from 'ts-morph';

/**
 * 将节点收窄为可调用的函数形态，便于统一抽取参数与函数体。
 * @returns 若不是函数声明/表达式/箭头函数则为 `undefined`。
 */
function asFn(
    node: Node
): FunctionDeclaration | FunctionExpression | ArrowFunction | undefined {
    if (Node.isFunctionDeclaration(node)) return node;
    if (Node.isFunctionExpression(node)) return node;
    if (Node.isArrowFunction(node)) return node;
    return undefined;
}

/**
 * 取第一个形参的「对外可见名」：对象解构取各属性名，单参数取标识符文本。
 * @returns 用于后续在 `component` 中映射为 `props`，在 `util` 中保留为 `params`。
 */
function extractParamNames(
    fn: FunctionDeclaration | FunctionExpression | ArrowFunction
): string[] {
    const params = fn.getParameters();
    if (params.length === 0) return [];
    const first = params[0];
    const nameNode = first.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
        return nameNode.getElements().map((el) => el.getName());
    }
    if (Node.isIdentifier(nameNode)) {
        return [nameNode.getText()];
    }
    return [];
}

/**
 * 从第一个参数的类型信息提取字段名（例如 `props: DialogProps` -> `title/content/onClose`）。
 * @returns 若无可解析类型或无法安全推断，则返回空数组。
 */
function extractParamTypeFieldNames(
    fn: FunctionDeclaration | FunctionExpression | ArrowFunction
): string[] {
    const params = fn.getParameters();
    if (params.length === 0) return [];
    const first = params[0];
    const type = first.getType();
    const properties = type.getProperties();
    if (!properties.length) return [];
    const names = properties.map((p) => p.getName());
    // 防止出现泛型对象原型噪音字段。
    return names.filter((n) => n !== '__type');
}

/**
 * 在函数体内收集形如 `useXxx(...)` 的调用名（React Hooks 约定）。
 * @returns 去重、排序后的钩子名列表，写入 `meta.hooks`；无则为空数组。
 */
export function extractHooksFromBody(node: Node): string[] {
    const seen = new Set<string>();
    node.forEachDescendant((n) => {
        if (Node.isCallExpression(n)) {
            const ex = n.getExpression();
            if (Node.isIdentifier(ex)) {
                const id = ex.getText();
                if (id.startsWith('use')) seen.add(id);
            }
        }
    });
    return [...seen].sort();
}

/**
 * 读取显式标注的返回类型节点文本（无则 `null`）。
 * @returns 写入 `meta.returnType`，供检索与对比工具函数签名。
 */
export function extractReturnTypeText(
    fn: FunctionDeclaration | FunctionExpression | ArrowFunction
): string | null {
    const rt = fn.getReturnTypeNode();
    return rt ? rt.getText() : null;
}

/**
 * 汇总单个可调用代码块的元数据：`params`、可选 `hooks`、可选 `returnType`、可选 `sideEffects`。
 * @returns 扁平对象，由上层按 `component`/`util` 再映射为 `props` 或保留 `params`。
 */
export function extractFunctionMeta(
    fn: FunctionDeclaration | FunctionExpression | ArrowFunction
): Record<string, unknown> {
    const params = extractParamNames(fn);
    const paramTypeFields = extractParamTypeFieldNames(fn);
    const hooks = extractHooksFromBody(fn);
    const returnType = extractReturnTypeText(fn);
    const sideEffects = extractSideEffects(fn);
    return {
        params,
        ...(paramTypeFields.length ? { paramTypeFields } : {}),
        ...(hooks.length ? { hooks } : {}),
        ...(returnType ? { returnType } : {}),
        ...(sideEffects.length ? { sideEffects } : {}),
    };
}

/**
 * 若节点本身是函数声明/表达式/箭头函数，则抽取 `extractFunctionMeta` 结果。
 * @returns 非可调用节点时为 `null`。
 */
export function extractMetaFromCallable(
    node: Node
): Record<string, unknown> | null {
    const fn = asFn(node);
    if (!fn) return null;
    return extractFunctionMeta(fn);
}

/**
 * 为 `interface` / `type` 代码块构造 `meta`：`interface` 带属性名列表，别名仅标记 `typeAlias`。
 * @returns 写入 `symbols.meta`，供结构化搜索（如按属性名）扩展使用。
 */
export function extractInterfaceOrTypeMeta(
    node: Node
): Record<string, unknown> {
    if (Node.isInterfaceDeclaration(node)) {
        const props = node.getProperties().map((p) => p.getName());
        return { kind: 'interface', properties: props };
    }
    if (Node.isTypeAliasDeclaration(node)) {
        return { kind: 'typeAlias' };
    }
    return { kind: 'unknown' };
}

/** 副作用类型 */
export type SideEffectType =
    | 'network' // 网络请求：fetch/axios/xhr
    | 'timer' // 计时器：setTimeout/setInterval/requestAnimationFrame
    | 'dom' // DOM 操作：document./window. 操作
    | 'storage' // 存储操作：localStorage/sessionStorage/cookies
    | 'mutation'; // 入参修改：直接修改传入的对象/数组

/**
 * 静态分析函数体的副作用。
 * @returns 副作用类型数组，去重排序后写入 `meta.sideEffects`。
 */
export function extractSideEffects(
    node: Node
): SideEffectType[] {
    const effects = new Set<SideEffectType>();

    // 1. 检测网络请求
    node.forEachDescendant((n) => {
        if (Node.isCallExpression(n)) {
            const expr = n.getExpression();
            const text = expr.getText().toLowerCase();
            // fetch、axios、xhr、ajax、superagent 等
            if (
                text === 'fetch' ||
                text === 'axios' ||
                text === 'xhr' ||
                text === 'ajax' ||
                text.startsWith('axios.') ||
                text.includes('request')
            ) {
                effects.add('network');
            }
            // XMLHttpRequest
            if (text.includes('xmlhttprequest')) {
                effects.add('network');
            }
        }
    });

    // 2. 检测计时器
    node.forEachDescendant((n) => {
        if (Node.isCallExpression(n)) {
            const text = n.getExpression().getText();
            if (
                text === 'setTimeout' ||
                text === 'setInterval' ||
                text === 'requestAnimationFrame' ||
                text === 'setImmediate'
            ) {
                effects.add('timer');
            }
        }
    });

    // 3. 检测 DOM / 全局对象操作
    node.forEachDescendant((n) => {
        if (Node.isExpressionStatement(n)) {
            const text = n.getText();
            // document. / window. 开头的赋值或调用
            if (
                /\bdocument\.\w+/.test(text) ||
                /\bwindow\.\w+/.test(text) ||
                /\bnavigator\.\w+/.test(text) ||
                /\blocation\.\w+/.test(text)
            ) {
                // 区分读取和写入
                if (/=/.test(text) && !text.includes('===') && !text.includes('==')) {
                    effects.add('dom');
                }
            }
        }
    });

    // 4. 检测存储操作
    node.forEachDescendant((n) => {
        if (Node.isCallExpression(n)) {
            const text = n.getExpression().getText();
            if (
                text.includes('localStorage') ||
                text.includes('sessionStorage') ||
                text.includes('cookie')
            ) {
                effects.add('storage');
            }
        }
    });

    // 5. 检测入参修改（检测 mutation pattern）
    // 如 props.items.push(...), obj.x = ...
    const params = node.getKind() === SyntaxKind.FunctionDeclaration
        ? (node as FunctionDeclaration).getParameters()
        : node.getKind() === SyntaxKind.ArrowFunction
            ? (node as ArrowFunction).getParameters()
            : node.getKind() === SyntaxKind.FunctionExpression
                ? (node as FunctionExpression).getParameters()
                : [];

    if (params.length > 0) {
        const paramNames = new Set(params.map((p) => p.getName()));
        node.forEachDescendant((n) => {
            if (Node.isExpressionStatement(n)) {
                const text = n.getText();
                // 检测 param.x = ... 或 param.push/pop/splice 等
                for (const param of paramNames) {
                    if (text.includes(`${param}.`) || text.startsWith(`${param} =`)) {
                        effects.add('mutation');
                        break;
                    }
                }
            }
        });
    }

    return [...effects].sort();
}
