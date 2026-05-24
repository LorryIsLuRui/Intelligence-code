export async function requestData(url: string): Promise<Response> {
    return fetch(url);
}

export function persistState(cache: { id: string }): void {
    localStorage.setItem('cache', JSON.stringify(cache));
}

export function mutateState(state: { count: number }): number {
    state.count = state.count + 1;
    return state.count;
}
