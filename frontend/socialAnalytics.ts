// Social → Analytics: each workspace connects its own Facebook Page (with the
// Instagram business account linked to it) through Meta's sign-in, and its own
// YouTube channel through Google's. The page token and Google's refresh token
// are stored encrypted (platform/secrets.ts); figures are read live and kept
// for an hour.
//
// Needs platform keys: META_APP_ID / META_APP_SECRET and YOUTUBE_CLIENT_ID /
// YOUTUBE_CLIENT_SECRET (wrangler secrets). Without them the screens say
// "not set up yet". The sign-in returns to /api/v2/social/oauth/<meta|google>,
// which must be registered as the redirect address in Meta's and Google's
// consoles: https://api.ateliersupport.com/api/v2/social/oauth/meta (and /google).

import { ADMIN_ROLE_ID } from './permissions';
import { err, json, text } from './rows';
import type { Ctx, Env } from './workerEnv';
import { decryptSecret, encryptSecret, reportDecryptFailure, secretsConfigured } from './platform/secrets';
import { APP_ORIGIN } from './brand';
import { caller, ensureSocialTables, orgEnvById, parseJson, type Handler, type Row, type SocialRoute } from './social';
import type { AnalyticsStatus, DayValue, FacebookReport, InstagramReport, YoutubeReport } from './socialRules';

type Provider = 'meta' | 'google';
type Kind = 'instagram' | 'facebook' | 'youtube';
const GRAPH_VERSION = 'v23.0';
const STATE_PREFIX = 'social-oauth:';
const CACHE_PREFIX = 'social-analytics:';
const DAY = 86_400_000;

interface MetaConn { pageId: string; pageName: string; pageToken: string; igId: string; igUsername: string; connectedAt: number; connectedBy: string }
interface GoogleConn { refreshToken: string; channelId: string; channelTitle: string; connectedAt: number; connectedBy: string }

/** Where each API lives; ANALYTICS_API_BASE (tests only, development only) puts a stand-in in front of all of them. */
function hosts(env: Env) {
    const base = env.PLATFORM_ENV === 'development' && env.ANALYTICS_API_BASE ? env.ANALYTICS_API_BASE.replace(/\/$/, '') : '';
    return {
        graph: base ? `${base}/graph` : `https://graph.facebook.com/${GRAPH_VERSION}`,
        metaDialog: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
        googleDialog: 'https://accounts.google.com/o/oauth2/v2/auth',
        googleToken: base ? `${base}/google-token` : 'https://oauth2.googleapis.com/token',
        youtube: base ? `${base}/youtube` : 'https://www.googleapis.com/youtube/v3',
        ytAnalytics: base ? `${base}/yt-analytics` : 'https://youtubeanalytics.googleapis.com/v2',
    };
}

const available = (env: Env, p: Provider) => secretsConfigured(env) && (p === 'meta' ? !!(env.META_APP_ID && env.META_APP_SECRET) : !!(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET));
const redirectUri = (env: Env, origin: string, p: Provider) => `${env.API_ORIGIN || origin}/api/v2/social/oauth/${p}`;
const keyContext = (env: Env, p: Provider) => `${env.ORG_ID}|${p}|analytics`;
const providerOf = (kind: Kind): Provider => (kind === 'youtube' ? 'google' : 'meta');

async function readConn<T>(env: Env, p: Provider): Promise<T | null> {
    const row = await env.VAYU_DB.prepare('SELECT value FROM social_settings WHERE key = ?').bind(p).first<{ value: string }>();
    return row ? parseJson<T | null>(row.value, null) : null;
}
const saveConn = (env: Env, p: Provider, value: unknown) =>
    env.VAYU_DB.prepare('INSERT INTO social_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(p, JSON.stringify(value)).run();

async function secretOf(env: Env, p: Provider, sealed: string): Promise<string | null> {
    try { return await decryptSecret(env, keyContext(env, p), sealed); } catch (e) { reportDecryptFailure(keyContext(env, p), e, 'social'); return null; }
}

/** A GET or form POST to Meta or Google; the answer's JSON, or the error they gave in plain words. */
async function call(url: string, init?: RequestInit): Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }> {
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        const data = await res.json().catch(() => ({})) as any;
        if (res.ok && !data?.error) return { ok: true, data };
        const said = data?.error?.message ?? data?.error_description ?? data?.error ?? `answered ${res.status}`;
        return { ok: false, error: String(typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 300), status: res.status };
    } catch {
        return { ok: false, error: 'did not answer', status: 0 };
    }
}

const qs = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();

// ── Connecting ──────────────────────────────────────────────────────────────

/** GET /social/analytics — which accounts can be connected here and which are. */
const statusGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const [meta, google] = await Promise.all([readConn<MetaConn>(ctx.env, 'meta'), readConn<GoogleConn>(ctx.env, 'google')]);
    return json({
        meta: { available: available(ctx.env, 'meta'), connected: !!meta, pageName: meta?.pageName ?? '', igUsername: meta?.igUsername ?? '', connectedAt: meta?.connectedAt ?? 0 },
        google: { available: available(ctx.env, 'google'), connected: !!google, channelTitle: google?.channelTitle ?? '', connectedAt: google?.connectedAt ?? 0 },
    } satisfies AnalyticsStatus);
};

/** The app address to come back to: the one the request came from, if it's one of ours. */
function backTo(ctx: Ctx): string {
    const origin = ctx.request.headers.get('Origin') ?? '';
    const ours = [APP_ORIGIN, ...(ctx.env.AUTH_ORIGINS ?? '').split(',').map(s => s.trim())].filter(Boolean);
    return ours.includes(origin) ? origin : APP_ORIGIN;
}

/** POST /social/analytics/:provider/start — admins only: gives the address of Meta's or Google's sign-in. */
const startPost: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can connect accounts.', 403);
    const p = START_PATH.exec(ctx.path)![1] as Provider;
    if (!available(ctx.env, p)) return err('Connecting this is not set up on this server yet. Ask us to switch it on.', 503);
    const state = crypto.randomUUID().replaceAll('-', '');
    // The platform's store: the sign-in comes back without a workspace in its address.
    await (ctx.env.SHARED_KV ?? ctx.env.VAYU_KV).put(`${STATE_PREFIX}${state}`, JSON.stringify({ org: ctx.env.ORG_ID, p, userId: session.userId, back: backTo(ctx) }), { expirationTtl: 900 });
    const h = hosts(ctx.env);
    const redirect = redirectUri(ctx.env, ctx.url.origin, p);
    const url = p === 'meta'
        ? `${h.metaDialog}?${qs({ client_id: ctx.env.META_APP_ID!, redirect_uri: redirect, state, response_type: 'code', scope: 'pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights,business_management' })}`
        : `${h.googleDialog}?${qs({ client_id: ctx.env.YOUTUBE_CLIENT_ID!, redirect_uri: redirect, state, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly' })}`;
    return json({ url });
};

/** DELETE /social/analytics/:provider — admins only. */
const disconnect: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    if (session.role !== ADMIN_ROLE_ID) return err('Only an admin can disconnect accounts.', 403);
    const p = PROVIDER_PATH.exec(ctx.path)![1] as Provider;
    await ctx.env.VAYU_DB.prepare('DELETE FROM social_settings WHERE key = ?').bind(p).run();
    await Promise.all((['instagram', 'facebook', 'youtube'] as Kind[]).filter(k => providerOf(k) === p).map(k => ctx.env.VAYU_KV.delete(`${CACHE_PREFIX}${ctx.env.ORG_ID}:${k}`)));
    return json({ ok: true });
};

/** Meta: the code for a long-lived token, then the Page (the first with an Instagram account, else the first). */
async function finishMeta(space: Env, code: string, redirect: string, userId: string): Promise<string | null> {
    const h = hosts(space);
    const short = await call(`${h.graph}/oauth/access_token?${qs({ client_id: space.META_APP_ID!, client_secret: space.META_APP_SECRET!, redirect_uri: redirect, code })}`);
    if (!short.ok) return `Meta did not accept the sign-in: ${short.error}`;
    const long = await call(`${h.graph}/oauth/access_token?${qs({ grant_type: 'fb_exchange_token', client_id: space.META_APP_ID!, client_secret: space.META_APP_SECRET!, fb_exchange_token: text(short.data.access_token) })}`);
    if (!long.ok) return `Meta did not give a lasting key: ${long.error}`;
    const pages = await call(`${h.graph}/me/accounts?${qs({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 50, access_token: text(long.data.access_token) })}`);
    if (!pages.ok) return `Your Facebook Pages could not be read: ${pages.error}`;
    const list = (Array.isArray(pages.data?.data) ? pages.data.data : []) as Row[];
    // shortcut: takes the first Page with Instagram linked; add a picker once someone manages several Pages.
    const page = list.find(x => (x.instagram_business_account as Row | undefined)?.id) ?? list[0];
    if (!page) return 'No Facebook Page came back. Sign in again and tick your Page when Meta asks which to share.';
    const ig = (page.instagram_business_account ?? {}) as Row;
    const conn: MetaConn = {
        pageId: text(page.id), pageName: text(page.name), pageToken: await encryptSecret(space, keyContext(space, 'meta'), text(page.access_token)),
        igId: text(ig.id), igUsername: text(ig.username), connectedAt: Date.now(), connectedBy: userId,
    };
    await saveConn(space, 'meta', conn);
    return null;
}

/** Google: the code for a refresh token, then the signed-in person's channel. */
async function finishGoogle(space: Env, code: string, redirect: string, userId: string): Promise<string | null> {
    const h = hosts(space);
    const token = await call(h.googleToken, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs({ code, client_id: space.YOUTUBE_CLIENT_ID!, client_secret: space.YOUTUBE_CLIENT_SECRET!, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    if (!token.ok) return `Google did not accept the sign-in: ${token.error}`;
    if (!token.data.refresh_token) return 'Google did not give a lasting key. Remove ateliersupport from your Google account’s connected apps, then connect again.';
    const channel = await call(`${h.youtube}/channels?${qs({ part: 'snippet', mine: 'true' })}`, { headers: { Authorization: `Bearer ${text(token.data.access_token)}` } });
    const first = channel.ok ? (channel.data?.items?.[0] as Row | undefined) : undefined;
    if (!first) return 'This Google account has no YouTube channel. Sign in with the account that owns the channel.';
    const conn: GoogleConn = {
        refreshToken: await encryptSecret(space, keyContext(space, 'google'), text(token.data.refresh_token)),
        channelId: text(first.id), channelTitle: text((first.snippet as Row | undefined)?.title), connectedAt: Date.now(), connectedBy: userId,
    };
    await saveConn(space, 'google', conn);
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

const CALLBACK_PATH = /^\/api\/v2\/social\/oauth\/(meta|google)$/;

/** GET /api/v2/social/oauth/<meta|google>?code&state — where Meta and Google send the person back. Null for any other address. */
export async function handleAnalyticsCallback(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    const m = CALLBACK_PATH.exec(url.pathname);
    if (!m) return null;
    if (request.method !== 'GET') return err('Use GET', 405);
    const p = m[1] as Provider;
    const state = url.searchParams.get('state') ?? '';
    const kv = env.SHARED_KV ?? env.VAYU_KV;
    const saved = /^[a-f0-9]{32}$/.test(state) ? await kv.get(`${STATE_PREFIX}${state}`) : null;
    if (!saved) return page('This sign-in has expired', 'Start again from Social → Setup and keys.', APP_ORIGIN);
    await kv.delete(`${STATE_PREFIX}${state}`); // once only
    const s = parseJson<{ org: string; p: Provider; userId: string; back: string }>(saved, { org: '', p, userId: '', back: APP_ORIGIN });
    const name = p === 'meta' ? 'Instagram and Facebook' : 'YouTube';
    if (s.p !== p) return page('This sign-in has expired', 'Start again from Social → Setup and keys.', s.back);
    const code = url.searchParams.get('code');
    if (!code) return page(`${name} not connected`, 'The sign-in was cancelled. Nothing was changed.', s.back);
    const space = await orgEnvById(env, s.org);
    if (!space || !available(space, p)) return page(`${name} not connected`, 'This workspace could not be found.', s.back);
    await ensureSocialTables(space.VAYU_DB);
    const redirect = redirectUri(space, url.origin, p);
    const problem = p === 'meta' ? await finishMeta(space, code, redirect, s.userId) : await finishGoogle(space, code, redirect, s.userId);
    if (problem) return page(`${name} not connected`, problem, s.back);
    return page(`${name} connected`, 'Your figures will show in Social → Analytics.', s.back);
}

// ── Reading the figures ─────────────────────────────────────────────────────

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Insights values as days: Meta gives [{ name, values: [{ value, end_time }] }]. */
function seriesOf(data: any): DayValue[] {
    const values = (Array.isArray(data?.data) ? data.data[0]?.values : null) as { value: unknown; end_time?: string }[] | null;
    return (values ?? []).map(v => ({ date: text(v.end_time).slice(0, 10), value: Number(v.value) || 0 }));
}

function postKind(reel: boolean, mediaType: string): string {
    if (reel) return 'Reel';
    return mediaType === 'CAROUSEL_ALBUM' ? 'Album' : 'Post';
}

async function instagramReport(env: Env, conn: MetaConn, token: string): Promise<InstagramReport> {
    const h = hosts(env);
    const problems: string[] = [];
    if (!conn.igId) return { username: '', followers: 0, posts: [], reachDaily: [], problems: ['No Instagram business account is linked to this Facebook Page. Link it in Instagram → Settings → Account type, then connect again.'] };
    const now = Date.now();
    const [account, media, reach] = await Promise.all([
        call(`${h.graph}/${conn.igId}?${qs({ fields: 'username,followers_count,media_count', access_token: token })}`),
        call(`${h.graph}/${conn.igId}/media?${qs({ fields: 'id,caption,media_type,media_product_type,timestamp,thumbnail_url,media_url,permalink,like_count,comments_count', limit: 12, access_token: token })}`),
        call(`${h.graph}/${conn.igId}/insights?${qs({ metric: 'reach', period: 'day', since: Math.floor((now - 28 * DAY) / 1000), until: Math.floor(now / 1000), access_token: token })}`),
    ]);
    if (!account.ok) problems.push(`Instagram account: ${account.error}`);
    if (!media.ok) problems.push(`Instagram posts: ${media.error}`);
    if (!reach.ok) problems.push(`Daily reach: ${reach.error}`);
    const list = (media.ok && Array.isArray(media.data?.data) ? media.data.data : []) as Row[];
    const posts = await Promise.all(list.map(async m => {
        const reel = m.media_product_type === 'REELS';
        const metrics = ['views', 'reach', 'saved', 'shares', ...(reel ? ['ig_reels_avg_watch_time'] : [])];
        const ins = await call(`${h.graph}/${text(m.id)}/insights?${qs({ metric: metrics.join(','), access_token: token })}`);
        const v: Record<string, number> = {};
        // Some posts (old ones, stories, albums) have no insights: keep the counts there are.
        if (ins.ok) for (const d of (ins.data?.data ?? []) as any[]) v[d.name] = Number(d.total_value?.value ?? d.values?.[0]?.value ?? 0);
        return {
            id: text(m.id), kind: postKind(reel, text(m.media_type)), caption: text(m.caption).split('\n')[0].slice(0, 140),
            at: Date.parse(text(m.timestamp)) || 0, image: text(m.thumbnail_url) || text(m.media_url), permalink: text(m.permalink),
            views: v.views ?? 0, reach: v.reach ?? 0, likes: Number(m.like_count) || 0, comments: Number(m.comments_count) || 0, shares: v.shares ?? 0, saves: v.saved ?? 0,
            avgWatchSec: v.ig_reels_avg_watch_time ? Math.round(v.ig_reels_avg_watch_time / 100) / 10 : undefined, // given in ms
        } satisfies InstagramReport['posts'][number];
    }));
    return { username: account.ok ? text(account.data.username) : conn.igUsername, followers: account.ok ? Number(account.data.followers_count) || 0 : 0, posts, reachDaily: reach.ok ? seriesOf(reach.data) : [], problems };
}

async function facebookReport(env: Env, conn: MetaConn, token: string): Promise<FacebookReport> {
    const h = hosts(env);
    const now = Date.now();
    const window = { period: 'day', since: Math.floor((now - 28 * DAY) / 1000), until: Math.floor(now / 1000), access_token: token };
    // One metric per call: Meta retires Page metrics often, and one gone must not hide the others.
    const [pageInfo, views, engaged, posts] = await Promise.all([
        call(`${h.graph}/${conn.pageId}?${qs({ fields: 'name,followers_count,link', access_token: token })}`),
        call(`${h.graph}/${conn.pageId}/insights?${qs({ metric: 'page_media_view', ...window })}`),
        call(`${h.graph}/${conn.pageId}/insights?${qs({ metric: 'page_post_engagements', ...window })}`),
        call(`${h.graph}/${conn.pageId}/posts?${qs({ fields: 'id,message,created_time,full_picture,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', limit: 10, access_token: token })}`),
    ]);
    const problems = [[pageInfo, 'Page'], [views, 'Daily views'], [engaged, 'Daily engagement'], [posts, 'Posts']].flatMap(([r, what]) => ((r as { ok: boolean }).ok ? [] : [`${what as string}: ${(r as { error: string }).error}`]));
    const list = (posts.ok && Array.isArray(posts.data?.data) ? posts.data.data : []) as any[];
    return {
        name: pageInfo.ok ? text(pageInfo.data.name) : conn.pageName, followers: pageInfo.ok ? Number(pageInfo.data.followers_count) || 0 : 0, link: pageInfo.ok ? text(pageInfo.data.link) : '',
        viewsDaily: views.ok ? seriesOf(views.data) : [], engagementDaily: engaged.ok ? seriesOf(engaged.data) : [],
        posts: list.map(x => ({
            id: text(x.id), caption: text(x.message).split('\n')[0].slice(0, 140), at: Date.parse(text(x.created_time)) || 0, image: text(x.full_picture), permalink: text(x.permalink_url),
            reactions: Number(x.reactions?.summary?.total_count) || 0, comments: Number(x.comments?.summary?.total_count) || 0, shares: Number(x.shares?.count) || 0,
        })),
        problems,
    };
}

async function youtubeReport(env: Env, conn: GoogleConn, refresh: string): Promise<YoutubeReport | string> {
    const h = hosts(env);
    const token = await call(h.googleToken, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs({ client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, refresh_token: refresh, grant_type: 'refresh_token' }),
    });
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
    const problems = [[channel, 'Channel'], [daily, 'Daily views'], [sources, 'Traffic sources'], [top, 'Top videos']].flatMap(([r, what]) => ((r as { ok: boolean }).ok ? [] : [`${what as string}: ${(r as { error: string }).error}`]));
    const rows = (r: typeof daily) => (r.ok && Array.isArray(r.data?.rows) ? r.data.rows : []) as unknown[][];
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

/** The figures, read now through the saved connection; a Response when it is missing or unreadable, a string when Google refused. */
async function freshReport(env: Env, kind: Kind): Promise<InstagramReport | FacebookReport | YoutubeReport | string | Response> {
    if (providerOf(kind) === 'google') {
        const conn = await readConn<GoogleConn>(env, 'google');
        if (!conn) return err('Connect YouTube first.', 409);
        const refresh = await secretOf(env, 'google', conn.refreshToken);
        if (!refresh) return err('The saved YouTube connection could not be read. Connect again.', 409);
        return youtubeReport(env, conn, refresh);
    }
    const conn = await readConn<MetaConn>(env, 'meta');
    if (!conn) return err('Connect Instagram and Facebook first.', 409);
    const token = await secretOf(env, 'meta', conn.pageToken);
    if (!token) return err('The saved Meta connection could not be read. Connect again.', 409);
    return kind === 'instagram' ? instagramReport(env, conn, token) : facebookReport(env, conn, token);
}

/** GET /social/analytics/<instagram|facebook|youtube>?refresh=1 — the figures, kept for an hour unless refresh is asked. */
const reportGet: Handler = async (ctx) => {
    const session = await caller(ctx);
    if (session instanceof Response) return session;
    const kind = REPORT_PATH.exec(ctx.path)![1] as Kind;
    const p = providerOf(kind);
    if (!available(ctx.env, p)) return err('Analytics are not set up on this server yet.', 503);
    const cacheKey = `${CACHE_PREFIX}${ctx.env.ORG_ID}:${kind}`;
    if (ctx.url.searchParams.get('refresh') !== '1') {
        const cached = await ctx.env.VAYU_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));
    }
    const report = await freshReport(ctx.env, kind);
    if (report instanceof Response) return report;
    if (typeof report === 'string') return err(report, 502);
    const out = { ...report, fetchedAt: Date.now() };
    await ctx.env.VAYU_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 3600 });
    return json(out);
};

// ── Routes ──────────────────────────────────────────────────────────────────

const START_PATH = /^\/social\/analytics\/(meta|google)\/start$/;
const PROVIDER_PATH = /^\/social\/analytics\/(meta|google)$/;
const REPORT_PATH = /^\/social\/analytics\/(instagram|facebook|youtube)$/;

export const socialAnalyticsRoutes: SocialRoute[] = [
    { method: 'GET', match: p => p === '/social/analytics', handler: statusGet },
    { method: 'POST', match: p => START_PATH.test(p), handler: startPost },
    { method: 'DELETE', match: p => PROVIDER_PATH.test(p), handler: disconnect },
    { method: 'GET', match: p => REPORT_PATH.test(p), handler: reportGet },
];
