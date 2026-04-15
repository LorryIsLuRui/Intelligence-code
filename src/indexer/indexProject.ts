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
    isHookLike,
    isTsxFile,
    snippetForNode,
    inferCategoryFromName,
} from './heuristics.js';
import { parseJsFile } from './babelParser.js';
import { computeFileHash, computeSemanticHash } from './tsAstNormalizer.js';

const CALLERS_LIMIT = 20;

/** 已收集的符号映射：key = "name|path"，用于快速查找 */
type SymbolMap = Map<
    string,
    { name: string; path: string; exports: Set<string> }
>;

/** 判断文件类型 */
function isJsFile(filePath: string): boolean {
    return filePath.endsWith('.js') || filePath.endsWith('.jsx');
}

function isTsFile(filePath: string): boolean {
    return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

export interface IndexedSymbolRow {
    name: string;
    type: SymbolType;
    category: string | null;
    path: string;
    description: string | null;
    content: string | null;
    meta: Record<string, unknown>;
    semantic_hash?: string; // 代码语义模板哈希值
    file_hash?: string; // 文件哈希值
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
    const name = resolveExportName(exportName, decl);
    const description = getLeadingDocDescription(decl) ?? null;

    if (
        Node.isInterfaceDeclaration(decl) ||
        Node.isTypeAliasDeclaration(decl)
    ) {
        const meta = extractInterfaceOrTypeMeta(decl);
        const type = Node.isInterfaceDeclaration(decl) ? 'interface' : 'type';
        const [semantic_hash, stableStr] = computeSemanticHash({
            name,
            type,
            description,
            meta,
            node: decl,
        });
        return {
            name,
            type,
            category: '',
            path: relPath,
            description,
            content: stableStr,
            meta,
            file_hash: computeFileHash(sf.getFullText()),
            semantic_hash,
        };
    }

    if (Node.isFunctionDeclaration(decl)) {
        const jsx = isTsxFile(filePath) && hasJsxInNode(decl);
        const type: SymbolType = isHookLike(name)
            ? 'hook'
            : jsx
              ? 'component'
              : 'function';
        const raw = extractMetaFromCallable(decl);
        const meta = mergeCallableMeta(type, raw);
        const [semantic_hash, stableStr] = computeSemanticHash({
            name,
            type,
            description,
            meta,
            node: decl,
        });
        return {
            name,
            type,
            category: '',
            path: relPath,
            description,
            content: stableStr,
            meta,
            semantic_hash,
            file_hash: computeFileHash(sf.getFullText()),
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
        const type: SymbolType = isHookLike(name)
            ? 'hook'
            : jsx
              ? 'component'
              : 'function';
        const raw = extractMetaFromCallable(callable);
        const meta = mergeCallableMeta(type, raw);
        const [semantic_hash, stableStr] = computeSemanticHash({
            name,
            type,
            description,
            meta,
            node: callable,
        });
        return {
            name,
            type,
            category: '',
            path: relPath,
            description,
            content: stableStr,
            meta,
            semantic_hash,
            file_hash: computeFileHash(sf.getFullText()),
        };
    }

    if (Node.isClassDeclaration(decl)) {
        // 轻量：仅将 class 记为 util（后续可扩展为带 JSX 的组件类）
        const type = 'class';
        const [semantic_hash, stableStr] = computeSemanticHash({
            name,
            type,
            description,
            meta: { kind: type },
            node: decl,
        });
        return {
            name,
            type,
            category: '',
            path: relPath,
            description,
            content: stableStr,
            meta: { kind: type },
            semantic_hash,
            file_hash: computeFileHash(sf.getFullText()),
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
            const relPath = getRelativePathForDisplay(
                projectRoot,
                sf.getFilePath()
            );
            const exported = sf.getExportedDeclarations();
            // 只检索export的代码，减少噪音
            // 如果要检索未export的，需要考虑
            /**
             *  类型一：真正的内部实现，不应该复用
                function _buildSqlFragment() {}     // 和模块强耦合，外部用不了
                const __validateInternal = () => {} // 私有约定（下划线前缀）
                → 索引了也没用，反而是噪音

                类型二：工具函数，只是作者忘了 export / 懒得 export
                function debounce(fn, ms) {}        // 通用，完全可以复用
                function formatCurrency(n) {}       // 通用，其他地方也需要
                → 索引有价值，还能反向提示"这个应该被 export"

                类型三：文件内共享但跨文件无意义
                function getLocalConfig() {}        // 依赖闭包变量，移出去就坏了
                → 索引意义不大
             */
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
                            symbolMap.set(key, {
                                name: row.name,
                                path: row.path,
                                exports: new Set(),
                            });
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
                    symbolMap.set(key, {
                        name: row.name,
                        path: row.path,
                        exports: new Set(),
                    });
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
    const exportToSymbol = new Map<string, { name: string; path: string }[]>();
    for (const [key, value] of symbolMap) {
        for (const exp of value.exports) {
            const list = exportToSymbol.get(exp) || [];
            list.push({ name: value.name, path: value.path });
            exportToSymbol.set(exp, list);
        }
    }

    const callersMap = new Map<string, Set<string>>();
    const calleesMap = new Map<string, Set<string>>();

    for (const sf of project.getSourceFiles()) {
        const filePath = sf.getFilePath();
        const relPath = getRelativePathForDisplay(projectRoot, filePath);
        const exported = sf.getExportedDeclarations();

        sf.forEachDescendant((node) => {
            // 函数调用
            if (Node.isCallExpression(node)) {
                const expr = node.getExpression();
                const name = Node.isIdentifier(expr) ? expr.getText() : null;
                if (name && exportToSymbol.has(name)) {
                    const targets = exportToSymbol.get(name)!;
                    for (const [expName, decls] of exported) {
                        for (const _decl of decls) {
                            const callerKey = `${expName}|${relPath}`;
                            for (const target of targets) {
                                // callees: 我调用了谁
                                const calleeSet =
                                    calleesMap.get(callerKey) ||
                                    new Set<string>();
                                calleeSet.add(`${target.name}|${target.path}`); // ✅ 字符串天然去重
                                calleesMap.set(callerKey, calleeSet);

                                const callerSet =
                                    callersMap.get(
                                        `${target.name}|${target.path}`
                                    ) || new Set<string>();
                                callerSet.add(`${expName}|${relPath}`);
                                callersMap.set(
                                    `${target.name}|${target.path}`,
                                    callerSet
                                );
                            }
                        }
                    }
                }
            }

            // Import 导入关系（含 import type）
            if (Node.isImportDeclaration(node)) {
                // 1. 解析被导入文件的路径
                const importedSf = node.getModuleSpecifierSourceFile();
                if (!importedSf) return; // 无法解析（第三方包等）跳过

                const importedRelPath = getRelativePathForDisplay(
                    projectRoot,
                    importedSf.getFilePath()
                );

                // 2. 收集本条 import 引入了哪些具名符号
                const namedBindings = node.getNamedImports(); // { SymbolRepository }
                const defaultImport = node.getDefaultImport(); // import Foo from ...

                const importedNames: string[] = [
                    ...namedBindings.map((n) => n.getName()),
                    ...(defaultImport ? [defaultImport.getText()] : []),
                ];

                if (importedNames.length === 0) return;

                // 3. 当前文件的所有导出符号作为 caller
                for (const [expName] of exported) {
                    const callerKey = `${expName}|${relPath}`;

                    for (const importedName of importedNames) {
                        // 4. 在 symbolMap 里找到被导入符号对应的 row
                        //    key 格式：`name|path`，name 是 resolveExportName 后的真实名
                        //    exportToSymbol 里存的是 exportName（可能是 'default'），
                        //    所以同时按 importedName 和路径在 symbolMap 里直接查
                        const targetKey = `${importedName}|${importedRelPath}`;
                        const target = symbolMap.get(targetKey);

                        if (!target) continue;

                        // callee：当前文件的导出符号引用了 target
                        const calleeSet =
                            calleesMap.get(callerKey) || new Set<string>();
                        calleeSet.add(`${target.name}|${target.path}`);
                        calleesMap.set(callerKey, calleeSet);

                        const callerRefKey = `${target.name}|${target.path}`;
                        const callerSet =
                            callersMap.get(callerRefKey) || new Set<string>();
                        callerSet.add(`${expName}|${relPath}`);
                        callersMap.set(callerRefKey, callerSet);
                    }
                }
            }
        });
    }

    // 写入 rows 的 meta
    for (const row of rows) {
        const key = `${row.name}|${row.path}`;
        const callers = callersMap.get(key);
        const callees = calleesMap.get(key);

        if (callers?.size) {
            row.meta.callers = [...callers].slice(0, CALLERS_LIMIT).map((s) => {
                // ✅ 反序列化回对象
                const [name, ...pathParts] = s.split('|');
                return { name, path: pathParts.join('|') };
            });
        }
        if (callees?.size) {
            row.meta.callees = [...callees].slice(0, CALLERS_LIMIT).map((s) => {
                const [name, ...pathParts] = s.split('|');
                // path:为了防止路径里万一含有 | 字符时截断错误。
                return { name, path: pathParts.join('|') };
            });
        }
    }

    console.error(`[analyzeRelations] processed ${rows.length} symbols`);
}
