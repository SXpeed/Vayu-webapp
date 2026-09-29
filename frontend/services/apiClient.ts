import { apiBase, isPlatformSession } from './workspace';

/**
 * The old sign-in token, from before sessions moved into an HttpOnly cookie.
 * Only a device that hasn't started since still has one; authService swaps it
 * for the cookie once (POST /api/auth/session) and deletes it.
 */
export const LEGACY_TOKEN_KEY = 'vayu_token';

/** The CSRF value the server set in a readable cookie, sent back as a header on every call. */
export function csrfToken(): string | null {
    if (typeof document === 'undefined') return null;
    for (const part of document.cookie.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === '__Host-vayu_csrf' || name === 'vayu_csrf') return rest.join('=') || null;
    }
    return null;
}

/**
 * What every API call sends besides cookies: the CSRF header, and only on a
 * device not yet switched over, the old token.
 */
export function tokenHeader(): Record<string, string> {
    const headers: Record<string, string> = {};
    const csrf = csrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (!isPlatformSession()) {
        const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
        if (legacy) headers.Authorization = `Bearer ${legacy}`;
    }
    return headers;
}

export function authHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...tokenHeader() };
}

/** Fired on window when the server says this device was signed out. */
export const SIGNED_OUT_EVENT = 'vayu:signed-out';

/** Fired on window when the workspace's plan isn't active (it opens only the plan, to pay). */
export const PLAN_BLOCKED_EVENT = 'vayu:plan-blocked';

/**
 * Parse an API response without assuming the body is JSON. When the backend
 * is briefly unavailable (dev proxy down, deploy in progress, Cloudflare
 * error page) the body is HTML/text — surface a readable message instead of
 * a raw parse error like "Failed to execute 'json' on 'Response'".
 */
export async function parseApiResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(res.ok
                ? 'Unexpected server response. Please try again.'
                : `Server error (${res.status}). Please try again.`);
        }
    }
    if (!res.ok) {
        // Signed out elsewhere (e.g. the per-person device limit): tell the
        // app so it can return to the login screen with an explanation.
        const reason = (data as { reason?: string } | null)?.reason;
        if (res.status === 401 && reason && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT, { detail: { reason } }));
        }
        if (res.status === 402 && (data as { code?: string } | null)?.code === 'subscription_inactive' && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(PLAN_BLOCKED_EVENT));
        }
        const error = new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`) as Error & { status?: number; code?: string };
        error.status = res.status;
        error.code = (data as { code?: string } | null)?.code;
        throw error;
    }
    return data as T;
}

/**
 * Reads are cancelled after this long. A request the server never answers
 * otherwise holds its connection open forever: the 15-second refresh kept
 * adding hung requests until the browser's few connections per server were
 * all stuck and nothing in the app could load. Writes are left alone (a large
 * upload can legitimately take longer).
 */
const READ_TIMEOUT_MS = 20_000;

export async function apiCall<T>(path: string, options?: RequestInit): Promise<T> {
    const isRead = !options?.method || options.method.toUpperCase() === 'GET';
    let res: Response;
    try {
        res = await fetch(`${apiBase()}${path}`, {
            ...options,
            signal: options?.signal ?? (isRead ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined),
            headers: { ...authHeaders(), ...options?.headers },
        });
    } catch (e) {
        if ((e as Error).name === 'TimeoutError') {
            throw new Error('The server took too long to answer. Please try again.');
        }
        throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    return parseApiResponse<T>(res);
}
