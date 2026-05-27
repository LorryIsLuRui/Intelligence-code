import { useEffect, type RefObject } from 'react';

/**
 * 检测鼠标点击是否发生在目标元素外部，常用于 Modal / Dropdown / Popover 的点击外部关闭。
 * 组件卸载时自动移除事件监听，无内存泄漏。
 *
 * 副作用：dom（document.addEventListener / removeEventListener）
 *
 * 被调用方：Dialog、Cascader
 *
 * @example
 *   const ref = useRef<HTMLDivElement>(null);
 *   useClickOutside(ref, () => setOpen(false));
 */
export function useClickOutside<T extends HTMLElement>(
    ref: RefObject<T>,
    handler: (event: MouseEvent) => void
): void {
    useEffect(() => {
        const listener = (event: MouseEvent) => {
            const el = ref.current;
            if (!el || el.contains(event.target as Node)) return;
            handler(event);
        };

        document.addEventListener('mousedown', listener, true);
        return () => {
            document.removeEventListener('mousedown', listener, true);
        };
    }, [ref, handler]);
}
