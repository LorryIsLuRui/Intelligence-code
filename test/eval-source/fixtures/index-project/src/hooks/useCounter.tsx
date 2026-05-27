import { useEffect, useState } from 'react';

export function useCounter(initialCount: number) {
    const [count, setCount] = useState(initialCount);

    useEffect(() => {
        const timerId = setTimeout(() => {
            localStorage.setItem('counter', String(count));
        }, 10);
        return () => clearTimeout(timerId);
    }, [count]);

    return { count, setCount };
}
