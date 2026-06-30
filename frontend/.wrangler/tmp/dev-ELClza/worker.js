var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.ts
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
var SESSION_TTL_DAYS = 30;
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}
__name(json, "json");
function err(message, status = 400) {
  return json({ error: message }, status);
}
__name(err, "err");
function b64(arr) {
  return btoa(String.fromCodePoint(...arr));
}
__name(b64, "b64");
function fromB64(s) {
  return new Uint8Array(atob(s).split("").map((c) => c.codePointAt(0)));
}
__name(fromB64, "fromB64");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 1e5 },
    key,
    256
  );
  return `${b64(salt)}.${b64(new Uint8Array(bits))}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(".");
  const salt = fromB64(saltB64);
  const expected = fromB64(hashB64);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 1e5 },
    key,
    256
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
__name(verifyPassword, "verifyPassword");
function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(generateToken, "generateToken");
async function getSession(request, kv) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  const raw = await kv.get(`auth:session:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (session.expiresAt < Date.now()) {
    await kv.delete(`auth:session:${token}`);
    return null;
  }
  return session;
}
__name(getSession, "getSession");
function stripPassword(user) {
  const { hashedPassword: _h, ...pub } = user;
  return pub;
}
__name(stripPassword, "stripPassword");
function rowToConversation(row) {
  return {
    id: row.id,
    participantIds: JSON.parse(row.participant_ids),
    participantNames: JSON.parse(row.participant_names),
    lastMessage: row.last_message,
    lastMessageTime: row.last_message_time,
    unreadCount: row.unread_count,
    title: row.title || void 0,
    reason: row.reason || void 0,
    note: row.note || void 0,
    isGroup: !!row.is_group,
    groupName: row.group_name || void 0,
    isPinned: !!row.is_pinned,
    isArchived: !!row.is_archived
  };
}
__name(rowToConversation, "rowToConversation");
function rowToMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    tags: JSON.parse(row.tags),
    timestamp: row.timestamp,
    status: row.status,
    replyTo: row.reply_to ? JSON.parse(row.reply_to) : void 0,
    attachment: row.attachment ? JSON.parse(row.attachment) : void 0
  };
}
__name(rowToMessage, "rowToMessage");
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method;
    try {
      if (path === "/auth/status" && method === "GET") {
        const count = await env.VAYU_KV.get("auth:count");
        return json({ needsSetup: !count || Number.parseInt(count) === 0 });
      }
      if (path === "/auth/setup" && method === "POST") {
        const count = await env.VAYU_KV.get("auth:count");
        if (count && Number.parseInt(count) > 0) return err("Setup already complete", 403);
        const body = await request.json();
        const { name, email, password } = body;
        if (!name || !email || !password) return err("name, email and password are required");
        if (password.length < 6) return err("Password must be at least 6 characters");
        const id = `admin_${Date.now()}`;
        const user = {
          id,
          name,
          email: email.toLowerCase().trim(),
          hashedPassword: await hashPassword(password),
          role: "admin",
          createdAt: Date.now()
        };
        await env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
        await env.VAYU_KV.put(`auth:email:${user.email}`, id);
        await env.VAYU_KV.put("auth:count", "1");
        return json({ success: true });
      }
      if (path === "/auth/login" && method === "POST") {
        const loginBody = await request.json();
        const { email, password } = loginBody;
        if (!email || !password) return err("email and password are required");
        const userId = await env.VAYU_KV.get(`auth:email:${email.toLowerCase().trim()}`);
        if (!userId) return err("Invalid email or password", 401);
        const raw = await env.VAYU_KV.get(`auth:user:${userId}`);
        if (!raw) return err("Invalid email or password", 401);
        const user = JSON.parse(raw);
        if (!await verifyPassword(password, user.hashedPassword)) return err("Invalid email or password", 401);
        const token = generateToken();
        const session = {
          userId: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          expiresAt: Date.now() + SESSION_TTL_DAYS * 864e5
        };
        await env.VAYU_KV.put(`auth:session:${token}`, JSON.stringify(session), {
          expirationTtl: SESSION_TTL_DAYS * 86400
        });
        return json({ token, user: stripPassword(user) });
      }
      if (path === "/auth/me" && method === "GET") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const raw = await env.VAYU_KV.get(`auth:user:${session.userId}`);
        if (!raw) return err("User not found", 404);
        return json(stripPassword(JSON.parse(raw)));
      }
      if (path === "/auth/logout" && method === "POST") {
        const auth = request.headers.get("Authorization");
        if (auth?.startsWith("Bearer ")) {
          await env.VAYU_KV.delete(`auth:session:${auth.slice(7).trim()}`);
        }
        return json({ success: true });
      }
      if (path === "/auth/users" && method === "GET") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        if (session.role !== "admin") return err("Forbidden", 403);
        const list = await env.VAYU_KV.list({ prefix: "auth:user:" });
        const users = [];
        for (const key of list.keys) {
          const raw = await env.VAYU_KV.get(key.name);
          if (raw) users.push(stripPassword(JSON.parse(raw)));
        }
        users.sort((a, b) => a.createdAt - b.createdAt);
        return json(users);
      }
      if (path === "/auth/team" && method === "GET") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const list = await env.VAYU_KV.list({ prefix: "auth:user:" });
        const users = [];
        for (const key of list.keys) {
          const raw = await env.VAYU_KV.get(key.name);
          if (raw) users.push(stripPassword(JSON.parse(raw)));
        }
        users.sort((a, b) => a.createdAt - b.createdAt);
        return json(users);
      }
      if (path === "/auth/users" && method === "POST") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        if (session.role !== "admin") return err("Forbidden", 403);
        const addBody = await request.json();
        const { name, email, password, role } = addBody;
        if (!name || !email || !password) return err("name, email and password are required");
        if (password.length < 6) return err("Password must be at least 6 characters");
        const emailKey = `auth:email:${email.toLowerCase().trim()}`;
        if (await env.VAYU_KV.get(emailKey)) return err("A user with this email already exists", 409);
        const id = `user_${Date.now()}`;
        const user = {
          id,
          name,
          email: email.toLowerCase().trim(),
          hashedPassword: await hashPassword(password),
          role: role === "admin" ? "admin" : "user",
          createdAt: Date.now()
        };
        await env.VAYU_KV.put(`auth:user:${id}`, JSON.stringify(user));
        await env.VAYU_KV.put(emailKey, id);
        const countRaw = await env.VAYU_KV.get("auth:count");
        await env.VAYU_KV.put("auth:count", String((countRaw ? Number.parseInt(countRaw) : 0) + 1));
        return json(stripPassword(user), 201);
      }
      if (path.startsWith("/auth/users/") && method === "DELETE") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        if (session.role !== "admin") return err("Forbidden", 403);
        const userId = path.slice("/auth/users/".length);
        if (userId === session.userId) return err("Cannot delete your own account", 400);
        const raw = await env.VAYU_KV.get(`auth:user:${userId}`);
        if (!raw) return err("User not found", 404);
        const user = JSON.parse(raw);
        await env.VAYU_KV.delete(`auth:user:${userId}`);
        await env.VAYU_KV.delete(`auth:email:${user.email}`);
        const countRaw = await env.VAYU_KV.get("auth:count");
        if (countRaw) await env.VAYU_KV.put("auth:count", String(Math.max(0, Number.parseInt(countRaw) - 1)));
        return json({ success: true });
      }
      if (path === "/upload" && method === "POST") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file || typeof file === "string") return err("No file provided");
        if (file.size > 100 * 1024 * 1024) return err("File too large (max 100MB)");
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        const key = `uploads/${session.userId}/${Date.now()}-${crypto.randomUUID()}${ext ? "." + ext : ""}`;
        await env.VAYU_R2.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" }
        });
        return json({ key, url: `/api/files/${key}` });
      }
      if (path.startsWith("/files/") && method === "GET") {
        const key = decodeURIComponent(path.slice("/files/".length));
        if (!key) return err("File not found", 404);
        const obj = await env.VAYU_R2.get(key);
        if (!obj) return err("File not found", 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(obj.body, { status: 200, headers });
      }
      if (path.startsWith("/files/") && method === "DELETE") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const key = decodeURIComponent(path.slice("/files/".length));
        if (!key) return err("File not found", 404);
        const obj = await env.VAYU_R2.head(key);
        if (!obj) return err("File not found", 404);
        await env.VAYU_R2.delete(key);
        return json({ success: true });
      }
      if (path === "/conversations" && method === "GET") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const results = await env.VAYU_DB.prepare(
          "SELECT * FROM conversations ORDER BY is_pinned DESC, last_message_time DESC"
        ).all();
        const rows = results.results || [];
        const convos = rows.map(rowToConversation).filter((c) => c.participantIds.includes(session.userId));
        return json(convos);
      }
      if (path === "/conversations" && method === "POST") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const body = await request.json();
        const conv = body;
        if (!conv.id || !conv.participantIds) return err("id and participantIds are required");
        await env.VAYU_DB.prepare(
          `INSERT OR REPLACE INTO conversations
           (id, participant_ids, participant_names, last_message, last_message_time,
            unread_count, title, reason, note, is_group, group_name, is_pinned, is_archived, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          conv.id,
          JSON.stringify(conv.participantIds),
          JSON.stringify(conv.participantNames || []),
          conv.lastMessage || "",
          conv.lastMessageTime || Date.now(),
          conv.unreadCount || 0,
          conv.title || null,
          conv.reason || null,
          conv.note || null,
          conv.isGroup ? 1 : 0,
          conv.groupName || null,
          conv.isPinned ? 1 : 0,
          conv.isArchived ? 1 : 0,
          Date.now()
        ).run();
        return json(conv, 201);
      }
      if (path.startsWith("/conversations/") && method === "PUT") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const convId = path.slice("/conversations/".length);
        const body = await request.json();
        const conv = body;
        await env.VAYU_DB.prepare(
          `UPDATE conversations SET
             participant_ids = ?, participant_names = ?, last_message = ?,
             last_message_time = ?, unread_count = ?, title = ?, reason = ?,
             note = ?, is_group = ?, group_name = ?, is_pinned = ?, is_archived = ?
           WHERE id = ?`
        ).bind(
          JSON.stringify(conv.participantIds),
          JSON.stringify(conv.participantNames || []),
          conv.lastMessage || "",
          conv.lastMessageTime || Date.now(),
          conv.unreadCount || 0,
          conv.title || null,
          conv.reason || null,
          conv.note || null,
          conv.isGroup ? 1 : 0,
          conv.groupName || null,
          conv.isPinned ? 1 : 0,
          conv.isArchived ? 1 : 0,
          convId
        ).run();
        return json(conv);
      }
      if (path === "/messages" && method === "GET") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const conversationId = url.searchParams.get("conversationId");
        let results;
        if (conversationId) {
          results = await env.VAYU_DB.prepare(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC"
          ).bind(conversationId).all();
        } else {
          const convResults = await env.VAYU_DB.prepare("SELECT id, participant_ids FROM conversations").all();
          const convRows = convResults.results || [];
          const userConvIds = convRows.filter((r) => {
            try {
              return JSON.parse(r.participant_ids).includes(session.userId);
            } catch {
              return false;
            }
          }).map((r) => r.id);
          if (userConvIds.length === 0) return json([]);
          const placeholders = userConvIds.map(() => "?").join(",");
          results = await env.VAYU_DB.prepare(
            `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY timestamp ASC`
          ).bind(...userConvIds).all();
        }
        const messages = (results.results || []).map(rowToMessage);
        return json(messages);
      }
      if (path === "/messages" && method === "POST") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const body = await request.json();
        const msg = body;
        if (!msg.id || !msg.conversationId) return err("id and conversationId are required");
        await env.VAYU_DB.prepare(
          `INSERT OR REPLACE INTO messages
           (id, conversation_id, sender_id, sender_name, text, tags, timestamp,
            status, reply_to, attachment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          msg.id,
          msg.conversationId,
          msg.senderId,
          msg.senderName || "",
          msg.text || "",
          JSON.stringify(msg.tags || []),
          msg.timestamp || Date.now(),
          msg.status || "sent",
          msg.replyTo ? JSON.stringify(msg.replyTo) : null,
          msg.attachment ? JSON.stringify(msg.attachment) : null,
          Date.now()
        ).run();
        const lastMsgPreview = msg.attachment ? msg.attachment.type === "image" ? "\u{1F4F7} Photo" : `\u{1F4CE} ${msg.attachment.name}` : msg.text;
        await env.VAYU_DB.prepare(
          `UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?`
        ).bind(lastMsgPreview, msg.timestamp || Date.now(), msg.conversationId).run();
        return json(msg, 201);
      }
      if (path.startsWith("/messages/") && path.endsWith("/status") && method === "PUT") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const msgId = path.slice("/messages/".length, -"/status".length);
        const body = await request.json();
        const { status } = body;
        if (!status) return err("status is required");
        await env.VAYU_DB.prepare(
          "UPDATE messages SET status = ? WHERE id = ?"
        ).bind(status, msgId).run();
        return json({ success: true });
      }
      if (path === "/messages/status-batch" && method === "PUT") {
        const session = await getSession(request, env.VAYU_KV);
        if (!session) return err("Unauthorized", 401);
        const body = await request.json();
        const { messageIds, status } = body;
        if (!messageIds || !status) return err("messageIds and status are required");
        for (const id of messageIds) {
          await env.VAYU_DB.prepare(
            "UPDATE messages SET status = ? WHERE id = ?"
          ).bind(status, id).run();
        }
        return json({ success: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-DWoerF/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-DWoerF/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
