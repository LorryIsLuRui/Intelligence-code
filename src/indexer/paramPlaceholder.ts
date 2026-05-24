export function makeParamPlaceholder(index: number, isRest = false): string {
    return `${isRest ? '...' : ''}$p${index}`;
}

export function isParamPlaceholder(name: string): boolean {
    return /^\.\.\.\$p\d+$|^\$p\d+$/.test(name);
}
