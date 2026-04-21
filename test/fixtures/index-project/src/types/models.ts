export interface UserProfile {
    id: string;
    name: string;
}

export type FetchOptions = {
    url: string;
    retry?: number;
};
