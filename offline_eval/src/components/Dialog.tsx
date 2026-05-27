// 仅仅测试代码，请勿参考，项目暂未集成react
import React, { useRef } from "react";
import { useClickOutside } from "../hooks/useClickOutside";
import Button from "./Button/index";

export interface DialogProps {
    title: string;
    content: string;
    onClose: () => void;
}

const Dialog = (props: DialogProps) => {
    const { title, content, onClose } = props;
    const containerRef = useRef<HTMLDivElement>(null);

    // 点击弹窗外部时关闭
    useClickOutside(containerRef, onClose);

    return (
        <div className="dialog-overlay">
            <div className="dialog" ref={containerRef}>
                <div className="dialog-title">{title}</div>
                <div className="dialog-content">{content}</div>
                <div className="dialog-footer">
                    <Button variant="ghost" onClick={onClose}>取消</Button>
                    <Button variant="primary" onClick={onClose}>确认</Button>
                </div>
            </div>
        </div>
    );
};

export default Dialog;