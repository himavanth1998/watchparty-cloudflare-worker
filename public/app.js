const $ = (id) => document.getElementById(id);
const video = $("video");

const HLS_MODULE = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.mjs";
const SYNC_INTERVAL_MS = 4000;

// ---------- shared player helpers ----------

let hls = null;
let currentUrl = null;
let loadToken = 0;

function parseHttpsUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function showMessage(text, kind = "error") {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}

async function loadSource(url) {
  const token = ++loadToken;
  currentUrl = url;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.removeAttribute("src");
  video.load();
  if (!url) return;

  $("player-wrap").hidden = false;
  showMessage("");

  const isHls = new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
    const { default: Hls } = await import(HLS_MODULE);
    if (token !== loadToken) return;
    if (Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) showMessage(`Couldn't play this stream (${data.details}). HLS needs the server to allow CORS.`);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }
  }
  video.src = url;
}

function whenReady() {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", done);
      resolve();
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", done);
  });
}

video.addEventListener("error", () => {
  if (!currentUrl || hls) return;
  showMessage(
    "Couldn't play this URL. It may not be a direct media file, the format may be unsupported by this browser, or the server may block it.",
  );
});

// ---------- home page ----------

function startHome() {
  $("home").hidden = false;
  video.controls = true;

  $("url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = parseHttpsUrl($("url-input").value);
    if (!url) return showMessage("Please enter a valid https:// URL.");
    await loadSource(url);
    video.play().catch(() => {});
  });

  $("create-room").addEventListener("click", async () => {
    const raw = $("url-input").value.trim();
    const url = raw ? parseHttpsUrl(raw) : null;
    if (raw && !url) return showMessage("Please enter a valid https:// URL, or leave it empty.");
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { roomId, hostKey } = await res.json();
      localStorage.setItem(`wt-host:${roomId}`, hostKey);
      if (url) sessionStorage.setItem(`wt-pending-url:${roomId}`, url);
      location.href = `/room/${roomId}`;
    } catch (err) {
      showMessage(`Couldn't create a room: ${err.message}`);
    }
  });

  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = $("join-input").value.trim();
    const code = (raw.match(/room\/([a-z0-9]+)/i)?.[1] ?? raw).toLowerCase();
    if (!/^[a-z0-9]{4,16}$/.test(code)) return showMessage("That doesn't look like a room code.");
    location.href = `/room/${code}`;
  });
}

// ---------- room ----------

function startRoom(roomId) {
  const hostKey = localStorage.getItem(`wt-host:${roomId}`);
  let clientId = localStorage.getItem("wt-client");
  if (!clientId) {
    clientId = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem("wt-client", clientId);
  }
  let ws = null;
  let role = null;
  let retryDelay = 1000;
  let stopped = false;
  let unlocked = false; // the browser allows playback with sound (the user has clicked)
  let latest = null; // latest room state received, with receivedAt
  let version = 0; // newest room state version we know about
  let appliedPlaying = false; // what the room last told our player to do
  let programmaticSeek = null; // position of a seek we caused ourselves
  let myBuffering = false; // we told the room our player is stalled
  let waitingShown = false;

  $("room").hidden = false;
  $("room-code").textContent = roomId;
  video.controls = true; // both people can play, pause and seek

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const query = `?cid=${clientId}${hostKey ? `&key=${encodeURIComponent(hostKey)}` : ""}`;
    ws = new WebSocket(`${proto}://${location.host}/api/rooms/${roomId}/ws${query}`);

    ws.addEventListener("open", () => {
      retryDelay = 1000;
      myBuffering = false; // a fresh connection starts with a clean buffering flag
    });
    ws.addEventListener("message", (e) => handleMessage(JSON.parse(e.data)));
    ws.addEventListener("close", (e) => {
      if (stopped || [4000, 4001, 4004].includes(e.code)) return;
      $("presence").textContent = "Reconnecting…";
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "welcome":
        setRole(msg.role);
        version = msg.state.version;
        resume(msg.state);
        break;
      case "state":
        version = msg.state.version;
        receiveState(msg.state);
        break;
      case "ack":
        version = msg.version;
        break;
      case "presence":
        renderPresence(msg);
        break;
      case "error":
        showMessage(msg.message);
        if (msg.fatal) stopped = true;
        break;
    }
  }

  function setRole(newRole) {
    role = newRole;
    const isHost = role === "host";
    const badge = $("role-badge");
    badge.textContent = isHost ? "You're the host" : "Guest";
    badge.classList.toggle("host", isHost);
    $("copy-link").hidden = !isHost;
    $("room-url-form").hidden = !isHost;
    if (isHost) {
      unlocked = true; // if the browser disagrees, play() fails and the overlay appears
    } else if (!unlocked) {
      $("player-wrap").hidden = false;
      $("overlay").hidden = false;
    }
  }

  function renderPresence({ host, viewer }) {
    $("presence").textContent =
      role === "host"
        ? viewer ? "🟢 Your friend is here" : "⚪ Waiting for your friend to join…"
        : host ? "🟢 Host is online" : "⚪ Host is offline";
  }

  // ----- sending -----

  function sendUpdate(reason) {
    if (!role || ws?.readyState !== WebSocket.OPEN) return;
    const msg = {
      type: "update",
      reason,
      playing: !video.paused && !video.ended,
      time: video.currentTime || 0,
      base: version, // lets the room discard heartbeats that raced with a newer action
    };
    if (reason === "load") msg.url = currentUrl;
    ws.send(JSON.stringify(msg));
  }

  // Tell the room when our player stalls or recovers so both sides can wait for each other.
  function setBuffering(buffering) {
    if (myBuffering === buffering || ws?.readyState !== WebSocket.OPEN) return;
    myBuffering = buffering;
    ws.send(JSON.stringify({ type: "buffering", buffering, time: video.currentTime || 0 }));
  }

  function checkReady() {
    if (myBuffering && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) setBuffering(false);
  }

  // Events caused by applyState() match what the room already knows, so only genuine
  // user actions (which differ from the room's state) get sent.
  video.addEventListener("play", () => {
    if (appliedPlaying) return;
    appliedPlaying = true;
    sendUpdate("play");
  });
  video.addEventListener("pause", () => {
    if (!appliedPlaying) return;
    appliedPlaying = false;
    sendUpdate("pause");
  });
  video.addEventListener("seeked", () => {
    const ours = programmaticSeek !== null && Math.abs(video.currentTime - programmaticSeek) < 0.5;
    programmaticSeek = null;
    if (!ours) sendUpdate("seek");
  });
  video.addEventListener("waiting", () => {
    if (!video.paused && appliedPlaying) setBuffering(true);
  });
  video.addEventListener("canplay", checkReady);
  video.addEventListener("playing", checkReady);
  setInterval(checkReady, 1000);

  setInterval(() => {
    // Drift correction: the host's position is the reference while playing normally.
    if (role === "host" && !video.paused && appliedPlaying && !myBuffering) sendUpdate("sync");
  }, SYNC_INTERVAL_MS);

  $("room-url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = parseHttpsUrl($("room-url-input").value);
    if (!url) return showMessage("Please enter a valid https:// URL.");
    await loadSource(url);
    appliedPlaying = false;
    sendUpdate("load");
  });

  $("copy-link").addEventListener("click", async () => {
    const link = `${location.origin}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      showMessage(`Invite link copied: ${link}`, "info");
    } catch {
      showMessage(`Share this link: ${link}`, "info");
    }
  });

  // ----- receiving -----

  async function resume(state) {
    const pending = sessionStorage.getItem(`wt-pending-url:${roomId}`);
    sessionStorage.removeItem(`wt-pending-url:${roomId}`);

    if (role === "host" && !state.url && pending) {
      await loadSource(pending);
      $("room-url-input").value = pending;
      sendUpdate("load");
    } else {
      receiveState(state);
    }
  }

  function receiveState(state) {
    latest = { ...state, receivedAt: performance.now() };
    applyState();
  }

  function renderWaiting(s) {
    if (s.waiting?.length) {
      const mine = s.waiting.includes(role === "host" ? "host" : "viewer");
      showMessage(
        mine
          ? "Your video is buffering… playback resumes for both of you when it's ready."
          : "Your friend's video is buffering… playback resumes when they're ready.",
        "info",
      );
      waitingShown = true;
    } else if (waitingShown) {
      showMessage("");
      waitingShown = false;
    }
  }

  async function applyState() {
    const s = latest;
    if (!s) return;

    if (s.url !== currentUrl) {
      await loadSource(s.url);
      if (role === "host") $("room-url-input").value = s.url ?? "";
      waitingShown = false;
    }
    if (latest !== s) return; // a newer state arrived while we were loading
    if (!s.url) {
      showMessage("Waiting for the host to pick a video…", "info");
      return;
    }
    renderWaiting(s);
    if (!unlocked) return; // overlay is showing; we'll apply once they click
    await whenReady();
    if (latest !== s) return;

    const target = s.time + (s.playing ? (performance.now() - s.receivedAt) / 1000 : 0);
    const tolerance = s.reason === "sync" ? 1.0 : 0.3;
    if (Math.abs(video.currentTime - target) > tolerance) {
      programmaticSeek = target;
      video.currentTime = target;
    }

    appliedPlaying = s.playing;
    if (s.playing && video.paused) {
      try {
        await video.play();
      } catch (err) {
        if (err.name === "NotAllowedError") {
          unlocked = false;
          $("overlay").hidden = false;
        }
      }
    } else if (!s.playing && !video.paused) {
      video.pause();
    }
  }

  $("overlay-btn").addEventListener("click", () => {
    unlocked = true;
    $("overlay").hidden = true;
    applyState();
  });

  connect();
}

// ---------- router ----------

const roomMatch = location.pathname.match(/^\/room\/([a-z0-9]{4,16})\/?$/i);
if (roomMatch) startRoom(roomMatch[1].toLowerCase());
else startHome();
