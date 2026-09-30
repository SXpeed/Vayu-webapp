// Cloudflare Turnstile, for the public forms that send email (sign-up and
// "Forgot password?"). Shown only when the platform has it switched on: the
// sign-in settings (/api/v2/public/login-methods) then carry a site key. The
// answer goes to the server in the x-captcha-response header (platform/auth.ts).

import React, { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
    render: (el: HTMLElement, options: Record<string, unknown>) => string;
    reset: (id: string) => void;
    remove: (id: string) => void;
}
declare global {
    interface Window { turnstile?: TurnstileApi }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
    loading ??= new Promise<TurnstileApi>((resolve, reject) => {
        if (window.turnstile) { resolve(window.turnstile); return; }
        const script = document.createElement('script');
        script.src = SCRIPT;
        script.async = true;
        script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')));
        script.onerror = () => { loading = null; reject(new Error('Turnstile did not load')); };
        document.head.appendChild(script);
    });
    return loading;
}

/**
 * The widget. `onToken` gets each answer (null when it expires or fails). An
 * answer works once: change `resetKey` after every submit to get a new one.
 */
export const Turnstile: React.FC<{ siteKey: string; onToken: (token: string | null) => void; resetKey?: number }> = ({ siteKey, onToken, resetKey = 0 }) => {
    const box = useRef<HTMLDivElement>(null);
    const widget = useRef<string | null>(null);
    const latest = useRef(onToken);
    latest.current = onToken;

    useEffect(() => {
        let cancelled = false;
        loadTurnstile().then(api => {
            if (cancelled || !box.current) return;
            widget.current = api.render(box.current, {
                sitekey: siteKey,
                theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
                callback: (token: string) => latest.current(token),
                'expired-callback': () => latest.current(null),
                'error-callback': () => latest.current(null),
            });
        }).catch(() => latest.current(null));
        return () => {
            cancelled = true;
            if (widget.current) window.turnstile?.remove(widget.current);
            widget.current = null;
        };
    }, [siteKey]);

    useEffect(() => {
        if (resetKey && widget.current) {
            window.turnstile?.reset(widget.current);
            latest.current(null);
        }
    }, [resetKey]);

    return <div ref={box} className="flex justify-center min-h-[65px]" />;
};

/**
 * For a form: the widget to show (null when bot protection is off), whether
 * it still needs answering, the request options that carry the answer, and
 * `used()` to call after each submit (an answer works once).
 */
export function useCaptcha(siteKey: string | null | undefined) {
    const [token, setToken] = useState<string | null>(null);
    const [resetKey, setResetKey] = useState(0);
    return {
        widget: siteKey ? <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null,
        missing: !!siteKey && !token,
        fetchOptions: token ? { headers: { 'x-captcha-response': token } } : undefined,
        used: () => setResetKey(k => k + 1),
    };
}

export const CAPTCHA_MISSING = 'Complete the check above the button first.';
