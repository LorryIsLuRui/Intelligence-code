// 仅仅测试代码，请勿参考，项目暂未集成react
import React from "react";

export interface HomeBarProps {
    title: string;
    content: string;
    onClose: () => void;
}

const HomeBar = (props: HomeBarProps) => {
    const { title, content, onClose } = props;
    return <div>
        <div className="home-bar-title">{title}</div>
        <div className="home-bar-content">{content}</div>
        <div className="home-bar-footer">
            <button onClick={onClose}>Close</button>
        </div>
    </div>
};

export default HomeBar;