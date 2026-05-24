import { env } from '../config/env.js';
import { SYMBOL_STATUS } from '../config/symbolStatus.js';

type Queryable = {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
};

function buildPathToSymbolNames(
    rows: Array<{ path: string; name: string }>
): Map<string, string[]> {
    const pathToNames = new Map<string, Set<string>>();
    for (const row of rows) {
        const names = pathToNames.get(row.path) ?? new Set<string>();
        names.add(row.name);
        pathToNames.set(row.path, names);
    }
    return new Map(
        [...pathToNames.entries()].map(([path, names]) => [path, [...names]])
    );
}

async function markFileSymbolsOffline(
    db: Queryable,
    path: string
): Promise<void> {
    await db.query(
        `UPDATE ${env.symbolsTable}
         SET status = $1::smallint, file_hash = NULL, updated_at = NOW()
         WHERE path = $2 AND status != $1::smallint`,
        [SYMBOL_STATUS.OFFLINE, path]
    );
}

/**
 * 将指定文件集合中已消失的 symbol 标记为 offline。
 * - `rows` 为空（整文件被删）→ 该文件所有 symbol 下线；
 * - `rows` 非空 → 仅将不再出现于 `rows` 的 symbol 下线；
 * - 重新出现的 symbol 状态恢复由 upsertSymbols 负责（hash 没变且有 embedding → online，否则 pending），此处不重复处理。
 * forceRebuild 场景由上游先统一清空 embedding/status，此函数不负责强制重算策略。
 */
export async function markRemovedSymbolsOffline(
    db: Queryable,
    filePaths: string[],
    rows: Array<{ path: string; name: string }>
): Promise<void> {
    if (filePaths.length === 0) return;

    const currentNamesByPath = buildPathToSymbolNames(rows);

    for (const path of filePaths) {
        const currentNames = currentNamesByPath.get(path) ?? [];
        if (currentNames.length > 0) {
            // 当前文件中已消失的 symbol 标记为 offline；
            await db.query(
                `UPDATE ${env.symbolsTable}
                 SET status = $1::smallint, file_hash = NULL, updated_at = NOW()
                 WHERE path = $2 AND NOT (name = ANY($3)) AND status != $1::smallint`,
                [SYMBOL_STATUS.OFFLINE, path, currentNames]
            );
            continue;
        }
        // 没有symbol，表示所有内容都删除下线
        await markFileSymbolsOffline(db, path);
    }
}
