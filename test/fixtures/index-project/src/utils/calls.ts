import { formatName } from './generic.js';

export function buildGreeting(name: string): string {
    return `Hello ${formatName(name)}`;
}
