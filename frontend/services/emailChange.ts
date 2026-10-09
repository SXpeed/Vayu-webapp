// Changing your own sign-in email, shared by the app's and the control
// centre's Profile (platform/accountEmail.ts has the server side).
//
// Better Auth sends one or two links: to the current address to approve (when
// it is confirmed), then to the new address to confirm. Each link comes back
// to /?account=email; emailChangeLanding() says what happened.

import type { createAuthClient } from 'better-auth/react';

type AuthClient = ReturnType<typeof createAuthClient>;

const PENDING_KEY = 'pending_email_change';
const LANDING = '/?account=email';

export interface EmailChangeResult {
    ok: boolean;
    message: string;
    /** The server wants a recent sign-in, and no password was given. */
    needsPassword?: boolean;
}

const notFresh = (e: { code?: string; message?: string } | null | undefined) =>
    !!e && (e.code === 'SESSION_NOT_FRESH' || /fresh/i.test(e.message ?? ''));

/**
 * Asks for the change. A sign-in older than 30 minutes is renewed with the
 * current password first (the same check as a password change).
 */
export async function startEmailChange(
    client: AuthClient,
    current: { email: string; verified: boolean },
    newEmail: string,
    password: string,
): Promise<EmailChangeResult> {
    const next = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(next)) return { ok: false, message: 'Enter a valid email address.' };
    if (next === current.email.toLowerCase()) return { ok: false, message: 'That is already your email.' };

    const ask = () => client.changeEmail({ newEmail: next, callbackURL: LANDING });
    let { error } = await ask();
    if (notFresh(error)) {
        if (!password) return { ok: false, needsPassword: true, message: 'Enter your current password to confirm it’s you.' };
        const again = await client.signIn.email({ email: current.email, password });
        if (again.error) return { ok: false, message: again.error.status === 401 ? 'That password is not right.' : (again.error.message || 'Could not confirm it’s you.') };
        ({ error } = await ask());
    }
    if (error) {
        if (error.status === 429) return { ok: false, message: 'Too many attempts. Try again in an hour.' };
        return { ok: false, message: error.message || 'Could not start the change. Please try again.' };
    }
    try { localStorage.setItem(PENDING_KEY, next); } catch { /* private mode: the landing message is just more general */ }
    return {
        ok: true,
        message: current.verified
            ? `Check ${current.email} and approve the change. Then we send a link to ${next} to confirm it. (If ${next} already has an account, nothing is sent.)`
            : `Check ${next} and confirm it with the link we sent. (If it already has an account, nothing is sent.)`,
    };
}

/**
 * On arriving from one of the links: what to tell the person, or null when
 * this isn't such a visit. Removes the marker from the address.
 */
export async function emailChangeLanding(client: AuthClient): Promise<{ ok: boolean; message: string } | null> {
    const params = new URLSearchParams(location.search);
    if (params.get('account') !== 'email') return null;
    const error = params.get('error');
    params.delete('account');
    params.delete('error');
    const rest = params.toString();
    const query = rest ? `?${rest}` : '';
    history.replaceState(null, '', `${location.pathname}${query}${location.hash}`);

    if (error) {
        return { ok: false, message: /expired/i.test(error) ? 'That email link has expired. Start the change again from your Profile.' : 'That email link did not work. Start the change again from your Profile.' };
    }
    let pending: string | null = null;
    try { pending = localStorage.getItem(PENDING_KEY); } catch { /* ignore */ }
    const { data } = await client.getSession();
    const email = data?.user.email?.toLowerCase();
    if (email && pending && email === pending) {
        try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
        return { ok: true, message: `Done: you now sign in with ${email}.` };
    }
    if (pending) return { ok: true, message: `Approved. Now open the link we sent to ${pending} to finish.` };
    return { ok: true, message: 'Email link confirmed. If you approved a change, open the link sent to your new address to finish.' };
}
