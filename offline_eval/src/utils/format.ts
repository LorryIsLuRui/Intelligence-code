/**
 * 数字 / 金额 / 文件大小格式化工具函数集。
 */

/**
 * 格式化金额：添加千分位分隔符，保留指定小数位，添加货币符号前缀。
 *
 * @example
 *   formatCurrency(12345.6)          // "¥12,345.60"
 *   formatCurrency(9999, '$', 0)     // "$9,999"
 */
export function formatCurrency(
    amount: number,
    currency = '¥',
    decimals = 2
): string {
    const fixed = amount.toFixed(decimals);
    const [integer = '', decimal] = fixed.split('.');
    const formatted = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decimal !== undefined
        ? `${currency}${formatted}.${decimal}`
        : `${currency}${formatted}`;
}

/**
 * 格式化数字：千分位分隔 + 指定精度，不含货币符号。
 *
 * @example
 *   formatNumber(1234567.89, 1)  // "1,234,567.9"
 *   formatNumber(42)             // "42"
 */
export function formatNumber(value: number, decimals = 0): string {
    const fixed = value.toFixed(decimals);
    const [integer = '', decimal] = fixed.split('.');
    const formatted = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decimal !== undefined ? `${formatted}.${decimal}` : formatted;
}

/**
 * 将字节数转为人类可读的文件大小字符串。
 *
 * @example
 *   formatFileSize(1024)              // "1.0 KB"
 *   formatFileSize(1024 * 1024 * 2)  // "2.0 MB"
 */
export function formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIdx = 0;
    while (size >= 1024 && unitIdx < units.length - 1) {
        size /= 1024;
        unitIdx++;
    }
    return `${size.toFixed(1)} ${units[unitIdx] ?? 'B'}`;
}

/**
 * 将秒数格式化为 mm:ss 或 hh:mm:ss。
 *
 * @example
 *   formatDuration(90)    // "01:30"
 *   formatDuration(3661)  // "01:01:01"
 */
export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
