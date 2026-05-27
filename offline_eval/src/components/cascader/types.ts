/**
 * 级联选择器类型定义。
 * CascaderOption 支持无限层级嵌套（children 递归引用自身）。
 */

/** 级联选项节点，children 递归嵌套实现树形结构 */
export interface CascaderOption {
    label: string;
    value: string | number;
    disabled?: boolean;
    /** 子选项列表，存在时该节点为非叶子节点 */
    children?: CascaderOption[];
    /** 附加业务数据 */
    extra?: Record<string, unknown>;
}

/** 级联选择器的值类型：单值或路径数组 */
export type CascaderValue = string | number | Array<string | number>;

/** onChange 事件携带的完整选中信息 */
export interface CascaderChangeEvent {
    /** 选中路径的 value 数组 */
    value: CascaderValue;
    /** 选中路径上的完整节点数组 */
    selectedOptions: CascaderOption[];
}
