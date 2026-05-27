import { useState, useCallback } from 'react';

/**
 * localStorage 持久化 Hook，支持 JSON 序列化 / 反序列化。
 * 读写失败时静默降级到 initialValue，不抛错。
 *
 * 副作用：storage（读写 window.localStorage）
 *
 * @returns [value, setValue, removeValue]
 *
 * @example
 *   const [theme, setTheme, clearTheme] = useLocalStorage('app-theme', 'light');
 */
export function useLocalStorage<T>(
    key: string,
    initialValue: T
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
    const [storedValue, setStoredValue] = useState<T>(() => {
        try {
            const item = window.localStorage.getItem(key);
            return item !== null ? (JSON.parse(item) as T) : initialValue;
        } catch {
            return initialValue;
        }
    });

    const setValue = useCallback(
        (value: T | ((prev: T) => T)) => {
            setStoredValue((prev) => {
                const newValue = value instanceof Function ? value(prev) : value;
                try {
                    window.localStorage.setItem(key, JSON.stringify(newValue));
                } catch {
                    // 超出 quota 时静默忽略
                }
                return newValue;
            });
        },
        [key]
    );

    const removeValue = useCallback(() => {
        setStoredValue(initialValue);
        try {
            window.localStorage.removeItem(key);
        } catch {
            // ignore
        }
    }, [key, initialValue]);

    return [storedValue, setValue, removeValue];
}
