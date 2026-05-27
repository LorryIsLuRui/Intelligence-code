// 仅测试代码，用于索引评测
import React from 'react';
import type { CascaderOption } from './types';

export interface CascaderPanelProps {
    options: CascaderOption[];
    activeValue?: string | number;
    onSelect: (option: CascaderOption, depth: number) => void;
    depth?: number;
}

/**
 * 级联选择器单列面板，渲染一层选项列表。
 * 支持高亮当前选中项、禁用项、有子节点的箭头指示。
 * 由 CascaderMenu 按层级叠加调用。
 */
const CascaderPanel = ({
    options,
    activeValue,
    onSelect,
    depth = 0,
}: CascaderPanelProps) => {
    return (
        <ul className={`cascader-panel cascader-panel--depth-${depth}`} role="listbox">
            {options.map((option) => {
                const isActive = option.value === activeValue;
                const hasChildren = Boolean(option.children?.length);
                const cls = [
                    'cascader-panel-item',
                    isActive ? 'cascader-panel-item--active' : '',
                    option.disabled ? 'cascader-panel-item--disabled' : '',
                    hasChildren ? 'cascader-panel-item--expandable' : '',
                ]
                    .filter(Boolean)
                    .join(' ');

                return (
                    <li
                        key={option.value}
                        className={cls}
                        role="option"
                        aria-selected={isActive}
                        aria-disabled={option.disabled}
                        onClick={() => !option.disabled && onSelect(option, depth)}
                    >
                        <span className="cascader-panel-item-label">{option.label}</span>
                        {hasChildren && (
                            <span className="cascader-panel-item-arrow" aria-hidden>
                                ›
                            </span>
                        )}
                    </li>
                );
            })}
        </ul>
    );
};

export default CascaderPanel;
