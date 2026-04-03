/**
 * 扫描源码目录，用 ts-morph 解析导出并生成待写入 MySQL 的代码块行。
 */

import fg from 'fast-glob';
import { join, resolve } from 'node:path';
import { Node, Project, type SourceFile } from 'ts-morph';
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
];

/**
 * 按 glob 收集文件，用 ts-morph 加载并遍历每个文件的导出，生成全部代码块行。
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
        absolute: true,
        ignore,
        onlyFiles: true,
        dot: false,
    });

    if (files.length === 0) {
        return [];
    }

    const project = new Project({
        tsConfigFilePath: join(projectRoot, 'tsconfig.json'),
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
    });

    project.addSourceFilesAtPaths(files);

    const out: IndexedSymbolRow[] = [];

    for (const sf of project.getSourceFiles()) {
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
                }
            }
        }
    }

    return out;
}
