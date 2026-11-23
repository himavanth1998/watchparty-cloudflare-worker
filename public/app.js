const $ = (id) => document.getElementById(id);
const video = $("video");

const HLS_MODULE = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.mjs";
// UMD build (sets window.dashjs); pinned because dash.js 5 changed the track APIs used below.
const DASH_SCRIPT = "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js";
const SYNC_INTERVAL_MS = 4000;

// ---------- shared player helpers ----------

let hls = null;
let dash = null;
let dashLoading = null;
let programmaticSeek = null; // position of a seek we caused ourselves, not the user
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
  if (dash) {
    dash.reset();
    dash = null;
  }
  closeTrackMenu();
  removeSubtitleFiles();
  video.removeAttribute("src");
  video.load();
  if (!url) return;

  $("player-wrap").hidden = false;
  showMessage("");

  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".mpd")) {
    // No browser plays MPEG-DASH natively; dash.js feeds the <video> element instead.
    let dashjs;
    try {
      dashjs = await loadDashJs();
    } catch (err) {
      return showMessage(err.message);
    }
    if (token !== loadToken) return;
    dash = dashjs.MediaPlayer().create();
    dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      showMessage(`Couldn't play this DASH stream (${e.error?.message ?? "unknown error"}). DASH needs the server to allow CORS.`);
    });
    dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, refreshTrackButtons);
    dash.on(dashjs.MediaPlayer.events.TEXT_TRACKS_ADDED, refreshTrackButtons);
    dash.initialize(video, url, false);
    return;
  }

  const isHls = pathname.endsWith(".m3u8");
  // Prefer hls.js even where HLS plays natively (Safari, recent Chrome): native playback
  // doesn't expose audio/subtitle track switching in most browsers.
  if (isHls) {
    const { default: Hls } = await import(HLS_MODULE);
    if (token !== loadToken) return;
    if (Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) showMessage(`Couldn't play this stream (${data.details}). HLS needs the server to allow CORS.`);
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshTrackButtons);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshTrackButtons);
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }
  }
  video.src = url;
}

function loadDashJs() {
  dashLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DASH_SCRIPT;
    script.onload = () => resolve(window.dashjs);
    script.onerror = () => {
      dashLoading = null;
      script.remove();
      reject(new Error("Couldn't load the DASH player. Check your connection and try again."));
    };
    document.head.append(script);
  });
  return dashLoading;
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
  if (!currentUrl || hls || dash) return;
  showMessage(
    "Couldn't play this URL. It may not be a direct media file, the format may be unsupported by this browser, or the server may block it.",
  );
});

// ---------- audio & subtitle tracks ----------
// Choices are per person: each browser picks its own audio language and subtitles.

const trackMenu = $("track-menu");
const subtitleFiles = []; // { el: <track>, url } loaded from the user's disk
let menuKind = null;

function trackLabel(parts, index) {
  return parts.filter(Boolean).join(" · ") || `Track ${index + 1}`;
}

function audioOptions() {
  if (hls) {
    return hls.audioTracks.map((t, i) => ({
      label: trackLabel([t.name, t.lang], i),
      active: hls.audioTrack === i,
      select: () => (hls.audioTrack = i),
    }));
  }
  if (dash) {
    const current = dash.getCurrentTrackFor("audio");
    return dash.getTracksFor("audio").map((t, i) => ({
      label: trackLabel([t.labels?.[0]?.text, t.lang], i),
      active: t === current || (current != null && t.id === current.id && t.index === current.index),
      select: () => dash.setCurrentTrack(t),
    }));
  }
  // Native: Safari lists the audio tracks of HLS streams and MP4/MKV files; most other browsers don't.
  const tracks = Array.from(video.audioTracks ?? []);
  return tracks.map((t, i) => ({
    label: trackLabel([t.label, t.language], i),
    active: t.enabled,
    select: () => tracks.forEach((o) => (o.enabled = o === t)),
  }));
}

function subtitleOptions() {
  const showFile = (track) => subtitleFiles.forEach(({ el }) => (el.track.mode = el.track === track ? "showing" : "disabled"));

  if (!hls && !dash) {
    // Native tracks (including loaded files) all live in video.textTracks.
    const tracks = Array.from(video.textTracks).filter((t) => t.kind === "subtitles" || t.kind === "captions");
    return {
      options: tracks.map((t, i) => ({
        track: t,
        label: trackLabel([t.label, t.language], i),
        active: t.mode === "showing",
        select: () => tracks.forEach((o) => (o.mode = o === t ? "showing" : "disabled")),
      })),
      off: () => tracks.forEach((t) => (t.mode = "disabled")),
    };
  }

  let options, libOff;
  if (hls) {
    libOff = () => (hls.subtitleTrack = -1);
    options = hls.subtitleTracks.map((t, i) => ({
      label: trackLabel([t.name, t.lang], i),
      active: hls.subtitleDisplay && hls.subtitleTrack === i,
      select: () => {
        showFile(null);
        hls.subtitleDisplay = true;
        hls.subtitleTrack = i;
      },
    }));
  } else {
    libOff = () => dash.setTextTrack(-1);
    options = dash.getTracksFor("text").map((t, i) => ({
      label: trackLabel([t.labels?.[0]?.text, t.lang], i),
      active: dash.isTextEnabled() && dash.getCurrentTextTrackIndex() === i,
      select: () => {
        showFile(null);
        dash.enableText(true);
        dash.setTextTrack(i);
      },
    }));
  }
  for (const { el } of subtitleFiles) {
    options.push({
      track: el.track,
      label: el.label,
      active: el.track.mode === "showing",
      select: () => {
        libOff();
        showFile(el.track);
      },
    });
  }
  return { options, off: () => (libOff(), showFile(null)) };
}

function refreshTrackButtons() {
  $("audio-btn").hidden = audioOptions().length < 2;
}

function openTrackMenu(kind) {
  if (menuKind === kind) return closeTrackMenu();
  menuKind = kind;
  trackMenu.replaceChildren();
  const add = (label, active, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = active ? "active" : "";
    button.textContent = label;
    button.addEventListener("click", () => {
      closeTrackMenu();
      try {
        onClick();
      } catch (err) {
        showMessage(`Couldn't switch tracks: ${err.message}`);
      }
    });
    trackMenu.append(button);
  };

  if (kind === "audio") {
    for (const o of audioOptions()) {
      add(o.label, o.active, () => {
        programmaticSeek = video.currentTime; // some players re-seek to flush the old audio
        o.select();
      });
    }
  } else {
    const { options, off } = subtitleOptions();
    add("Off", !options.some((o) => o.active), off);
    for (const o of options) add(o.label, o.active, o.select);
    add("Load subtitle file (.srt / .vtt)…", false, () => $("subtitle-file").click());
  }
  trackMenu.hidden = false;
  $("player-wrap").classList.add("menu-open");
}

function closeTrackMenu() {
  menuKind = null;
  trackMenu.hidden = true;
  $("player-wrap").classList.remove("menu-open");
}

function removeSubtitleFiles() {
  for (const { el, url } of subtitleFiles.splice(0)) {
    el.remove();
    URL.revokeObjectURL(url);
  }
}

$("subtitle-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let text = (await file.text()).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("WEBVTT")) {
    // SRT -> WebVTT: apart from the header, only the millisecond separator differs.
    text = "WEBVTT\n\n" + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
  const el = document.createElement("track");
  el.kind = "subtitles";
  el.label = file.name.replace(/\.(srt|vtt)$/i, "");
  el.src = url;
  video.append(el);
  subtitleFiles.push({ el, url });
  subtitleOptions().options.find((o) => o.track === el.track)?.select();
});

$("audio-btn").addEventListener("click", () => openTrackMenu("audio"));
$("subtitle-btn").addEventListener("click", () => openTrackMenu("subtitles"));
document.addEventListener("click", (e) => {
  if (menuKind && !e.target.closest("#track-controls")) closeTrackMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTrackMenu();
});
video.addEventListener("loadedmetadata", refreshTrackButtons);
video.audioTracks?.addEventListener?.("addtrack", refreshTrackButtons);

// Fullscreen the wrapper (not the bare <video>) so the track buttons stay visible.
$("fullscreen-btn").addEventListener("click", () => {
  const wrap = $("player-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
  else video.webkitEnterFullscreen?.(); // iOS Safari: native player has its own track menu
});

// Fade the buttons out while playing, like the native controls.
{
  const wrap = $("player-wrap");
  let idleTimer;
  const wake = () => {
    wrap.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused) wrap.classList.add("idle");
    }, 2500);
  };
  for (const type of ["mousemove", "touchstart"]) wrap.addEventListener(type, wake, { passive: true });
  video.addEventListener("play", wake);
  video.addEventListener("pause", wake);
}

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
