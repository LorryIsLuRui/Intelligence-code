/**
 * 扫描源码目录，用 ts-morph 解析 TS/TSX，Babel 解析 JS/JSX，生成待写入 MySQL 的代码块行。
 * 同时分析调用关系，填充 meta.callers / meta.callees。
 */

import fg from 'fast-glob';
import { join, resolve } from 'node:path';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { readFileSync, existsSync } from 'node:fs';
import type { SymbolType } from '../types/symbol.js';
import {
    extractFunctionMeta,
    extractInterfaceOrTypeMeta,
    extractMetaFromCallable,
} from './extractMeta.js';
import {
    getLeadingDocDescription,
    getRelativePathForDisplay,
    hasJsxInNode,
    inferCategoryFromPath,
    isSelectorLike,
    isTsxFile,
    snippetForNode,
} from './heuristics.js';
import { parseJsFile } from './babelParser.js';

/** 调用关系条目 */
interface SymbolRef {
    name: string;
    path: string;
}

/** 已收集的符号映射：key = "name|path"，用于快速查找 */
type SymbolMap = Map<string, { name: string; path: string; exports: Set<string> }>;

/** 判断文件类型 */
function isJsFile(filePath: string): boolean {
    return filePath.endsWith('.js') || filePath.endsWith('.jsx');
}

function isTsFile(filePath: string): boolean {
    return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

/** 单条索引结果，对应 `symbols` 表一行（尚未含自增 id / usage_count）。 */
export interface IndexedSymbolRow {
    /** 导出代码块名（含 default 解析后的真实名） */
    name: string;
    /** 设计文档中的技术类型：component / util / selector / type */
    type: SymbolType;
    /** 由路径推断的业务子目录，可为空 */
    category: string | null;
    /** 相对工程根的路径，入库与检索展示用 */
    path: string;
    /** JSDoc 摘要，对应 `description` */
    description: string | null;
    /** 声明源码片段，对应 `content` */
    content: string | null;
    /** JSON 扩展字段，对应 `meta` 列 */
    meta: Record<string, unknown>;
}

/**
 * 将 `extractFunctionMeta` 的 `params` 转为组件用的 `props` 名，或保留为 `params`。
 * @returns 供 `IndexedSymbolRow.meta` 序列化入库。
 */
function mergeCallableMeta(
    symbolType: SymbolType,
    raw: Record<string, unknown> | null
): Record<string, unknown> {
    if (!raw) return {};
    const params = raw.params as string[] | undefined;
    const paramTypeFields = raw.paramTypeFields as string[] | undefined;
    const { params: _p, paramTypeFields: _f, ...rest } = raw;
    if (symbolType === 'component' && params?.length) {
        const props = [
            ...new Set([...(paramTypeFields ?? []), ...params]),
        ].filter((name) => name.toLowerCase() !== 'props');
        return { ...rest, props: props.length ? props : params };
    }
    return { ...rest, ...(params?.length ? { params } : {}) };
}

/**
 * 将 MCP/ts 的 `default` 导出键还原为具体代码块名（函数名、变量名、类名）。
 * @returns 用于 `IndexedSymbolRow.name` 与去重键 `(path, name)`。
 */
function resolveExportName(exportName: string, decl: Node): string {
    if (exportName !== 'default') return exportName;
    if (Node.isFunctionDeclaration(decl) && decl.getName()) {
        return decl.getName()!;
    }
    if (Node.isVariableDeclaration(decl)) {
        return decl.getName();
    }
    if (Node.isClassDeclaration(decl) && decl.getName()) {
        return decl.getName()!;
    }
    return 'default';
}

/**
 * 将单个导出声明转为一条索引行；不支持的声明类型返回 `null`。
 * @returns 成功时含分类结果与 meta，供 `persistSymbols` 写入数据库。
 */
function processDeclaration(
    exportName: string,
    decl: Node,
    sf: SourceFile,
    projectRoot: string
): IndexedSymbolRow | null {
    const filePath = sf.getFilePath();
    const relPath = getRelativePathForDisplay(projectRoot, filePath);
    const category = inferCategoryFromPath(filePath);
    const name = resolveExportName(exportName, decl);
    const description = getLeadingDocDescription(decl) ?? null;

    if (
        Node.isInterfaceDeclaration(decl) ||
        Node.isTypeAliasDeclaration(decl)
    ) {
        const meta = extractInterfaceOrTypeMeta(decl);
        return {
            name,
            type: 'type',
            category,
            path: relPath,
            description,
            content: snippetForNode(decl),
            meta,
        };
    }

    if (Node.isFunctionDeclaration(decl)) {
        const jsx = isTsxFile(filePath) && hasJsxInNode(decl);
        const type: SymbolType = jsx
            ? 'component'
            : isSelectorLike(filePath, name)
              ? 'selector'
              : 'util';
        const raw = extractMetaFromCallable(decl);
        const meta = mergeCallableMeta(type, raw);
        return {
            name,
            type,
            category,
            path: relPath,
            description,
            content: snippetForNode(decl),
            meta,
        };
    }

    if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (!init) return null;

        let callable: Node | undefined;
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
            callable = init;
        } else if (Node.isCallExpression(init)) {
            const arg0 = init.getArguments()[0];
            if (
                arg0 &&
                (Node.isArrowFunction(arg0) || Node.isFunctionExpression(arg0))
            ) {
                callable = arg0;
            }
        }

        if (!callable) return null;

        const jsx = isTsxFile(filePath) && hasJsxInNode(callable);
        const type: SymbolType = jsx
            ? 'component'
            : isSelectorLike(filePath, name)
              ? 'selector'
              : 'util';
        const raw = extractMetaFromCallable(callable);
        const meta = mergeCallableMeta(type, raw);
        return {
            name,
            type,
            category,
            path: relPath,
            description,
            content: snippetForNode(callable),
            meta,
        };
    }

    if (Node.isClassDeclaration(decl)) {
        // 轻量：仅将 class 记为 util（后续可扩展为带 JSX 的组件类）
        return {
            name,
            type: 'util',
            category,
            path: relPath,
            description,
            content: snippetForNode(decl),
            meta: { kind: 'class' },
        };
    }

    return null;
}

export interface IndexProjectOptions {
    /** 工程根目录（绝对路径），用于解析 glob 与 tsconfig */
    projectRoot: string;
    /** 相对于 projectRoot 的 glob 列表；默认包含 `src` 下全部 `.ts` / `.tsx` */
    globPatterns?: string[];
    /** 额外忽略片段，会与内置 ignore（node_modules、dist 等）合并 */
    ignore?: string[];
}

const DEFAULT_IGNORE = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    '**/coverage/**',
    '**/build/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/vendor/**',
    '**/.cache/**',
    '**/.venv/**',
    '**/dist-srv/**',
    '**/.turbo/**',
];

/**
 * 按 glob 收集文件，用 ts-morph 加载并遍历每个文件的导出，生成全部代码块行。
 * 同时分析调用关系，填充 meta.callers / meta.callees。
 * @returns 数组可交给 `upsertSymbols`；无匹配文件时返回空数组（不写库）。
 */
export async function indexProject(
    opts: IndexProjectOptions
): Promise<IndexedSymbolRow[]> {
    const projectRoot = resolve(opts.projectRoot);
    const patterns = (opts.globPatterns ?? ['src/**/*.{ts,tsx}']).map((p) =>
        p.startsWith('/') ? p : join(projectRoot, p).replace(/\\/g, '/')
    );
    const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])];
    console.error(`[indexProject] patterns: ${patterns.join(', ')}`);
    const files = await fg(patterns, {
        // 根据pattern收集文件列表，支持绝对路径和相对路径（相对于projectRoot），并自动排除node_modules、dist等常见目录。
        absolute: true,
        ignore,
        onlyFiles: true,
        dot: false,
    });
    console.error(`[indexProject] found ${files.length} file(s)`);
    if (files.length === 0) {
        return [];
    }

    // 分离 TS/TSX 文件和 JS/JSX 文件
    const tsFiles = files.filter(isTsFile);
    const jsFiles = files.filter(isJsFile);

    const out: IndexedSymbolRow[] = [];
    const symbolMap: SymbolMap = new Map(); // name -> { name, path, exports }

    // 处理 TS/TSX 文件（只有 tsconfig.json 存在时才处理）
    const tsConfigPath = join(projectRoot, 'tsconfig.json');
    const hasTsConfig = existsSync(tsConfigPath);
    if (tsFiles.length > 0 && hasTsConfig) {
        const project = new Project({
            tsConfigFilePath: tsConfigPath,
            skipAddingFilesFromTsConfig: true,
            skipFileDependencyResolution: true,
        });

        project.addSourceFilesAtPaths(tsFiles);

        for (const sf of project.getSourceFiles()) {
            const relPath = getRelativePathForDisplay(projectRoot, sf.getFilePath());
            const exported = sf.getExportedDeclarations();
            for (const [exportName, decls] of exported) {
                for (const decl of decls) {
                    const row = processDeclaration(
                        exportName,
                        decl,
                        sf,
                        projectRoot
                    );
                    if (row) {
                        out.push(row);
                        // 建立符号映射
                        const key = `${row.name}|${row.path}`;
                        if (!symbolMap.has(key)) {
                            symbolMap.set(key, { name: row.name, path: row.path, exports: new Set() });
                        }
                        symbolMap.get(key)!.exports.add(exportName);
                    }
                }
            }
        }
    }

    // 处理 JS/JSX 文件
    for (const file of jsFiles) {
        try {
            const content = readFileSync(file, 'utf-8');
            const rows = parseJsFile(file, content, projectRoot);
            out.push(...rows);
            // 建立符号映射
            for (const row of rows) {
                const key = `${row.name}|${row.path}`;
                if (!symbolMap.has(key)) {
                    symbolMap.set(key, { name: row.name, path: row.path, exports: new Set() });
                }
                symbolMap.get(key)!.exports.add(row.name);
            }
        } catch (e) {
            console.error(`[indexProject] Failed to parse ${file}:`, e);
        }
    }

    // 分析调用关系，填充 meta.callers / meta.callees
    if (tsFiles.length > 0 && hasTsConfig) {
        const project = new Project({
            tsConfigFilePath: tsConfigPath,
            skipAddingFilesFromTsConfig: true,
            skipFileDependencyResolution: true,
        });
        project.addSourceFilesAtPaths(tsFiles);
        analyzeRelations(project, symbolMap, projectRoot, out);
    }

    return out;
}

/**
 * 分析调用关系，填充每个符号的 meta.callers 和 meta.callees
 */
function analyzeRelations(
    project: Project,
    symbolMap: SymbolMap,
    projectRoot: string,
    rows: IndexedSymbolRow[]
): void {
    // 构造快速查找：exportName -> [ {name, path} ]
    const exportToSymbol = new Map<string, { name: string; path: string }[]>();
    for (const [key, value] of symbolMap) {
        for (const exp of value.exports) {
            const list = exportToSymbol.get(exp) || [];
            list.push({ name: value.name, path: value.path });
            exportToSymbol.set(exp, list);
        }
    }

    // 收集所有 callers 和 callees
    const callersMap = new Map<string, Set<SymbolRef>>(); // key = "name|path" -> set of callers
    const calleesMap = new Map<string, Set<SymbolRef>>(); // key = "name|path" -> set of callees

    for (const sf of project.getSourceFiles()) {
        const filePath = sf.getFilePath();
        const relPath = getRelativePathForDisplay(projectRoot, filePath);

        // 获取当前文件导出的符号
        const exported = sf.getExportedDeclarations();
        const fileExportNames = new Set<string>();
        for (const [name, decls] of exported) {
            fileExportNames.add(name);
        }

        // 遍历 AST 查找调用
        sf.forEachDescendant((node) => {
            // 1. 函数调用
            if (Node.isCallExpression(node)) {
                const expr = node.getExpression();
                const name = Node.isIdentifier(expr) ? expr.getText() : null;
                if (name && exportToSymbol.has(name)) {
                    const targets = exportToSymbol.get(name)!;
                    // 当前文件是谁在调用
                    for (const [expName, decls] of exported) {
                        for (const decl of decls) {
                            const callerKey = `${expName}|${relPath}`;
                            for (const target of targets) {
                                // callees: 我调用了谁
                                const calleeSet = calleesMap.get(callerKey) || new Set();
                                calleeSet.add({ name: target.name, path: target.path });
                                calleesMap.set(callerKey, calleeSet);

                                // callers: 谁调用了我
                                const callerSet = callersMap.get(`${target.name}|${target.path}`) || new Set();
                                callerSet.add({ name: expName, path: relPath });
                                callersMap.set(`${target.name}|${target.path}`, callerSet);
                            }
                        }
                    }
                }
            }

            // 2. Import 导入
            if (Node.isImportDeclaration(node)) {
                const moduleSpec = node.getModuleSpecifier().getText();
                // 简单处理：只处理从 ./ 或 ../ 开始的相对导入
                if (moduleSpec.startsWith("'.") || moduleSpec.startsWith('".')) {
                    const importPath = moduleSpec.slice(1, -1); // 去掉引号
                    // 尝试匹配已索引的符号
                    // 这里简化处理，暂不展开
                }
            }
        });
    }

    // 写入 rows 的 meta
    for (const row of rows) {
        const key = `${row.name}|${row.path}`;
        const callers = callersMap.get(key);
        const callees = calleesMap.get(key);

        if (callers && callers.size > 0) {
            row.meta = row.meta || {};
            row.meta.callers = [...callers].slice(0, 20); // 限制数量
        }
        if (callees && callees.size > 0) {
            row.meta = row.meta || {};
            row.meta.callees = [...callees].slice(0, 20);
        }
    }

    console.error(`[analyzeRelations] processed ${rows.length} symbols`);
}
