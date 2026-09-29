// The original sign-in's session now arrives only as an HttpOnly cookie
// (sessionCookies.ts); the login response body carries no token. Tests that
// act as a signed-in person read the token from the Set-Cookie header and
// keep sending it as a bearer token, which the test config still accepts
// (LEGACY_BEARER_UNTIL in wrangler.json). The cookie path itself is covered by
// tests/sessionCookies.integration.test.mjs.

/** The session token a response set, or null. */
export function sessionTokenFrom(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
        const m = /^(?:__Host-)?vayu_session=([^;]*)/.exec(c);
        if (m?.[1]) return m[1];
    }
    return null;
}

/** A response body with `token` added from the session cookie, when one was set (the shape older tests expect). */
export function withSessionToken(body, res) {
    const token = sessionTokenFrom(res);
    return token && body && typeof body === 'object' ? { ...body, token } : body;
}
