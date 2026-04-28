import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    indexProject,
    type IndexedSymbolRow,
} from '../src/indexer/indexProject.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, 'fixtures', 'index-project');

async function loadRows(): Promise<IndexedSymbolRow[]> {
    return indexProject({
        projectRoot: fixtureRoot,
        globPatterns: ['src/**/*.{ts,tsx,js,jsx}'],
    });
}

function byName(rows: IndexedSymbolRow[], name: string): IndexedSymbolRow {
    const row = rows.find((item) => item.name === name);
    expect(row, `expected symbol ${name} to be indexed`).toBeDefined();
    return row as IndexedSymbolRow;
}

function parseContent(row: IndexedSymbolRow): Record<string, unknown> {
    expect(
        row.content,
        `expected ${row.name} to have semantic content`
    ).toBeTruthy();
    return JSON.parse(row.content as string) as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
    expect(Array.isArray(value)).toBe(true);
    return (value as unknown[]).filter(
        (item): item is string => typeof item === 'string'
    );
}

function relationArray(value: unknown): Array<{ name: string; path: string }> {
    expect(Array.isArray(value)).toBe(true);
    return (value as unknown[]).filter(
        (item): item is { name: string; path: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { name?: unknown }).name === 'string' &&
            typeof (item as { path?: unknown }).path === 'string'
    );
}

describe('indexProject project-level indexing', () => {
    it('indexes interface, type and generic TS utility symbols', async () => {
        const rows = await loadRows();

        const userProfile = byName(rows, 'UserProfile');
        expect(userProfile.type).toBe('interface');
        expect(stringArray(userProfile.meta.properties)).toEqual([
            'id',
            'name',
        ]);

        const fetchOptions = byName(rows, 'FetchOptions');
        expect(fetchOptions.type).toBe('type');
        expect(fetchOptions.meta.kind).toBe('typeAlias');

        const identity = byName(rows, 'identity');
        expect(identity.type).toBe('function');
        expect(stringArray(identity.meta.params)).toEqual(['$p0']);
        expect(parseContent(identity).signature).toBe('fn<$T>($p0:$T)=>$T');
    });

    it('indexes TSX hook and component metadata', async () => {
        const rows = await loadRows();

        const hook = byName(rows, 'useCounter');
        expect(hook.type).toBe('hook');
        expect(stringArray(hook.meta.params)).toEqual(['$p0']);
        expect(stringArray(hook.meta.hooks)).toEqual(['useEffect', 'useState']);
        expect(stringArray(hook.meta.sideEffects)).toEqual([
            'storage',
            'timer',
        ]);

        const hookSemantic = parseContent(hook);
        expect(hookSemantic.hooks).toEqual(['useEffect', 'useState']);
        expect(hookSemantic.sideEffects).toEqual(['storage', 'timer']);

        const dialog = byName(rows, 'Dialog');
        expect(dialog.type).toBe('component');
        expect(stringArray(dialog.meta.props)).toEqual([
            'onClose',
            'title',
            'user',
        ]);
        expect('params' in dialog.meta).toBe(false);
    });

    it('indexes JS and JSX files with JSDoc, category, behavior and side effects', async () => {
        const rows = await loadRows();

        const getOffset = byName(rows, 'getOffset');
        expect(getOffset.path).toBe('src/utils/dom.js');
        expect(getOffset.type).toBe('function');
        expect(getOffset.category).toBe('utils');
        expect(getOffset.description).toBe('获取元素的边界矩形');
        expect(stringArray(getOffset.meta.params)).toEqual(['$p0']);
        expect(getOffset.meta.returnType).toBe('object');
        const getOffsetSemantic = parseContent(getOffset);
        expect(getOffsetSemantic.signature).toBe('fn($p0:object)=>object');
        expect(getOffsetSemantic.behavior).toEqual(['reads dom layout']);
        expect(getOffsetSemantic.sideEffects).toEqual(['dom']);

        const jsBanner = byName(rows, 'JsBanner');
        expect(jsBanner.path).toBe('src/components/JsBanner.jsx');
        expect(jsBanner.type).toBe('component');
        expect(jsBanner.category).toBe('components');
        expect(jsBanner.description).toBe('展示一个可关闭横幅');
        expect(stringArray(jsBanner.meta.params)).toEqual(['onClose', 'title']);
        expect(jsBanner.meta.returnType).toBe('object');
        expect(stringArray(jsBanner.meta.sideEffects)).toEqual(['storage']);
    });

    it('captures TS side effects and call relations', async () => {
        const rows = await loadRows();

        const requestData = byName(rows, 'requestData');
        expect(stringArray(requestData.meta.sideEffects)).toEqual(['network']);

        const persistState = byName(rows, 'persistState');
        expect(stringArray(persistState.meta.sideEffects)).toEqual(['storage']);

        const mutateState = byName(rows, 'mutateState');
        expect(stringArray(mutateState.meta.sideEffects)).toEqual(['mutation']);

        const buildGreeting = byName(rows, 'buildGreeting');
        expect(relationArray(buildGreeting.meta.callees)).toEqual(
            expect.arrayContaining([
                { name: 'formatName', path: 'src/utils/generic.ts' },
            ])
        );

        const formatName = byName(rows, 'formatName');
        expect(relationArray(formatName.meta.callers)).toEqual(
            expect.arrayContaining([
                { name: 'buildGreeting', path: 'src/utils/calls.ts' },
            ])
        );
    });
});
