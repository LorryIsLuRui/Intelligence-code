// 仅仅测试代码，请勿参考，项目暂未集成react
import React from "react";

export interface DialogProps {
    title: string;
    content: string;
    onClose: () => void;
}

const Dialog = (props: DialogProps) => {
    const { title, content, onClose } = props;
    return <div>
        <div className="dialog-title">{title}</div>
        <div className="dialog-content">{content}</div>
        <div className="dialog-footer">
            <button onClick={onClose}>Close</button>
        </div>
    </div>
};

export default Dialog;