// 仅测试代码，用于索引评测
import React, { useState, useCallback } from 'react';
import CascaderPanel from './panel';
import type { CascaderOption, CascaderValue, CascaderChangeEvent } from './types';

export interface CascaderMenuProps {
    options: CascaderOption[];
    value?: CascaderValue;
    onChange: (event: CascaderChangeEvent) => void;
    /** 最大展开层级，默认 5 */
    maxDepth?: number;
}

/**
 * 级联选择器多列菜单，按选中路径横向展开各层 CascaderPanel。
 * 管理选中路径状态（activePath），叶子节点选中时触发 onChange。
 */
const CascaderMenu = ({
    options,
    value,
    onChange,
    maxDepth = 5,
}: CascaderMenuProps) => {
    const [activePath, setActivePath] = useState<CascaderOption[]>([]);

    const handleSelect = useCallback(
        (option: CascaderOption, depth: number) => {
            const newPath = [...activePath.slice(0, depth), option];
            setActivePath(newPath);

            // 叶子节点：无子节点，触发最终 onChange
            if (!option.children?.length) {
                onChange({
                    value: newPath.map((o) => o.value),
                    selectedOptions: newPath,
                });
            }
        },
        [activePath, onChange]
    );

    // 根据当前选中路径构建各层面板的 options
    const panels: CascaderOption[][] = [options];
    for (let i = 0; i < activePath.length && i < maxDepth - 1; i++) {
        const active = activePath[i];
        if (active?.children?.length) {
            panels.push(active.children);
        } else {
            break;
        }
    }

    return (
        <div className="cascader-menu" role="tree">
            {panels.map((panelOptions, depth) => (
                <CascaderPanel
                    key={depth}
                    options={panelOptions}
                    activeValue={activePath[depth]?.value}
                    onSelect={handleSelect}
                    depth={depth}
                />
            ))}
        </div>
    );
};

export default CascaderMenu;
