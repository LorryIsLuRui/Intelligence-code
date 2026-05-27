/**
 * 日期格式化工具函数。
 * 将 Date 对象或时间戳转换为指定格式的字符串，默认 YYYY-MM-DD。
 *
 * @example
 *   formatDate(new Date())           // "2026-05-27"
 *   formatDate(new Date(), "YYYY/MM/DD HH:mm")  // "2026/05/27 10:30"
 */
export function formatDate(date: Date | number, format = 'YYYY-MM-DD'): string {
    const d = typeof date === 'number' ? new Date(date) : date;
    const pad = (n: number) => String(n).padStart(2, '0');

    return format
        .replace('YYYY', String(d.getFullYear()))
        .replace('MM', pad(d.getMonth() + 1))
        .replace('DD', pad(d.getDate()))
        .replace('HH', pad(d.getHours()))
        .replace('mm', pad(d.getMinutes()))
        .replace('ss', pad(d.getSeconds()));
}

/**
 * 将日期转为相对时间描述（如"3 天前"）。
 */
export function fromNow(date: Date | number): string {
    const diff = Date.now() - (typeof date === 'number' ? date : date.getTime());
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
}
