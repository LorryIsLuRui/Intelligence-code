import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseRequestOptions<T> {
    /** 初始 data 值 */
    initialData?: T;
    /** 请求成功回调 */
    onSuccess?: (data: T) => void;
    /** 请求失败回调 */
    onError?: (error: Error) => void;
    /**
     * 是否手动触发（默认 false，mount 时自动执行）。
     * 设为 true 时需手动调用 run()。
     */
    manual?: boolean;
}

export interface UseRequestResult<T> {
    data: T | undefined;
    loading: boolean;
    error: Error | undefined;
    /** 手动触发请求，可传参数透传给 requestFn */
    run: (...args: unknown[]) => Promise<void>;
    /** 取消当前进行中的请求（置 loading=false，不 reject） */
    cancel: () => void;
}

/**
 * 通用异步请求 Hook，封装 loading / error / data 状态管理。
 * 支持自动执行与手动触发两种模式，组件卸载后自动取消请求避免内存泄漏。
 *
 * 副作用：network（发起 HTTP/fetch 请求）
 *
 * @example
 *   const { data, loading, run } = useRequest(() => fetchUserList(), { manual: true });
 *   <button onClick={() => run()}>刷新</button>
 */
export function useRequest<T>(
    requestFn: (...args: unknown[]) => Promise<T>,
    options: UseRequestOptions<T> = {}
): UseRequestResult<T> {
    const { initialData, onSuccess, onError, manual = false } = options;

    const [data, setData] = useState<T | undefined>(initialData);
    const [loading, setLoading] = useState(!manual);
    const [error, setError] = useState<Error | undefined>();
    const cancelledRef = useRef(false);

    const run = useCallback(
        async (...args: unknown[]) => {
            cancelledRef.current = false;
            setLoading(true);
            setError(undefined);
            try {
                const result = await requestFn(...args);
                if (cancelledRef.current) return;
                setData(result);
                onSuccess?.(result);
            } catch (err) {
                if (cancelledRef.current) return;
                const e = err instanceof Error ? err : new Error(String(err));
                setError(e);
                onError?.(e);
            } finally {
                if (!cancelledRef.current) setLoading(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [requestFn]
    );

    const cancel = useCallback(() => {
        cancelledRef.current = true;
        setLoading(false);
    }, []);

    useEffect(() => {
        if (!manual) void run();
        return () => {
            cancelledRef.current = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { data, loading, error, run, cancel };
}
