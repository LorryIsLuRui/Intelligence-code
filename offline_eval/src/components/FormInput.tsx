// 仅仅测试代码，请勿参考，项目暂未集成react
import React, { useState } from "react";
import { validateRequired, composeValidators, type ValidationResult } from "../utils/validate";
import Button from "./Button/index";

export interface FormInputProps {
    value: string;
    onChange: (value: string) => void;
    error?: string;
    placeholder?: string;
    label?: string;
    required?: boolean;
    /** 提交时触发，仅在校验通过后执行 */
    onSubmit?: (value: string) => void;
}

/**
 * 受控表单输入组件，支持外部传入 onChange 回调与 error 提示。
 * 内置必填校验（validateRequired），可通过 onSubmit 触发提交。
 * 适用于需要校验的表单场景。
 */
const FormInput = (props: FormInputProps) => {
    const { value, onChange, error, placeholder, label, required, onSubmit } = props;
    const [internalError, setInternalError] = useState<string | undefined>();

    const handleSubmit = () => {
        if (!onSubmit) return;
        const validators = required
            ? [(v: unknown) => validateRequired(v, label ?? '此字段')]
            : [];
        const result: ValidationResult = composeValidators(value, validators);
        if (!result.valid) {
            setInternalError(result.message);
            return;
        }
        setInternalError(undefined);
        onSubmit(value);
    };

    const displayError = error ?? internalError;

    return (
        <div className="form-input">
            {label && <label className="form-input-label">{label}</label>}
            <input
                className={`form-input-field${displayError ? " form-input-error" : ""}`}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
            />
            {displayError && <span className="form-input-error-msg">{displayError}</span>}
            {onSubmit && (
                <Button type="submit" onClick={handleSubmit}>提交</Button>
            )}
        </div>
    );
};

export default FormInput;
