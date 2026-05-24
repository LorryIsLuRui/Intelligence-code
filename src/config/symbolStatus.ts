export const SYMBOL_STATUS = {
    OFFLINE: 0,
    PENDING: 1,
    ONLINE: 2,
    ERROR: 3,
} as const;

export type SymbolStatus = (typeof SYMBOL_STATUS)[keyof typeof SYMBOL_STATUS];

export const DEFAULT_STATUS_ON_UPSERT = SYMBOL_STATUS.PENDING;
export const SEARCHABLE_STATUS = SYMBOL_STATUS.ONLINE;
