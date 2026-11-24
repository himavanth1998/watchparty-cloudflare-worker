import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // delete rooms a week after the last person left
const MAX_URL_LENGTH = 4096;
const REASONS = new Set(["load", "play", "pause", "seek", "sync"]);
const MAX_NAME_LENGTH = 40;
const MAX_CHAT_LENGTH = 500;
const CHAT_HISTORY = 100; // messages kept so a refreshed or late joiner sees the conversation
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no look-alike characters

function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function cleanText(raw, maxLength) {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function validHttpsUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const roomId = randomId(8);
        const hostKey = randomId(32);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        if (await stub.init(hostKey)) {
          return Response.json({ roomId, hostKey });
        }
      }
      return new Response("Could not create a room, try again", { status: 500 });
    }

    // Real-Debrid's API doesn't allow browser (CORS) requests, so the page asks us instead.
    // The key is only forwarded, never stored.
    const rdMatch = pathname.match(/^\/api\/rd\/mediaInfos\/([A-Za-z0-9]{1,64})$/);
    if (rdMatch && request.method === "GET") {
      const authorization = request.headers.get("Authorization");
      if (!authorization) return Response.json({ error: "Missing API key" }, { status: 401 });
      let res;
      try {
        res = await fetch(`https://app.real-debrid.com/rest/1.0/streaming/mediaInfos/${rdMatch[1]}`, {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        return Response.json({ error: "Couldn't reach Real-Debrid" }, { status: 502 });
      }
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store" },
      });
    }

    // The host's "Your rooms" list: details about, or deletion of, a room they hold the key for.
    const infoMatch = pathname.match(/^\/api\/rooms\/([a-z0-9]{4,16})$/);
    if (infoMatch && (request.method === "GET" || request.method === "DELETE")) {
      const hostKey = request.headers.get("X-Host-Key") ?? "";
      const stub = env.ROOMS.get(env.ROOMS.idFromName(infoMatch[1]));
      const result = request.method === "GET" ? await stub.info(hostKey) : await stub.destroy(hostKey);
      return result ? Response.json(result) : Response.json({ error: "No such room" }, { status: 404 });
    }

    const wsMatch = pathname.match(/^\/api\/rooms\/([a-z0-9]{4,16})\/ws$/);
    if (wsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(wsMatch[1]));
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * One Durable Object per room. Both people can play, pause and seek; only the host
 * (whoever holds the room's hostKey) can change the video. If either person's player
 * is buffering, the room is "held": everyone pauses at the same position and playback
 * resumes together once nobody is buffering. The room also relays a chat between the two,
 * keeping the latest messages in storage. Uses the WebSocket Hibernation API so idle
 * rooms don't consume duration.
 *
 * state = { url, playing (intent), time, updatedAt, reason, by, version, holding, waiting }
 * `playing` is what people asked for; while `holding` is true nothing actually plays.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    // Heartbeats from the page are answered without waking the room.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Called over RPC by the Worker when creating a room. Returns false on id collision.
  async init(hostKey) {
    if (await this.ctx.storage.get("hostKey")) return false;
    this.state = { url: null, playing: false, time: 0, updatedAt: Date.now(), reason: "load", by: "host", version: 0, holding: false, waiting: [] };
    await this.ctx.storage.put({ hostKey, state: this.state, createdAt: Date.now(), lastActiveAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return true;
  }

  async isHost(hostKey) {
    return Boolean(hostKey) && hostKey === (await this.ctx.storage.get("hostKey"));
  }

  // Called over RPC for the host's room list. Returns null for a wrong key or a deleted room.
  async info(hostKey) {
    if (!(await this.isHost(hostKey))) return null;
    const state = await this.loadState();
    const stored = await this.ctx.storage.get(["createdAt", "lastActiveAt", "guestName", "chat"]);
    return {
      url: state.url,
      time: this.publicState(state).time,
      createdAt: stored.get("createdAt") ?? null,
      lastActiveAt: stored.get("lastActiveAt") ?? null,
      expiresAt: await this.ctx.storage.getAlarm(),
      guestName: stored.get("guestName") ?? null,
      messages: stored.get("chat")?.length ?? 0,
      online: { host: Boolean(this.onlineName("host")), viewer: Boolean(this.onlineName("viewer")) },
    };
  }

  // Called over RPC when the host deletes the room from their list.
  async destroy(hostKey) {
    if (!(await this.isHost(hostKey))) return null;
    for (const ws of this.ctx.getWebSockets()) {
      this.safeSend(ws, { type: "error", message: "The host deleted this room.", fatal: true });
      try { ws.close(4004, "Deleted"); } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = null;
    return { deleted: true };
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const hostKey = await this.ctx.storage.get("hostKey");
    if (!hostKey) return this.reject(client, server, 4004, "This room doesn't exist (or has expired).");

    const key = new URL(request.url).searchParams.get("key");
    const role = key && key === hostKey ? "host" : "viewer";

    // A browser id lets a refreshed/reopened guest replace their own stale connection
    // (the server can still see the old socket as open for a while) without letting a third
    // person kick them out.
    const params = new URL(request.url).searchParams;
    const cid = (params.get("cid") ?? "").slice(0, 64);
    const name = cleanText(params.get("name"), MAX_NAME_LENGTH) || (role === "host" ? "Host" : "Guest");
    const olds = this.ctx.getWebSockets(role).filter((old) => old.readyState === WebSocket.OPEN);
    if (role === "viewer" && olds.some((old) => old.deserializeAttachment()?.cid !== cid)) {
      return this.reject(client, server, 4001, "This room already has two people in it.");
    }
    // The same person opened the room again (new tab / reload): the newest connection wins.
    for (const old of olds) {
      this.safeSend(old, { type: "error", message: "You opened this room somewhere else." });
      try { old.close(4000, "Replaced"); } catch {}
    }

    // Drop stale holds (e.g. the buffering person left) before the newcomer joins.
    const state = await this.loadState();
    await this.refreshHold(null);

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ buffering: false, cid, name });
    await this.ctx.storage.put(role === "viewer" ? { lastActiveAt: Date.now(), guestName: name } : { lastActiveAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);

    const chat = (await this.ctx.storage.get("chat")) ?? [];
    this.safeSend(server, { type: "welcome", role, state: this.publicState(state), chat });
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const [role] = this.ctx.getTags(ws);
    if (typeof message !== "string" || message.length > MAX_URL_LENGTH + 512) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const state = await this.loadState();
    if (!state) return;

    if (msg?.type === "chat") {
      const text = cleanText(msg.text, MAX_CHAT_LENGTH);
      if (!text) return;
      const message = { from: role, name: ws.deserializeAttachment()?.name ?? role, text, at: Date.now() };
      const chat = (await this.ctx.storage.get("chat")) ?? [];
      chat.push(message);
      await this.ctx.storage.put("chat", chat.slice(-CHAT_HISTORY));
      this.broadcast({ type: "chat", message }); // the sender too, so both see the same order
      return;
    }
    if (msg?.type === "buffering") {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), buffering: Boolean(msg.buffering) });
      const hint = Number(msg.time);
      await this.refreshHold(Number.isFinite(hint) && hint >= 0 ? hint : null);
      return;
    }
    if (msg?.type !== "update" || !REASONS.has(msg.reason)) return;

    const time = Number(msg.time);
    if (!Number.isFinite(time) || time < 0) return;
    const now = Date.now();

    if (msg.reason === "sync") {
      // Heartbeat for drift correction. Ignored if it was based on an outdated state
      // (someone paused/seeked in the meantime) or while the room is held.
      if (state.holding || !state.playing || msg.base !== state.version) return;
      state.time = time;
      state.updatedAt = now;
      this.broadcast({ type: "state", state: this.publicState(state) }, ws);
      return; // memory only, to stay well inside the free-tier write quota
    }

    if (msg.reason === "load") {
      if (role !== "host") return; // only the host picks the video
      const url = validHttpsUrl(msg.url);
      if (!url) {
        this.safeSend(ws, { type: "error", message: "Only https:// URLs are allowed." });
        return;
      }
      state.url = url;
      state.playing = Boolean(msg.playing);
    } else {
      if (!state.url) return;
      if (msg.reason === "play") state.playing = true;
      else if (msg.reason === "pause") state.playing = false;
      // "seek" keeps the current intent
    }

    // Last write wins: whichever action reaches the room last defines the state.
    state.time = time;
    state.updatedAt = now;
    state.reason = msg.reason;
    state.by = role;
    state.version++;
    const waiting = this.waitingRoles();
    state.holding = state.playing && waiting.length > 0;
    state.waiting = state.holding ? waiting : [];
    await this.ctx.storage.put("state", state);

    const pub = { type: "state", state: this.publicState(state) };
    if (state.holding) {
      this.broadcast(pub); // the sender must pause too
    } else {
      this.broadcast(pub, ws);
      this.safeSend(ws, { type: "ack", version: state.version });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "Closing"); } catch {}
    await this.refreshHold(null, ws);
    this.broadcastPresence(ws);
    await this.touch();
  }

  async webSocketError(ws) {
    await this.refreshHold(null, ws);
    this.broadcastPresence(ws);
    await this.touch();
  }

  // Someone left: the room now lives for ROOM_TTL_MS from this moment.
  async touch() {
    if (!(await this.ctx.storage.get("hostKey"))) return; // deleted
    await this.ctx.storage.put("lastActiveAt", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }

  async loadState() {
    if (!this.state) {
      const stored = await this.ctx.storage.get("state");
      // Defaults cover rooms stored by older versions of this code.
      if (stored) this.state = { holding: false, waiting: [], version: 0, by: "host", ...stored };
    }
    return this.state;
  }

  // Roles whose player is currently buffering.
  waitingRoles(exclude) {
    const roles = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude || ws.readyState !== WebSocket.OPEN) continue;
      if (ws.deserializeAttachment()?.buffering) roles.add(this.ctx.getTags(ws)[0]);
    }
    return [...roles].sort();
  }

  // Start, update or end a hold depending on who is buffering. `timeHint` is the position of the
  // person who just started buffering: everyone rewinds to it so nobody misses anything.
  async refreshHold(timeHint, exclude) {
    const state = await this.loadState();
    if (!state) return;
    const waiting = this.waitingRoles(exclude);
    const holding = state.playing && waiting.length > 0;
    const sameWaiting = waiting.join() === state.waiting.join();
    if (holding === state.holding && (!holding || sameWaiting)) return;

    const now = Date.now();
    if (holding && !state.holding) {
      // Freeze the clock at the buffering person's position.
      state.time = timeHint ?? state.time + (now - state.updatedAt) / 1000;
    }
    // On resume the clock restarts from the frozen position.
    state.updatedAt = now;
    state.holding = holding;
    state.waiting = holding ? waiting : [];
    state.reason = holding ? "hold" : "resume";
    state.version++;
    await this.ctx.storage.put("state", state);
    this.broadcast({ type: "state", state: this.publicState(state) }, exclude);
  }

  // Extrapolate the playback position to "now" so late joiners land in the right spot.
  publicState(state) {
    const live = state.playing && !state.holding;
    const elapsed = live ? (Date.now() - state.updatedAt) / 1000 : 0;
    return {
      url: state.url,
      playing: live,
      time: state.time + elapsed,
      reason: state.reason,
      by: state.by,
      version: state.version,
      waiting: state.holding ? state.waiting : [],
    };
  }

  // Name of the connected person with this role, or null if they're offline.
  onlineName(role, exclude) {
    const ws = this.ctx.getWebSockets(role).find((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
    return ws ? ws.deserializeAttachment()?.name ?? role : null;
  }

  broadcast(data, exclude) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude) this.safeSend(ws, data);
    }
  }

  broadcastPresence(exclude) {
    const host = this.onlineName("host", exclude);
    const viewer = this.onlineName("viewer", exclude);
    this.broadcast({ type: "presence", host: Boolean(host), viewer: Boolean(viewer), hostName: host, viewerName: viewer }, exclude);
  }

  safeSend(ws, data) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }

  reject(client, server, code, message) {
    server.accept();
    this.safeSend(server, { type: "error", message, fatal: true });
    server.close(code, "Rejected");
    return new Response(null, { status: 101, webSocket: client });
  }
}
