/**
 * One realtime socket per signed-in user per browser, not per tab.
 *
 * Tabs elect a leader with the Web Locks API; only the leader opens the
 * WebSocket to /api/realtime/ws and relays what it hears to the other tabs over
 * a BroadcastChannel. When the leader tab closes its lock is released and a
 * waiting tab takes over. Without Web Locks every tab connects on its own (the
 * hub caps sockets per user).
 *
 * Events are signals only ("something changed"); each tab fetches the actual
 * rows through /api/sync. A dropped event is harmless — the safety sync and
 * reconnect catch-up recover it.
 */
import { authHeaders } from './apiClient';
import { apiBase } from './workspace';

export interface ChangeEvent {
    entity: string;
    id: string;
    op: 'put' | 'delete';
    conversationId?: string;
}

export interface PresenceChange {
    userId: string;
    online: boolean;
    lastSeen: number;
}

export type RealtimeEvent =
    | { type: 'invalidate'; events: ChangeEvent[] }
    | { type: 'presence'; changes: PresenceChange[] }
    | { type: 'typing'; conversationId: string; userId: string; name: string; at: number }
    | { type: 'status'; connected: boolean };

type Listener = (event: RealtimeEvent) => void;

/** Relay protocol between tabs of the same user. */
type TabMessage = RealtimeEvent | { type: 'status-query' };

const KEEPALIVE_MS = 30_000;
/** Re-authenticate this long before the hub's 10-minute lease runs out. */
const REAUTH_MARGIN_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Realtime switched off server-side (404): look again after this. */
const DISABLED_RETRY_MS = 30 * 60_000;

class RealtimeService {
    private userId: string | null = null;
    /** Bumped on every start/stop so callbacks from an old session no-op. */
    private generation = 0;
    private leader = false;
    private socket: WebSocket | null = null;
    private channel: BroadcastChannel | null = null;
    private lockAbort: AbortController | null = null;
    private releaseLock: (() => void) | null = null;
    private attempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private reauthTimer: ReturnType<typeof setTimeout> | undefined;
    private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    private listeners = new Set<Listener>();
    private isConnected = false;

    /** True when this browser has a live socket (in this tab or the leader tab). */
    get connected(): boolean {
        return this.isConnected;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    start(userId: string): void {
        if (this.userId === userId) return;
        this.stop();
        this.userId = userId;
        const gen = ++this.generation;

        if (typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel(`vayu_realtime:${userId}`);
            this.channel.onmessage = event => this.onTabMessage(event.data as TabMessage);
            this.channel.postMessage({ type: 'status-query' } satisfies TabMessage);
        }
        window.addEventListener('online', this.onOnline);

        if (typeof navigator !== 'undefined' && navigator.locks) {
            const abort = new AbortController();
            this.lockAbort = abort;
            navigator.locks.request(`vayu_realtime:${userId}`, { signal: abort.signal }, () => {
                if (gen !== this.generation) return undefined;
                this.leader = true;
                // Status relayed from the previous leader no longer applies;
                // our own first `ready` must count as a (re)connect.
                this.setConnected(false);
                void this.connect(gen);
                // Hold the lock until stop() releases it (or the tab goes away).
                return new Promise<void>(resolve => { this.releaseLock = resolve; });
            }).catch(() => { /* aborted by stop() */ });
        } else {
            this.leader = true;
            void this.connect(gen);
        }
    }

    stop(): void {
        if (this.userId === null) return;
        this.generation++;
        if (this.leader && this.isConnected) this.relay({ type: 'status', connected: false });
        this.lockAbort?.abort();
        this.lockAbort = null;
        this.releaseLock?.();
        this.releaseLock = null;
        this.leader = false;
        this.clearTimers();
        const socket = this.socket;
        this.socket = null;
        try { socket?.close(1000, 'signed out'); } catch { /* already closed */ }
        this.channel?.close();
        this.channel = null;
        window.removeEventListener('online', this.onOnline);
        this.userId = null;
        this.attempts = 0;
        this.setConnected(false);
    }

    /** Typing indicator for a conversation (leader tab only; best effort). */
    sendTyping(conversationId: string): void {
        this.send({ type: 'typing', conversationId });
    }

    // ── Leader: socket lifecycle ──────────────────────────────────────────

    private readonly onOnline = () => {
        if (this.leader && !this.socket) {
            this.attempts = 0;
            this.scheduleReconnect(this.generation, 0);
        }
    };

    private async connect(gen: number): Promise<void> {
        if (gen !== this.generation || !this.leader || this.socket) return;
        if (!navigator.onLine) return; // the online event resumes us

        const ticket = await this.fetchTicket();
        if (gen !== this.generation) return;
        if (ticket === 'disabled') { this.scheduleReconnect(gen, DISABLED_RETRY_MS); return; }
        if (ticket === 'unauthorized') return; // session gone; sign-in restarts us
        if (ticket === null) { this.scheduleReconnect(gen); return; }

        const url = `${location.origin.replace(/^http/, 'ws')}${apiBase()}/realtime/ws?ticket=${encodeURIComponent(ticket)}`;
        let socket: WebSocket;
        try {
            socket = new WebSocket(url);
        } catch {
            this.scheduleReconnect(gen);
            return;
        }
        this.socket = socket;
        socket.onmessage = event => this.onSocketMessage(gen, event.data);
        socket.onclose = event => this.onSocketClose(gen, socket, event.code);
        socket.onerror = () => { /* onclose follows */ };
    }

    /** A fresh single-use ticket; every connect and re-auth needs its own. */
    private async fetchTicket(): Promise<string | 'disabled' | 'unauthorized' | null> {
        try {
            const res = await fetch(`${apiBase()}/realtime/ticket`, {
                method: 'POST',
                headers: authHeaders(),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 404) return 'disabled';
            if (res.status === 401) return 'unauthorized';
            if (!res.ok) return null;
            const body = await res.json() as { ticket?: unknown };
            return typeof body.ticket === 'string' ? body.ticket : null;
        } catch {
            return null;
        }
    }

    private onSocketMessage(gen: number, data: unknown): void {
        if (gen !== this.generation || typeof data !== 'string' || data === 'pong') return;
        let message: { type?: string; leaseUntil?: number } & Record<string, unknown>;
        try { message = JSON.parse(data); } catch { return; }
        switch (message.type) {
            case 'ready': {
                const firstReady = !this.isConnected;
                this.attempts = 0;
                this.setConnected(true);
                this.relay({ type: 'status', connected: true });
                this.startKeepalive(gen);
                this.scheduleReauth(gen, Number(message.leaseUntil) || Date.now() + 10 * 60_000);
                // Catch up on anything missed while disconnected.
                if (firstReady) this.emitBoth({ type: 'invalidate', events: [] });
                return;
            }
            case 'invalidate':
                if (Array.isArray(message.events)) this.emitBoth({ type: 'invalidate', events: message.events as ChangeEvent[] });
                return;
            case 'presence':
                if (Array.isArray(message.changes)) this.emitBoth({ type: 'presence', changes: message.changes as PresenceChange[] });
                return;
            case 'typing':
                this.emitBoth(message as unknown as RealtimeEvent);
                return;
            default:
                return;
        }
    }

    private onSocketClose(gen: number, socket: WebSocket, code: number): void {
        if (this.socket === socket) this.socket = null;
        if (gen !== this.generation) return;
        this.clearTimers();
        if (this.isConnected) {
            this.setConnected(false);
            this.relay({ type: 'status', connected: false });
        }
        // 4401: lease lapsed — reconnect straight away with a new ticket.
        // 4403: revoked (e.g. this user signed out on another device) or
        // re-auth refused; a new ticket succeeds only if our session is still
        // valid, so a normal backoff is enough.
        if (code === 4401) { this.scheduleReconnect(gen, 0); return; }
        this.scheduleReconnect(gen);
    }

    private scheduleReconnect(gen: number, delayMs?: number): void {
        if (gen !== this.generation) return;
        clearTimeout(this.reconnectTimer);
        const delay = delayMs ?? Math.min(BACKOFF_BASE_MS * 2 ** this.attempts, BACKOFF_MAX_MS) * (0.5 + Math.random());
        this.attempts = Math.min(this.attempts + 1, 10);
        this.reconnectTimer = setTimeout(() => { void this.connect(gen); }, delay);
    }

    private scheduleReauth(gen: number, leaseUntil: number): void {
        clearTimeout(this.reauthTimer);
        const delay = Math.max(leaseUntil - Date.now() - REAUTH_MARGIN_MS, 30_000);
        this.reauthTimer = setTimeout(async () => {
            if (gen !== this.generation || !this.socket) return;
            const ticket = await this.fetchTicket();
            if (gen !== this.generation) return;
            if (typeof ticket === 'string' && ticket !== 'disabled' && ticket !== 'unauthorized') {
                this.send({ type: 'reauth', ticket });
            } else {
                // Can't renew: drop the socket and let the reconnect path decide.
                try { this.socket?.close(1000, 're-auth failed'); } catch { /* already closed */ }
            }
        }, delay);
    }

    private startKeepalive(gen: number): void {
        clearInterval(this.keepaliveTimer);
        // Answered at the edge by the hub's auto-response — never wakes it.
        this.keepaliveTimer = setInterval(() => {
            if (gen !== this.generation) return;
            try { this.socket?.send('ping'); } catch { /* close handler reconnects */ }
        }, KEEPALIVE_MS);
    }

    private clearTimers(): void {
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.reauthTimer);
        clearInterval(this.keepaliveTimer);
    }

    private send(message: Record<string, unknown>): void {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        try { this.socket.send(JSON.stringify(message)); } catch { /* close handler reconnects */ }
    }

    // ── Fan-out ───────────────────────────────────────────────────────────

    private onTabMessage(message: TabMessage): void {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'status-query') {
            if (this.leader) this.relay({ type: 'status', connected: this.isConnected });
            return;
        }
        if (this.leader) return; // the leader is the source, not a follower
        if (message.type === 'status') this.setConnected(message.connected);
        else this.emit(message);
    }

    /** Deliver to this tab's listeners and relay to the other tabs. */
    private emitBoth(event: RealtimeEvent): void {
        this.emit(event);
        this.relay(event);
    }

    private relay(message: TabMessage): void {
        try { this.channel?.postMessage(message); } catch { /* channel closed */ }
    }

    private setConnected(connected: boolean): void {
        if (this.isConnected === connected) return;
        this.isConnected = connected;
        this.emit({ type: 'status', connected });
    }

    private emit(event: RealtimeEvent): void {
        for (const listener of this.listeners) {
            try { listener(event); } catch (err) { console.warn('Realtime listener failed', err); }
        }
    }
}

export const realtimeService = new RealtimeService();
