import type { UserProfile } from '../types/models.js';

interface DialogProps {
    title: string;
    user: UserProfile;
    onClose: () => void;
}

export function Dialog({ title, user, onClose }: DialogProps) {
    return (
        <section>
            <h1>{title}</h1>
            <button onClick={onClose}>{user.name}</button>
        </section>
    );
}
