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

export async function reconcileIndexedSymbols(
    db: Queryable,
    filePaths: string[],
    rows: Array<{ path: string; name: string }>
): Promise<void> {
    if (filePaths.length === 0) return;

    const currentNamesByPath = buildPathToSymbolNames(rows);

    for (const path of filePaths) {
        const currentNames = currentNamesByPath.get(path) ?? [];

        if (currentNames.length > 0) {
            await db.query(
                `UPDATE ${env.symbolsTable}
                 SET status = $1::smallint, file_hash = NULL, updated_at = NOW()
                 WHERE path = $2 AND NOT (name = ANY($3)) AND status != $1::smallint`,
                [SYMBOL_STATUS.OFFLINE, path, currentNames]
            );

            await db.query(
                `UPDATE ${env.symbolsTable}
                 SET status = CASE
                        WHEN embedding IS NOT NULL THEN $1::smallint
                        ELSE $2::smallint
                     END,
                     updated_at = NOW()
                 WHERE path = $3 AND name = ANY($4) AND status = $5::smallint`,
                [
                    SYMBOL_STATUS.ONLINE,
                    SYMBOL_STATUS.PENDING,
                    path,
                    currentNames,
                    SYMBOL_STATUS.OFFLINE,
                ]
            );
            continue;
        }

        await db.query(
            `UPDATE ${env.symbolsTable}
             SET status = $1::smallint, file_hash = NULL, updated_at = NOW()
             WHERE path = $2 AND status != $1::smallint`,
            [SYMBOL_STATUS.OFFLINE, path]
        );
    }
}
