/**
 * 表单字段校验工具函数集。
 * 每个校验函数返回 ValidationResult，可通过 composeValidators 组合多个规则。
 */

export interface ValidationResult {
    valid: boolean;
    /** 校验不通过时的错误提示文案 */
    message?: string;
}

/**
 * 校验必填项：值为 null / undefined / 空字符串 / 空数组时不通过。
 *
 * @example
 *   validateRequired('')           // { valid: false, message: '此字段不能为空' }
 *   validateRequired('hello')      // { valid: true }
 */
export function validateRequired(
    value: unknown,
    fieldName = '此字段'
): ValidationResult {
    const isEmpty =
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);
    return isEmpty
        ? { valid: false, message: `${fieldName}不能为空` }
        : { valid: true };
}

/**
 * 校验邮箱格式。
 *
 * @example
 *   validateEmail('user@example.com')  // { valid: true }
 *   validateEmail('bad-email')         // { valid: false, message: '请输入有效的邮箱地址' }
 */
export function validateEmail(email: string): ValidationResult {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email)
        ? { valid: true }
        : { valid: false, message: '请输入有效的邮箱地址' };
}

/**
 * 校验字符串长度范围（含首尾空白）。
 */
export function validateLength(
    value: string,
    min: number,
    max: number,
    fieldName = '输入内容'
): ValidationResult {
    if (value.length < min)
        return { valid: false, message: `${fieldName}不得少于 ${min} 个字符` };
    if (value.length > max)
        return { valid: false, message: `${fieldName}不得超过 ${max} 个字符` };
    return { valid: true };
}

/**
 * 校验手机号（中国大陆 11 位）。
 */
export function validatePhone(phone: string): ValidationResult {
    return /^1[3-9]\d{9}$/.test(phone)
        ? { valid: true }
        : { valid: false, message: '请输入有效的手机号' };
}

/**
 * 组合多个校验函数，依次执行并返回第一个失败结果；全部通过则返回 { valid: true }。
 *
 * @example
 *   composeValidators(value, [
 *     (v) => validateRequired(v, '邮箱'),
 *     (v) => validateEmail(v as string),
 *   ]);
 */
export function composeValidators(
    value: unknown,
    validators: Array<(v: unknown) => ValidationResult>
): ValidationResult {
    for (const validator of validators) {
        const result = validator(value);
        if (!result.valid) return result;
    }
    return { valid: true };
}
