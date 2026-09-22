// SyncHub — one Durable Object per workspace, using the WebSocket Hibernation
// API. It fans out committed-change signals, keeps connection-based presence,
// relays typing indicators and takes durable delivery/read acknowledgements.
//
// D1 stays the authoritative business store: everything the hub writes goes
// through the same atomic D1 batch (mutation + change_log row) the REST
// handlers use, and clients recover missed events through /api/sync even if a
// notification is lost. Typing events are never persisted.
//
// The hub is reachable only through the Worker's service binding, and every
// internal call must carry the shared secret (x-hub-key). Origin validation
// happens in the Worker before the upgrade is forwarded — the hub never sees
// the public URL, so it cannot check Origin itself.

import {
  CONNECTION_LEASE_MS, TICKET_TTL_MS, verifyTicket,
  type RealtimeTicketPayload,
} from './realtimeTickets';
import {
  canReadPayments, permissionsForRoles, readableEntities, type SyncEntity,
} from './entityAccess';
import { ADMIN_ROLE_ID, type RoleDef } from './permissions';
import { ackStatus, ensureChangeLogTable, statusUpgradeStmts } from './deltaSync';
import { rawRealtimeSecret, workspaceId, type ChangeEvent, type Env } from './workerEnv';

interface SocketMeta {
  userId: string;
  name: string;
  role: string;
  leaseUntil: number;
  lastSeenAt: number;
}

interface HubMessage {
  type?: unknown;
  conversationId?: unknown;
  messageIds?: unknown;
  status?: unknown;
  ticket?: unknown;
}

const MAX_MESSAGE_BYTES = 4096;
const MAX_SOCKETS_PER_USER = 6;
/** Messages per 10 s window before the socket is considered abusive. */
const MESSAGE_RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10_000;
const TYPING_MIN_INTERVAL_MS = 1500;
const MEMBERSHIP_TTL_MS = 60_000;
const ROLES_TTL_MS = 60_000;
/** Acks are bounded so one client can't enqueue unbounded D1 work. */
const MAX_ACK_IDS = 50;

function hubJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class SyncHub {
  private state: DurableObjectState;
  private env: Env;
  private hydrated = false;
  /** userId -> live (or hibernating) sockets, rebuilt from attachments. */
  private sockets = new Map<string, Set<WebSocket>>();
  private meta = new WeakMap<WebSocket, SocketMeta>();
  private rate = new WeakMap<WebSocket, number[]>();
  private typingAt = new Map<string, number>();
  private membership = new Map<string, { at: number; members: string[] }>();
  private rolesCache: { at: number; roles: RoleDef[] } | null = null;
  private readableCache = new Map<string, { at: number; entities: Set<SyncEntity>; payments: boolean }>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Protocol-level pings are answered at the edge without waking this
    // object from hibernation — the client keeps NATs alive for free.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ── Internal HTTP surface (Worker service binding only) ──────────────────

  async fetch(request: Request): Promise<Response> {
    this.hydrate();
    if (request.headers.get('x-hub-key') !== rawRealtimeSecret(this.env)) {
      return new Response('forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === '/connect' && request.headers.get('Upgrade') === 'websocket') {
        return await this.connect(url.searchParams.get('ticket') ?? '');
      }
      if (url.pathname === '/notify' && request.method === 'POST') {
        const body = await request.json<{ events?: ChangeEvent[] }>();
        await this.broadcastEvents(Array.isArray(body.events) ? body.events : []);
        return hubJson({ ok: true });
      }
      if (url.pathname === '/presence') {
        return hubJson({ presence: this.presenceSnapshot() });
      }
      if (url.pathname === '/revoke' && request.method === 'POST') {
        const body = await request.json<{ userId?: string }>();
        if (typeof body.userId === 'string') this.revokeUser(body.userId);
        return hubJson({ ok: true });
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      console.error('SyncHub error:', e);
      return new Response('error', { status: 500 });
    }
  }

  /** Upgrade a validated single-use ticket into a hibernating WebSocket. */
  private async connect(ticket: string): Promise<Response> {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(rawRealtimeSecret(this.env)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const check = await verifyTicket(ticket, key);
    if (!check.ok) return new Response(`ticket rejected: ${check.reason}`, { status: 401 });
    const payload = check.payload;
    if (payload.wid !== workspaceId(this.env)) {
      return new Response('ticket rejected: workspace', { status: 403 });
    }
    if (!(await this.consumeTicket(payload))) {
      return new Response('ticket already used', { status: 401 });
    }

    if ((this.sockets.get(payload.uid)?.size ?? 0) >= MAX_SOCKETS_PER_USER) {
      return new Response('too many connections', { status: 429 });
    }

    const pair = new WebSocketPair();
    const meta: SocketMeta = {
      userId: payload.uid,
      name: payload.name,
      role: payload.role,
      leaseUntil: Date.now() + CONNECTION_LEASE_MS,
      lastSeenAt: Date.now(),
    };
    this.state.acceptWebSocket(pair[1]);
    this.meta.set(pair[1], meta);
    pair[1].serializeAttachment(meta);
    if (!this.sockets.has(payload.uid)) this.sockets.set(payload.uid, new Set());
    this.sockets.get(payload.uid)!.add(pair[1]);
    this.readableCache.delete(payload.role); // role may have changed since

    if (this.sockets.get(payload.uid)!.size === 1) {
      this.broadcastAll(JSON.stringify({
        type: 'presence',
        changes: [{ userId: payload.uid, online: true, lastSeen: meta.lastSeenAt }],
      }));
    }
    pair[1].send(JSON.stringify({ type: 'ready', leaseUntil: meta.leaseUntil }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Single-use enforcement. Consumed ids persist across eviction. */
  private async consumeTicket(payload: RealtimeTicketPayload): Promise<boolean> {
    const storage = this.state.storage;
    const key = `ticket:${payload.jti}`;
    if (await storage.get(key)) return false;
    await storage.put(key, payload.exp);
    // Opportunistic cleanup of expired marks — no alarms needed at this scale.
    const recent = await storage.list({ limit: 100 });
    if (recent.size > 90) {
      const cutoff = Date.now() - TICKET_TTL_MS;
      for (const [k, exp] of await storage.list<number>({ prefix: 'ticket:' })) {
        if ((exp ?? 0) < cutoff) await storage.delete(k);
      }
    }
    return true;
  }

  // ── Hibernation handlers ──────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.hydrate();
    const meta = this.meta.get(ws) ?? this.readAttachment(ws);
    if (!meta) {
      try { ws.close(4403, 'unknown connection'); } catch { /* already closed */ }
      return;
    }
    if (Date.now() > meta.leaseUntil) {
      try { ws.close(4401, 'lease expired — reconnect'); } catch { /* already closed */ }
      return;
    }
    if (typeof message !== 'string') return; // binary frames are not part of the protocol
    if (message.length > MAX_MESSAGE_BYTES) {
      try { ws.close(4409, 'message too large'); } catch { /* already closed */ }
      return;
    }
    if (!this.trackRate(ws)) {
      try { ws.close(4408, 'rate limit exceeded'); } catch { /* already closed */ }
      return;
    }

    let msg: HubMessage;
    try { msg = JSON.parse(message) as HubMessage; } catch { return; } // ignore malformed frames

    switch (msg.type) {
      case 'ping': ws.send('pong'); return; // the edge usually answers these
      case 'hb':
        meta.lastSeenAt = Date.now();
        ws.serializeAttachment(meta);
        return;
      case 'reauth':
        await this.reauth(ws, meta, msg);
        return;
      case 'typing':
        await this.relayTyping(ws, meta, msg);
        return;
      case 'ack':
        await this.applyAcks(ws, meta, msg);
        return;
      default:
        return; // unknown types are ignored, never fatal
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.hydrate();
    this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.hydrate();
    this.dropSocket(ws);
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  /** Rotate identity/lease with a fresh single-use ticket. */
  private async reauth(ws: WebSocket, meta: SocketMeta, msg: HubMessage): Promise<void> {
    if (typeof msg.ticket !== 'string') return;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(rawRealtimeSecret(this.env)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const check = await verifyTicket(msg.ticket, key);
    if (!check.ok || check.payload.wid !== workspaceId(this.env)) {
      try { ws.close(4403, 're-auth rejected'); } catch { /* already closed */ }
      return;
    }
    if (!(await this.consumeTicket(check.payload))) {
      try { ws.close(4403, 'ticket replay'); } catch { /* already closed */ }
      return;
    }
    // A socket belongs to one user for life; switching identity means a new
    // connection (which is subject to the per-user socket cap).
    if (check.payload.uid !== meta.userId) {
      try { ws.close(4403, 're-auth identity mismatch'); } catch { /* already closed */ }
      return;
    }
    meta.name = check.payload.name;
    meta.role = check.payload.role;
    meta.leaseUntil = Date.now() + CONNECTION_LEASE_MS;
    meta.lastSeenAt = Date.now();
    ws.serializeAttachment(meta);
    this.readableCache.delete(meta.role);
    ws.send(JSON.stringify({ type: 'ready', leaseUntil: meta.leaseUntil }));
  }

  /** Typing: membership-checked, rate-limited, never persisted. */
  private async relayTyping(ws: WebSocket, meta: SocketMeta, msg: HubMessage): Promise<void> {
    if (typeof msg.conversationId !== 'string') return;
    const conversationId = msg.conversationId;
    const rateKey = `${meta.userId}:${conversationId}`;
    const now = Date.now();
    const last = this.typingAt.get(rateKey) ?? 0;
    if (now - last < TYPING_MIN_INTERVAL_MS) return;
    this.typingAt.set(rateKey, now);
    if (this.typingAt.size > 1000) {
      for (const [k, at] of this.typingAt) if (now - at > 60_000) this.typingAt.delete(k);
    }
    const members = await this.members(conversationId);
    if (meta.role !== ADMIN_ROLE_ID && !members.includes(meta.userId)) return;

    const payload = JSON.stringify({
      type: 'typing', conversationId, userId: meta.userId, name: meta.name, at: now,
    });
    for (const userId of members) {
      if (userId === meta.userId) continue;
      for (const socket of this.sockets.get(userId) ?? []) {
        this.deliver(socket, payload);
      }
    }
  }

  /**
   * Durable delivery/read acknowledgements. The status upgrade and its
   * change_log rows commit in one atomic D1 batch; re-sending the same ack is
   * a no-op because the WHERE clause only allows forward transitions
   * (sent -> delivered -> read), which also prevents feedback loops.
   */
  private async applyAcks(ws: WebSocket, meta: SocketMeta, msg: HubMessage): Promise<void> {
    if (typeof msg.conversationId !== 'string') return;
    const status = ackStatus(msg.status);
    if (!status) return;
    if (!Array.isArray(msg.messageIds) || msg.messageIds.length === 0 || msg.messageIds.length > MAX_ACK_IDS) return;
    const ids = msg.messageIds.filter((id): id is string => typeof id === 'string' && id.length <= 128);
    if (ids.length === 0) return;
    const conversationId = msg.conversationId;
    const members = await this.members(conversationId);
    if (meta.role !== ADMIN_ROLE_ID && !members.includes(meta.userId)) return;

    const db = this.env.VAYU_DB;
    await ensureChangeLogTable(db);
    // conversation_id is part of the WHERE: a member of this conversation
    // can't flip receipts on another conversation's messages.
    const results = await db.batch(ids.flatMap(id => statusUpgradeStmts(
      db, this.env, 'messages', id, status, { actorId: meta.userId, conversationId },
    )));
    const changed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      if ((results[i * 2].results?.length ?? 0) > 0) changed.push(ids[i]);
    }
    if (changed.length === 0) return; // idempotent re-ack — nothing to announce

    await this.broadcastEvents(
      changed.map(id => ({ entity: 'message', id, op: 'put' as const, conversationId })),
    );
  }

  // ── Event fan-out ─────────────────────────────────────────────────────────

  /** Filter committed changes per connected user and push invalidations. */
  private async broadcastEvents(events: ChangeEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Membership may have changed with these rows — drop cached answers.
    for (const event of events) {
      if ((event.entity === 'conversation' || event.entity === 'message') && event.conversationId) {
        this.membership.delete(event.conversationId);
      }
    }
    // Resolve each mentioned conversation's members once, up front.
    const convMembers = new Map<string, string[]>();
    for (const event of events) {
      if ((event.entity === 'message' || event.entity === 'conversation') && event.conversationId) {
        if (!convMembers.has(event.conversationId)) {
          convMembers.set(event.conversationId, await this.members(event.conversationId));
        }
      }
    }

    const roles = await this.getRoles();
    for (const [userId, set] of this.sockets) {
      if (set.size === 0) continue;
      const meta = this.metaFor(userId);
      const role = meta?.role ?? '';
      const access = this.readableFor(role, roles);
      const visible = events.filter(event => {
        if (event.entity === 'payments') return access.payments; // KV-backed signal
        if (!access.entities.has(event.entity as SyncEntity)) return false;
        if ((event.entity === 'message' || event.entity === 'conversation') && event.conversationId) {
          return role === ADMIN_ROLE_ID || (convMembers.get(event.conversationId) ?? []).includes(userId);
        }
        return true;
      });
      if (visible.length === 0) continue;
      const payload = JSON.stringify({ type: 'invalidate', events: visible });
      for (const socket of set) {
        this.deliver(socket, payload);
      }
    }
  }

  private presenceSnapshot(): Record<string, { isOnline: boolean; lastSeen: number }> {
    const snapshot: Record<string, { isOnline: boolean; lastSeen: number }> = {};
    for (const [userId, set] of this.sockets) {
      if (set.size === 0) continue;
      let lastSeen = 0;
      for (const socket of set) {
        const meta = this.meta.get(socket) ?? this.readAttachment(socket);
        if (meta && Date.now() <= meta.leaseUntil) lastSeen = Math.max(lastSeen, meta.lastSeenAt);
      }
      if (lastSeen === 0) continue; // only lapsed sockets left — not online
      snapshot[userId] = { isOnline: true, lastSeen: lastSeen || Date.now() };
    }
    return snapshot;
  }

  /** Close every socket of a user (logout, removal) and announce offline. */
  private revokeUser(userId: string): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const socket of set) {
      try { socket.close(4403, 'session revoked'); } catch { /* already closed */ }
    }
    this.sockets.delete(userId);
    this.broadcastAll(JSON.stringify({
      type: 'presence',
      changes: [{ userId, online: false, lastSeen: Date.now() }],
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Rebuild in-memory maps after eviction — hibernating sockets survive. */
  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    for (const socket of this.state.getWebSockets()) {
      const meta = this.readAttachment(socket);
      if (!meta) continue;
      this.meta.set(socket, meta);
      if (!this.sockets.has(meta.userId)) this.sockets.set(meta.userId, new Set());
      this.sockets.get(meta.userId)!.add(socket);
    }
  }

  private readAttachment(socket: WebSocket): SocketMeta | null {
    try {
      const meta = socket.deserializeAttachment() as SocketMeta | null;
      if (meta && meta.userId) return meta;
    } catch { /* no attachment yet */ }
    return null;
  }

  private metaFor(userId: string): SocketMeta | null {
    for (const socket of this.sockets.get(userId) ?? []) {
      const meta = this.meta.get(socket) ?? this.readAttachment(socket);
      if (meta) return meta;
    }
    return null;
  }

  private trackRate(socket: WebSocket): boolean {
    const now = Date.now();
    const marks = (this.rate.get(socket) ?? []).filter(t => now - t < RATE_WINDOW_MS);
    marks.push(now);
    this.rate.set(socket, marks);
    return marks.length <= MESSAGE_RATE_LIMIT;
  }

  private dropSocket(socket: WebSocket): void {
    const meta = this.meta.get(socket);
    this.meta.delete(socket);
    if (!meta) return;
    const set = this.sockets.get(meta.userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.sockets.delete(meta.userId);
      this.broadcastAll(JSON.stringify({
        type: 'presence',
        changes: [{ userId: meta.userId, online: false, lastSeen: meta.lastSeenAt }],
      }));
    }
  }

  /**
   * Send to one socket unless its lease has lapsed. Keepalive pings are
   * answered at the edge and never reach this object, so fan-out is where an
   * idle socket that stopped re-authenticating gets cut off.
   */
  private deliver(socket: WebSocket, payload: string): void {
    const meta = this.meta.get(socket) ?? this.readAttachment(socket);
    if (!meta || Date.now() > meta.leaseUntil) {
      try { socket.close(4401, 'lease expired — reconnect'); } catch { /* already closed */ }
      return;
    }
    try { socket.send(payload); } catch { /* close handler cleans up */ }
  }

  private broadcastAll(payload: string): void {
    for (const set of this.sockets.values()) {
      for (const socket of set) {
        this.deliver(socket, payload);
      }
    }
  }

  /** Conversation participants, cached briefly. Deleted chats yield []. */
  private async members(conversationId: string): Promise<string[]> {
    const cached = this.membership.get(conversationId);
    if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) return cached.members;
    let members: string[] = [];
    try {
      const row = await this.env.VAYU_DB.prepare(
        'SELECT participant_ids FROM conversations WHERE id = ?',
      ).bind(conversationId).first<{ participant_ids: string | null }>();
      members = row?.participant_ids ? JSON.parse(row.participant_ids) : [];
    } catch (e) {
      console.error('SyncHub membership lookup failed:', e);
    }
    this.membership.set(conversationId, { at: Date.now(), members });
    return members;
  }

  private async getRoles(): Promise<RoleDef[]> {
    if (this.rolesCache && Date.now() - this.rolesCache.at < ROLES_TTL_MS) return this.rolesCache.roles;
    try {
      const raw = await this.env.VAYU_KV.get('auth:roles');
      this.rolesCache = { at: Date.now(), roles: raw ? JSON.parse(raw) as RoleDef[] : [] };
    } catch (e) {
      console.error('SyncHub roles lookup failed:', e);
      this.rolesCache = { at: Date.now(), roles: this.rolesCache?.roles ?? [] };
    }
    return this.rolesCache.roles;
  }

  /** Entities this role may read — mirrors the REST route rules. */
  private readableFor(role: string, roles: RoleDef[]): { entities: Set<SyncEntity>; payments: boolean } {
    const cached = this.readableCache.get(role);
    if (cached && Date.now() - cached.at < ROLES_TTL_MS) return cached;
    const perms = permissionsForRoles(roles, role);
    const entry = { at: Date.now(), entities: readableEntities(perms), payments: canReadPayments(perms) };
    this.readableCache.set(role, entry);
    return entry;
  }
}
