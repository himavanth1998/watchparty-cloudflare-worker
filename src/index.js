import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // delete rooms idle for a week
const MAX_URL_LENGTH = 4096;
const REASONS = new Set(["load", "play", "pause", "seek", "sync"]);
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no look-alike characters

function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
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
 * One Durable Object per room. The host (whoever holds the room's hostKey)
 * drives playback; at most one viewer follows along. Uses the WebSocket
 * Hibernation API so idle rooms don't consume duration.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
  }

  // Called over RPC by the Worker when creating a room. Returns false on id collision.
  async init(hostKey) {
    if (await this.ctx.storage.get("hostKey")) return false;
    this.state = { url: null, playing: false, time: 0, updatedAt: Date.now(), reason: "load" };
    await this.ctx.storage.put({ hostKey, state: this.state });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return true;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const hostKey = await this.ctx.storage.get("hostKey");
    if (!hostKey) return this.reject(client, server, 4004, "This room doesn't exist (or has expired).");

    const key = new URL(request.url).searchParams.get("key");
    const role = key && key === hostKey ? "host" : "viewer";

    if (role === "viewer" && this.isOnline("viewer")) {
      return this.reject(client, server, 4001, "This room already has two people in it.");
    }
    if (role === "host") {
      // The host opened the room again (new tab / reload): the newest connection wins.
      for (const old of this.ctx.getWebSockets("host")) {
        this.safeSend(old, { type: "error", message: "You opened this room somewhere else." });
        try { old.close(4000, "Replaced"); } catch {}
      }
    }

    this.ctx.acceptWebSocket(server, [role]);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);

    const state = await this.loadState();
    this.safeSend(server, { type: "welcome", role, state: this.publicState(state) });
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const [role] = this.ctx.getTags(ws);
    if (role !== "host" || typeof message !== "string" || message.length > MAX_URL_LENGTH + 512) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg?.type !== "update") return;

    const url = msg.url == null ? null : validHttpsUrl(msg.url);
    if (msg.url != null && !url) {
      this.safeSend(ws, { type: "error", message: "Only https:// URLs are allowed." });
      return;
    }
    const time = Number(msg.time);
    if (!Number.isFinite(time) || time < 0) return;

    this.state = {
      url,
      playing: Boolean(msg.playing),
      time,
      updatedAt: Date.now(),
      reason: REASONS.has(msg.reason) ? msg.reason : "sync",
    };
    // Periodic syncs only live in memory to stay well inside the free-tier write quota;
    // the last discrete event is enough to extrapolate position after hibernation.
    if (this.state.reason !== "sync") await this.ctx.storage.put("state", this.state);

    for (const viewer of this.ctx.getWebSockets("viewer")) {
      this.safeSend(viewer, { type: "state", state: this.publicState(this.state) });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "Closing"); } catch {}
    this.broadcastPresence(ws);
  }

  async webSocketError(ws) {
    this.broadcastPresence(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }

  async loadState() {
    this.state ??= await this.ctx.storage.get("state");
    return this.state;
  }

  // Extrapolate the playback position to "now" so late joiners land in the right spot.
  publicState(state) {
    const elapsed = state.playing ? (Date.now() - state.updatedAt) / 1000 : 0;
    return { url: state.url, playing: state.playing, time: state.time + elapsed, reason: state.reason };
  }

  isOnline(role, exclude) {
    return this.ctx
      .getWebSockets(role)
      .some((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  broadcastPresence(exclude) {
    const presence = { type: "presence", host: this.isOnline("host", exclude), viewer: this.isOnline("viewer", exclude) };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude) this.safeSend(ws, presence);
    }
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
