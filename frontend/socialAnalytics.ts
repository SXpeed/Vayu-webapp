// Social → Analytics: each workspace connects its own Instagram (Business or
// Creator) account by logging in on Instagram, and its own YouTube channel
// through Google's sign-in. Instagram's 60-day key and Google's refresh token
// are stored encrypted (platform/secrets.ts); figures are read live and kept
// for an hour.
//
// Needs platform keys: INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET (the Instagram
// app ID and secret from the Meta app's "Instagram API with Instagram Login")
// and YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET (wrangler secrets). Without
// them the screens say "not set up yet". The sign-in returns to
// /api/v2/social/oauth/<instagram|youtube>, which must be registered as the
// redirect address: https://api.ateliersupport.com/api/v2/social/oauth/instagram
// in the Meta app, .../oauth/youtube in Google's console.

import { ADMIN_ROLE_ID } from './permissions';
import { err, json, text } from './rows';
import type { Ctx, Env } from './workerEnv';
import { decryptSecret, encryptSecret, reportDecryptFailure, secretsConfigured } from './platform/secrets';
import { APP_ORIGIN } from './brand';
import { caller, ensureSocialTables, orgEnvById, parseJson, type Handler, type Row, type SocialRoute } from './social';
import type { AnalyticsStatus, DayValue, InstagramReport, YoutubeReport } from './socialRules';

/** The accounts a workspace can connect; each is its own sign-in, stored setting and figures. */
type Account = 'instagram' | 'youtube';
const GRAPH_VERSION = 'v23.0';
const STATE_PREFIX = 'social-oauth:';
const CACHE_PREFIX = 'social-analytics:';
const DAY = 86_400_000;
/** Instagram's key lasts 60 days and can be renewed once it is a day old: renewed when older than this. */
const RENEW_AFTER = 7 * DAY;

interface InstagramConn { token: string; tokenAt: number; userId: string; username: string; connectedAt: number; connectedBy: string }
interface YoutubeConn { refreshToken: string; channelId: string; channelTitle: string; connectedAt: number; connectedBy: string }

/** Where each API lives; ANALYTICS_API_BASE (tests only, development only) puts a stand-in in front of all of them. */
function hosts(env: Env) {
    const base = env.PLATFORM_ENV === 'development' && env.ANALYTICS_API_BASE ? env.ANALYTICS_API_BASE.replace(/\/$/, '') : '';
    const igRoot = base ? `${base}/ig` : 'https://graph.instagram.com';
    return {
        igAuth: 'https://www.instagram.com/oauth/authorize',
        igToken: base ? `${base}/ig-token` : 'https://api.instagram.com/oauth/access_token',
        igRoot,
        igGraph: `${igRoot}/${GRAPH_VERSION}`,
        googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
        googleToken: base ? `${base}/google-token` : 'https://oauth2.googleapis.com/token',
        youtube: base ? `${base}/youtube` : 'https://www.googleapis.com/youtube/v3',
        ytAnalytics: base ? `${base}/yt-analytics` : 'https://youtubeanalytics.googleapis.com/v2',
    };
}

const available = (env: Env, a: Account) => secretsConfigured(env) && (a === 'instagram'
    ? !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET)
    : !!(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET));
const redirectUri = (env: Env, origin: string, a: Account) => `${env.API_ORIGIN || origin}/api/v2/social/oauth/${a}`;
const keyContext = (env: Env, a: Account) => `${env.ORG_ID}|${a}|analytics`;
const NAME: Record<Account, string> = { instagram: 'Instagram', youtube: 'YouTube' };

async function readConn<T>(env: Env, a: Account): Promise<T | null> {
    const row = await env.VAYU_DB.prepare('SELECT value FROM social_settings WHERE key = ?').bind(a).first<{ value: string }>();
    return row ? parseJson<T | null>(row.value, null) : null;
}
const saveConn = (env: Env, a: Account, value: unknown) =>
    env.VAYU_DB.prepare('INSERT INTO social_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(a, JSON.stringify(value)).run();

async function secretOf(env: Env, a: Account, sealed: string): Promise<string | null> {
    try { return await decryptSecret(env, keyContext(env, a), sealed); } catch (e) { reportDecryptFailure(keyContext(env, a), e, 'social'); return null; }
}

type Answer = { ok: true; data: any } | { ok: false; error: string; status: number };

/** A GET or form POST to Instagram or Google; the answer's JSON, or the error they gave in plain words. */
async function call(url: string, init?: RequestInit): Promise<Answer> {
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        const data = await res.json().catch(() => ({})) as any;
        if (res.ok && !data?.error && !data?.error_message) return { ok: true, data };
        const said = data?.error?.message ?? data?.error_message ?? data?.error_description ?? data?.error ?? `answered ${res.status}`;
        return { ok: false, error: String(typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 300), status: res.status };
    } catch {
        return { ok: false, error: 'did not answer', status: 0 };
    }
}

const qs = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
const form = (params: Record<string, string>): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs(params) });

// ── Connecting ──────────────────────────────────────────────────────────────

/** GET /social/analytics — which accounts can be connected here and which are. */
const statusGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const [ig, yt] = await Promise.all([readConn<InstagramConn>(ctx.env, 'instagram'), readConn<YoutubeConn>(ctx.env, 'youtube')]);
    return json({
        instagram: { available: available(ctx.env, 'instagram'), connected: !!ig, username: ig?.username ?? '', connectedAt: ig?.connectedAt ?? 0 },
        youtube: { available: available(ctx.env, 'youtube'), connected: !!yt, channelTitle: yt?.channelTitle ?? '', connectedAt: yt?.connectedAt ?? 0 },
    } satisfies AnalyticsStatus);
};

/** The app address to come back to: the one the request came from, if it's one of ours. */
function backTo(ctx: Ctx): string {
    const origin = ctx.request.headers.get('Origin') ?? '';
    const ours = [APP_ORIGIN, ...(ctx.env.AUTH_ORIGINS ?? '').split(',').map(s => s.trim())].filter(Boolean);
    return ours.includes(origin) ? origin : APP_ORIGIN;
}

/** The address of the account's own login page, for this sign-in. */
function loginUrl(env: Env, a: Account, redirect: string, state: string): string {
    const h = hosts(env);
    if (a === 'instagram') {
        // enable_fb_login=0: Instagram's own login only, never Facebook's.
        return `${h.igAuth}?${qs({ client_id: env.INSTAGRAM_APP_ID!, redirect_uri: redirect, state, response_type: 'code', enable_fb_login: 0, scope: 'instagram_business_basic,instagram_business_manage_insights' })}`;
    }
    return `${h.googleAuth}?${qs({ client_id: env.YOUTUBE_CLIENT_ID!, redirect_uri: redirect, state, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly' })}`;
}

/** POST /social/analytics/:account/start — admins only: gives the address of Instagram's or Google's login. */
const startPost: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can connect accounts.', 403);
    const a = START_PATH.exec(ctx.path)![1] as Account;
    if (!available(ctx.env, a)) return err('Connecting this is not set up on this server yet. Ask us to switch it on.', 503);
    const state = crypto.randomUUID().replaceAll('-', '');
    // The platform's store: the sign-in comes back without a workspace in its address.
    await (ctx.env.SHARED_KV ?? ctx.env.VAYU_KV).put(`${STATE_PREFIX}${state}`, JSON.stringify({ org: ctx.env.ORG_ID, a, userId: session.userId, back: backTo(ctx) }), { expirationTtl: 900 });
    return json({ url: loginUrl(ctx.env, a, redirectUri(ctx.env, ctx.url.origin, a), state) });
};

/** DELETE /social/analytics/:account — admins only. */
const disconnect: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can disconnect accounts.', 403);
    const a = ACCOUNT_PATH.exec(ctx.path)![1] as Account;
    await ctx.env.VAYU_DB.prepare('DELETE FROM social_settings WHERE key = ?').bind(a).run();
    await ctx.env.VAYU_KV.delete(`${CACHE_PREFIX}${ctx.env.ORG_ID}:${a}`);
    return json({ ok: true });
};

/** Instagram: the code for a short key, that for a 60-day key, then whose account it is. */
async function finishInstagram(space: Env, code: string, redirect: string, userId: string): Promise<string | null> {
    const h = hosts(space);
    const secret = space.INSTAGRAM_APP_SECRET!;
    // Instagram sometimes leaves "#_" on the code; it is not part of it.
    const short = await call(h.igToken, form({ client_id: space.INSTAGRAM_APP_ID!, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirect, code: code.replace(/#_$/, '') }));
    if (!short.ok) return `Instagram did not accept the login: ${short.error}`;
    const first = (Array.isArray(short.data?.data) ? short.data.data[0] : short.data) ?? {};
    const long = await call(`${h.igRoot}/access_token?${qs({ grant_type: 'ig_exchange_token', client_secret: secret, access_token: text(first.access_token) })}`);
    if (!long.ok) return `Instagram did not give a lasting key: ${long.error}`;
    const token = text(long.data.access_token);
    const me = await call(`${h.igGraph}/me?${qs({ fields: 'user_id,username,account_type', access_token: token })}`);
    if (!me.ok) return `Your Instagram account could not be read: ${me.error}`;
    if (text(me.data.account_type).toUpperCase() === 'PERSONAL') {
        return 'This is a personal Instagram account. Switch it to Business or Creator (Instagram → Settings → Account type and tools), then connect again.';
    }
    const now = Date.now();
    const conn: InstagramConn = {
        token: await encryptSecret(space, keyContext(space, 'instagram'), token), tokenAt: now,
        userId: text(me.data.user_id) || text(first.user_id), username: text(me.data.username), connectedAt: now, connectedBy: userId,
    };
    await saveConn(space, 'instagram', conn);
    return null;
}

/** Google: the code for a refresh token, then the signed-in person's channel. */
async function finishYoutube(space: Env, code: string, redirect: string, userId: string): Promise<string | null> {
    const h = hosts(space);
    const token = await call(h.googleToken, form({ code, client_id: space.YOUTUBE_CLIENT_ID!, client_secret: space.YOUTUBE_CLIENT_SECRET!, redirect_uri: redirect, grant_type: 'authorization_code' }));
    if (!token.ok) return `Google did not accept the sign-in: ${token.error}`;
    if (!token.data.refresh_token) return 'Google did not give a lasting key. Remove ateliersupport from your Google account’s connected apps, then connect again.';
    const channel = await call(`${h.youtube}/channels?${qs({ part: 'snippet', mine: 'true' })}`, { headers: { Authorization: `Bearer ${text(token.data.access_token)}` } });
    const first = channel.ok ? (channel.data?.items?.[0] as Row | undefined) : undefined;
    if (!first) return 'This Google account has no YouTube channel. Sign in with the account that owns the channel.';
    const conn: YoutubeConn = {
        refreshToken: await encryptSecret(space, keyContext(space, 'youtube'), text(token.data.refresh_token)),
        channelId: text(first.id), channelTitle: text((first.snippet as Row | undefined)?.title), connectedAt: Date.now(), connectedBy: userId,
    };
    await saveConn(space, 'youtube', conn);
    return null;
}

/** A small page for the end of the sign-in, with the way back to the app. */
function page(title: string, line: string, back: string): Response {
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f2ee;color:#1f1f1f"><div style="max-width:440px;margin:15vh auto;padding:28px;background:#fff;border-radius:12px;text-align:center">
<h1 style="font-size:20px;margin:0 0 10px">${esc(title)}</h1><p style="margin:0 0 20px;line-height:1.5;color:#555">${esc(line)}</p>
<a href="${esc(back)}/?view=social" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#b08d3c;color:#fff;text-decoration:none">Back to Social</a></div></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' } });
}

const CALLBACK_PATH = /^\/api\/v2\/social\/oauth\/(instagram|youtube)$/;

/** GET /api/v2/social/oauth/<instagram|youtube>?code&state — where Instagram and Google send the person back. Null for any other address. */
export async function handleAnalyticsCallback(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    const m = CALLBACK_PATH.exec(url.pathname);
    if (!m) return null;
    if (request.method !== 'GET') return err('Use GET', 405);
    const a = m[1] as Account;
    const state = url.searchParams.get('state') ?? '';
    const kv = env.SHARED_KV ?? env.VAYU_KV;
    const saved = /^[a-f0-9]{32}$/.test(state) ? await kv.get(`${STATE_PREFIX}${state}`) : null;
    if (!saved) return page('This sign-in has expired', 'Start again from Social → Setup and keys.', APP_ORIGIN);
    await kv.delete(`${STATE_PREFIX}${state}`); // once only
    const s = parseJson<{ org: string; a: Account; userId: string; back: string }>(saved, { org: '', a, userId: '', back: APP_ORIGIN });
    if (s.a !== a) return page('This sign-in has expired', 'Start again from Social → Setup and keys.', s.back);
    const code = url.searchParams.get('code');
    if (!code) return page(`${NAME[a]} not connected`, 'The sign-in was cancelled. Nothing was changed.', s.back);
    const space = await orgEnvById(env, s.org);
    if (!space || !available(space, a)) return page(`${NAME[a]} not connected`, 'This workspace could not be found.', s.back);
    await ensureSocialTables(space.VAYU_DB);
    const redirect = redirectUri(space, url.origin, a);
    const problem = a === 'instagram' ? await finishInstagram(space, code, redirect, s.userId) : await finishYoutube(space, code, redirect, s.userId);
    if (problem) return page(`${NAME[a]} not connected`, problem, s.back);
    return page(`${NAME[a]} connected`, 'Your figures will show in Social → Analytics.', s.back);
}

// ── Reading the figures ─────────────────────────────────────────────────────

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Insights values as days: Instagram gives [{ name, values: [{ value, end_time }] }]. */
function seriesOf(data: any): DayValue[] {
    const values = (Array.isArray(data?.data) ? data.data[0]?.values : null) as { value: unknown; end_time?: string }[] | null;
    return (values ?? []).map(v => ({ date: text(v.end_time).slice(0, 10), value: Number(v.value) || 0 }));
}

function postKind(reel: boolean, mediaType: string): string {
    if (reel) return 'Reel';
    return mediaType === 'CAROUSEL_ALBUM' ? 'Album' : 'Post';
}

/**
 * The saved Instagram key, renewed for another 60 days once it is a week old.
 * shortcut: renewed only when someone opens the figures; a connection nobody opens for 60 days expires and must be connected again (renew from the scheduled job if that bites).
 */
async function instagramToken(env: Env, conn: InstagramConn): Promise<string | null> {
    const token = await secretOf(env, 'instagram', conn.token);
    if (!token || Date.now() - conn.tokenAt < RENEW_AFTER) return token;
    const renewed = await call(`${hosts(env).igRoot}/refresh_access_token?${qs({ grant_type: 'ig_refresh_token', access_token: token })}`);
    if (!renewed.ok || !renewed.data?.access_token) return token; // still valid until it expires
    const fresh = text(renewed.data.access_token);
    await saveConn(env, 'instagram', { ...conn, token: await encryptSecret(env, keyContext(env, 'instagram'), fresh), tokenAt: Date.now() } satisfies InstagramConn);
    return fresh;
}

/** One post with its own figures; some posts (old ones, stories, albums) have none: the counts there are stay. */
async function postOf(h: ReturnType<typeof hosts>, token: string, m: Row): Promise<InstagramReport['posts'][number]> {
    const reel = m.media_product_type === 'REELS';
    const metrics = ['views', 'reach', 'saved', 'shares', ...(reel ? ['ig_reels_avg_watch_time'] : [])];
    const ins = await call(`${h.igGraph}/${text(m.id)}/insights?${qs({ metric: metrics.join(','), access_token: token })}`);
    const v: Record<string, number> = {};
    if (ins.ok) for (const d of (ins.data?.data ?? []) as any[]) v[d.name] = Number(d.total_value?.value ?? d.values?.[0]?.value ?? 0);
    return {
        id: text(m.id), kind: postKind(reel, text(m.media_type)), caption: text(m.caption).split('\n')[0].slice(0, 140),
        at: Date.parse(text(m.timestamp)) || 0, image: text(m.thumbnail_url) || text(m.media_url), permalink: text(m.permalink),
        views: v.views ?? 0, reach: v.reach ?? 0, likes: Number(m.like_count) || 0, comments: Number(m.comments_count) || 0, shares: v.shares ?? 0, saves: v.saved ?? 0,
        avgWatchSec: v.ig_reels_avg_watch_time ? Math.round(v.ig_reels_avg_watch_time / 100) / 10 : undefined, // given in ms
    };
}

async function instagramReport(env: Env, conn: InstagramConn, token: string): Promise<InstagramReport | string> {
    const h = hosts(env);
    const now = Date.now();
    const [account, media, reach] = await Promise.all([
        call(`${h.igGraph}/me?${qs({ fields: 'username,followers_count,media_count', access_token: token })}`),
        call(`${h.igGraph}/me/media?${qs({ fields: 'id,caption,media_type,media_product_type,timestamp,thumbnail_url,media_url,permalink,like_count,comments_count', limit: 12, access_token: token })}`),
        call(`${h.igGraph}/${conn.userId || 'me'}/insights?${qs({ metric: 'reach', period: 'day', since: Math.floor((now - 28 * DAY) / 1000), until: Math.floor(now / 1000), access_token: token })}`),
    ]);
    // The key itself refused (expired, or the app removed in Instagram's settings): nothing can be read.
    if (!account.ok && !media.ok && (account.status === 400 || account.status === 401)) return 'Instagram no longer accepts this connection. Connect Instagram again.';
    const problems = [[account, 'Instagram account'], [media, 'Instagram posts'], [reach, 'Daily reach']].flatMap(([r, what]) => ((r as Answer).ok ? [] : [`${what as string}: ${(r as { error: string }).error}`]));
    const list = (media.ok && Array.isArray(media.data?.data) ? media.data.data : []) as Row[];
    const posts = await Promise.all(list.map(m => postOf(h, token, m)));
    return { username: account.ok ? text(account.data.username) : conn.username, followers: account.ok ? Number(account.data.followers_count) || 0 : 0, posts, reachDaily: reach.ok ? seriesOf(reach.data) : [], problems };
}

async function youtubeReport(env: Env, conn: YoutubeConn, refresh: string): Promise<YoutubeReport | string> {
    const h = hosts(env);
    const token = await call(h.googleToken, form({ client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, refresh_token: refresh, grant_type: 'refresh_token' }));
    if (!token.ok) return token.status === 400 ? 'Google no longer accepts this connection. Connect YouTube again.' : `Google: ${token.error}`;
    const auth = { headers: { Authorization: `Bearer ${text(token.data.access_token)}` } };
    // YouTube's figures arrive about two days late.
    const range = { ids: 'channel==MINE', startDate: ymd(Date.now() - 30 * DAY), endDate: ymd(Date.now() - 2 * DAY) };
    const [channel, daily, sources, top] = await Promise.all([
        call(`${h.youtube}/channels?${qs({ part: 'snippet,statistics', mine: 'true' })}`, auth),
        call(`${h.ytAnalytics}/reports?${qs({ ...range, metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained', dimensions: 'day', sort: 'day' })}`, auth),
        call(`${h.ytAnalytics}/reports?${qs({ ...range, metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views' })}`, auth),
        call(`${h.ytAnalytics}/reports?${qs({ ...range, metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments', dimensions: 'video', sort: '-views', maxResults: 5 })}`, auth),
    ]);
    const problems = [[channel, 'Channel'], [daily, 'Daily views'], [sources, 'Traffic sources'], [top, 'Top videos']].flatMap(([r, what]) => ((r as Answer).ok ? [] : [`${what as string}: ${(r as { error: string }).error}`]));
    const rows = (r: Answer) => (r.ok && Array.isArray(r.data?.rows) ? r.data.rows : []) as unknown[][];
    const topRows = rows(top);
    const ids = topRows.map(r => text(r[0])).filter(Boolean);
    const videos = ids.length ? await call(`${h.youtube}/videos?${qs({ part: 'snippet', id: ids.join(',') })}`, auth) : null;
    const byId = new Map(((videos?.ok ? videos.data?.items : []) ?? []).map((v: any) => [text(v.id), v.snippet ?? {}]));
    const ch = channel.ok ? channel.data?.items?.[0] : null;
    const stat = ch?.statistics ?? {};
    return {
        title: text(ch?.snippet?.title) || conn.channelTitle, subscribers: Number(stat.subscriberCount) || 0, totalViews: Number(stat.viewCount) || 0, videoCount: Number(stat.videoCount) || 0,
        daily: rows(daily).map(r => ({ date: text(r[0]), views: Number(r[1]) || 0, minutes: Number(r[2]) || 0, avgViewSec: Number(r[3]) || 0, subscribers: Number(r[4]) || 0 })),
        sources: rows(sources).map(r => ({ name: text(r[0]), views: Number(r[1]) || 0 })),
        top: topRows.map(r => {
            const s = (byId.get(text(r[0])) ?? {}) as any;
            return {
                id: text(r[0]), title: text(s.title) || text(r[0]), thumb: text(s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url), at: Date.parse(text(s.publishedAt)) || 0,
                views: Number(r[1]) || 0, minutes: Number(r[2]) || 0, avgViewSec: Number(r[3]) || 0, likes: Number(r[4]) || 0, comments: Number(r[5]) || 0,
            };
        }),
        problems,
    };
}

/** The figures, read now through the saved connection; a Response when it is missing or unreadable, a string when the account refused. */
async function freshReport(env: Env, a: Account): Promise<InstagramReport | YoutubeReport | string | Response> {
    if (a === 'youtube') {
        const conn = await readConn<YoutubeConn>(env, 'youtube');
        if (!conn) return err('Connect YouTube first.', 409);
        const refresh = await secretOf(env, 'youtube', conn.refreshToken);
        if (!refresh) return err('The saved YouTube connection could not be read. Connect again.', 409);
        return youtubeReport(env, conn, refresh);
    }
    const conn = await readConn<InstagramConn>(env, 'instagram');
    if (!conn) return err('Connect Instagram first.', 409);
    const token = await instagramToken(env, conn);
    if (!token) return err('The saved Instagram connection could not be read. Connect again.', 409);
    return instagramReport(env, conn, token);
}

/** GET /social/analytics/<instagram|youtube>?refresh=1 — the figures, kept for an hour unless refresh is asked. */
const reportGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const a = ACCOUNT_PATH.exec(ctx.path)![1] as Account;
    if (!available(ctx.env, a)) return err('Analytics are not set up on this server yet.', 503);
    const cacheKey = `${CACHE_PREFIX}${ctx.env.ORG_ID}:${a}`;
    if (ctx.url.searchParams.get('refresh') !== '1') {
        const cached = await ctx.env.VAYU_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));
    }
    const report = await freshReport(ctx.env, a);
    if (report instanceof Response) return report;
    if (typeof report === 'string') return err(report, 502);
    const out = { ...report, fetchedAt: Date.now() };
    await ctx.env.VAYU_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 3600 });
    return json(out);
};

// ── Routes ──────────────────────────────────────────────────────────────────

const START_PATH = /^\/social\/analytics\/(instagram|youtube)\/start$/;
/** GET: the figures; DELETE: disconnect. */
const ACCOUNT_PATH = /^\/social\/analytics\/(instagram|youtube)$/;

export const socialAnalyticsRoutes: SocialRoute[] = [
    { method: 'GET', match: p => p === '/social/analytics', handler: statusGet },
    { method: 'POST', match: p => START_PATH.test(p), handler: startPost },
    { method: 'DELETE', match: p => ACCOUNT_PATH.test(p), handler: disconnect },
    { method: 'GET', match: p => ACCOUNT_PATH.test(p), handler: reportGet },
];
