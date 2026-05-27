// 仅测试代码，用于索引评测
import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    loading?: boolean;
    type?: 'button' | 'submit' | 'reset';
}

/**
 * 通用按钮组件，支持多种视觉变体（primary/secondary/danger/ghost）和尺寸。
 * 被 Dialog、FormInput 等组件引用。
 */
const Button = ({
    children,
    onClick,
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    type = 'button',
}: ButtonProps) => {
    return (
        <button
            type={type}
            className={`btn btn--${variant} btn--${size}${loading ? ' btn--loading' : ''}`}
            disabled={disabled || loading}
            onClick={onClick}
        >
            {loading && <span className="btn-spinner" aria-hidden />}
            {children}
        </button>
    );
};

export default Button;
