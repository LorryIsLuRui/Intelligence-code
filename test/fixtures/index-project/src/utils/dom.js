/**
 * 获取元素的边界矩形
 * @param {Window|HTMLElement} element - 目标元素或window
 * @returns {Object} 边界矩形对象
 */
export function getOffset(element) {
    return element !== window
        ? element.getBoundingClientRect()
        : { top: 0, left: 0, bottom: 0 };
}
