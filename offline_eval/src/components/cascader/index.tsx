/**
 * 级联选择器入口文件。
 * 对外暴露 Cascader 组件及全部公共类型，内部实现由 menu / panel 子模块承载。
 */
// 公共类型导出
export type { CascaderOption, CascaderValue, CascaderChangeEvent } from './types';
// 子模块按需导出（供高级用法自定义拼装）
export { default as CascaderMenu } from './menu';
export { default as CascaderPanel } from './panel';

// 仅测试代码，用于索引评测
import React, { useState, useRef } from 'react';
import CascaderMenu from './menu';
import { useClickOutside } from '../../hooks/useClickOutside';
import type { CascaderOption, CascaderValue, CascaderChangeEvent } from './types';

export interface CascaderProps {
    /** 级联选项树 */
    options: CascaderOption[];
    /** 受控值（路径数组） */
    value?: CascaderValue;
    /** 选中叶子节点时触发 */
    onChange: (event: CascaderChangeEvent) => void;
    placeholder?: string;
    disabled?: boolean;
}

/**
 * 级联选择器（Cascader）：点击触发器展开多列菜单，支持受控模式。
 * 点击外部区域自动收起（依赖 useClickOutside）。
 */
const Cascader = ({
    options,
    value,
    onChange,
    placeholder = '请选择',
    disabled = false,
}: CascaderProps) => {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // 点击外部关闭下拉
    useClickOutside(containerRef, () => setOpen(false));

    const displayValue = Array.isArray(value) ? value.join(' / ') : (value ?? '');

    return (
        <div className="cascader" ref={containerRef}>
            <div
                className={`cascader-trigger${disabled ? ' cascader-trigger--disabled' : ''}`}
                role="combobox"
                aria-expanded={open}
                aria-disabled={disabled}
                onClick={() => !disabled && setOpen((v) => !v)}
            >
                <span className="cascader-trigger-value">
                    {displayValue || placeholder}
                </span>
                <span className="cascader-trigger-arrow">{open ? '▲' : '▼'}</span>
            </div>
            {open && (
                <div className="cascader-dropdown">
                    <CascaderMenu
                        options={options}
                        value={value}
                        onChange={(e) => {
                            onChange(e);
                            setOpen(false);
                        }}
                    />
                </div>
            )}
        </div>
    );
};

export default Cascader;
