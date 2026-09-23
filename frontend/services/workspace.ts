// Which workspace (organization) the app is working in, and how it signed in.
//
//   Platform sign-in: a platform account (the same one as the website and,
//   for admins, the control centre), kept in an HttpOnly cookie. The app works
//   in one organization at a time; its API is /api/o/<organization id>.
//
//   Original sign-in: the original app's own token, for installed copies that
//   have not signed in again yet. Its API is /api, as before.
//
// Everything that talks to the server asks here for the address to use.

import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ basePath: '/api/v2/auth' });

export interface Workspace {
    id: string;
    name: string;
    /** Platform role: owner, admin, manager or staff. */
    role: string;
}

const WORKSPACE_KEY = 'as_workspace';

function read(): Workspace | null {
    try {
        const raw = localStorage.getItem(WORKSPACE_KEY);
        const parsed = raw ? JSON.parse(raw) as Workspace : null;
        return parsed && typeof parsed.id === 'string' ? parsed : null;
    } catch {
        return null;
    }
}

let current: Workspace | null = read();

export function currentWorkspace(): Workspace | null {
    return current;
}

/** True when signed in with a platform account (working in an organization). */
export function isPlatformSession(): boolean {
    return current !== null;
}

export function setWorkspace(workspace: Workspace | null): void {
    current = workspace;
    try {
        if (workspace) localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
        else localStorage.removeItem(WORKSPACE_KEY);
    } catch { /* private mode: it lasts for this visit */ }
}

/** Where the app's API is for this workspace. */
export function apiBase(): string {
    return current ? `/api/o/${current.id}` : '/api';
}

/** A file address as stored ('/api/files/…' or '/api/o/<id>/files/…') → its storage key. */
export function fileKeyOf(url: string): string | null {
    const match = /^\/api\/(?:o\/[A-Za-z0-9-]+\/)?files\/(.+)$/.exec(url);
    return match ? decodeURIComponent(match[1]) : null;
}

/** The organizations this account can open. */
export async function myWorkspaces(): Promise<Workspace[]> {
    const res = await fetch('/api/v2/me/orgs', { credentials: 'same-origin', signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) return [];
    if (!res.ok) throw new Error('Could not load your workspaces. Please try again.');
    const body = await res.json() as { organizations: { id: string; name: string; role: string; status: string }[] };
    return body.organizations.filter(o => o.status === 'active').map(o => ({ id: o.id, name: o.name, role: o.role }));
}

/** The platform account signed in on this device, if any. */
export async function platformUser(): Promise<{ id: string; name: string; email: string } | null> {
    try {
        const { data } = await authClient.getSession();
        return data?.user ?? null;
    } catch {
        return null;
    }
}
