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

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--changed' && i + 1 < args.length) {
            changedFiles = args[i + 1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            i++;
        } else if (arg === '--deleted' && i + 1 < args.length) {
            deletedFiles = args[i + 1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            i++;
        } else if (arg === '--renamed' && i + 1 < args.length) {
            renamedFiles = args[i + 1]
                .split(',')
                .map((s) => {
                    const [from, to] = s.split(':');
                    return { from: from.trim(), to: to.trim() };
                })
                .filter((r) => r.from && r.to);
            i++;
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
