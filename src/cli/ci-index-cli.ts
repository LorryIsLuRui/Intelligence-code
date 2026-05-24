#!/usr/bin/env node
/**
 * CI增量索引CLI：处理changed files和deleted files
 *
 * 用法：
 * node src/cli/ci-index-cli.js --changed src/file1.ts,src/file2.ts --deleted src/old.ts --renamed src/old.ts:src/new.ts
 */
import { resolve } from 'node:path';
import { loadProjectDotenv } from '../config/env.js';
import { runIncrementalIndex } from './ci-index.js';

async function main() {
    const args = process.argv.slice(2);
    const projectRoot = resolve(process.env.INDEX_ROOT ?? process.cwd());

    loadProjectDotenv(projectRoot);

    let changedFiles: string[] = [];
    let deletedFiles: string[] = [];
    let renamedFiles: { from: string; to: string }[] = [];

    /** 解析 --key value 和 --key=value 两种格式 */
    function getArgValue(key: string, idx: number): [string | null, number] {
        const arg = args[idx];
        const prefix = `--${key}=`;
        if (arg.startsWith(prefix)) return [arg.slice(prefix.length), idx];
        if (arg === `--${key}` && idx + 1 < args.length)
            return [args[idx + 1], idx + 1];
        return [null, idx];
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--changed' || arg.startsWith('--changed=')) {
            const [val, next] = getArgValue('changed', i);
            if (val) {
                changedFiles = val
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                i = next;
            }
        } else if (arg === '--deleted' || arg.startsWith('--deleted=')) {
            const [val, next] = getArgValue('deleted', i);
            if (val) {
                deletedFiles = val
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                i = next;
            }
        } else if (arg === '--renamed' || arg.startsWith('--renamed=')) {
            const [val, next] = getArgValue('renamed', i);
            if (val) {
                renamedFiles = val
                    .split(',')
                    .map((s) => {
                        const [from, to] = s.split(':');
                        return { from: from.trim(), to: to.trim() };
                    })
                    .filter((r) => r.from && r.to);
                i = next;
            }
        }
    }

    if (
        changedFiles.length === 0 &&
        deletedFiles.length === 0 &&
        renamedFiles.length === 0
    ) {
        console.error(
            'Usage: node ci-index-cli.js --changed file1,file2 --deleted file3 --renamed old:new'
        );
        process.exit(1);
    }

    console.error(`[ci-index-cli] projectRoot=${projectRoot}`);
    console.error(`[ci-index-cli] changed: ${changedFiles.join(', ')}`);
    console.error(`[ci-index-cli] deleted: ${deletedFiles.join(', ')}`);
    console.error(
        `[ci-index-cli] renamed: ${renamedFiles.map((r) => `${r.from}->${r.to}`).join(', ')}`
    );

    await runIncrementalIndex({
        projectRoot,
        changedFiles,
        deletedFiles,
        renamedFiles,
    });

    console.error('[ci-index-cli] completed successfully');
}

main().catch((err: unknown) => {
    console.error('[ci-index-cli] failed:', err);
    process.exit(1);
});
