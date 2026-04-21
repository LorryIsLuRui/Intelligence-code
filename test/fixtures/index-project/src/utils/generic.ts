export function identity<T>(value: T): T {
    return value;
}

export function formatName(name: string): string {
    return name.trim().toUpperCase();
}
