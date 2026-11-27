const $ = (id) => document.getElementById(id);
const video = $("video");

const HLS_MODULE = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.mjs";
// UMD build (sets window.dashjs); pinned because dash.js 5 changed the track APIs used below.
const DASH_SCRIPT = "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js";
const SYNC_INTERVAL_MS = 4000;
// Sync tuning. Small, automatic position changes (the player nudging itself past a stall, or a
// hold snapping everyone to the same frame) must not bounce between the two players.
const MIN_SHARED_SEEK = 1.5; // seeks closer than this to the room's position aren't shared
const STALL_REPORT_MS = 700; // only stalls longer than this make both people wait
const GAP_ESCAPE_MS = 2000; // stuck this long before a gap in the downloaded video: jump it
const MAX_GAP_JUMP = 3; // ...if the gap is at most this many seconds
const SKIP_SECONDS = 10;
const RESTART_AHEAD_S = 60; // Real-Debrid: jumps further than this past what's loaded restart the stream there // the ⟲/⟳ buttons and the ←/→ keys
const KEY_REPEAT_MS = 400; // while an arrow key is held down, skip at most this often
// Heartbeat: a connection can die without the browser noticing (Wi-Fi drop, sleep, a phone
// locking), which left one person playing on alone. Ping often and reconnect if the room goes quiet.
const PING_INTERVAL_MS = 5000;
const SILENCE_LIMIT_MS = 12000; // no message (or pong) for this long = dead connection
const CONNECT_TIMEOUT_MS = 10000;

// Servers that convert the video while you watch (e.g. Real-Debrid) answer with an error for
// parts they haven't prepared yet, like right after a long jump ahead. Keep asking for about
// two minutes instead of giving up (hls.js normally doesn't retry 4xx answers at all).
const SEGMENT_RETRIES = 60;
const SEGMENT_RETRY_MS = 2000;
const SEGMENT_LOAD_POLICY = {
  maxTimeToFirstByteMs: 30000,
  maxLoadTimeMs: 120000,
  timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
  errorRetry: {
    maxNumRetry: SEGMENT_RETRIES,
    retryDelayMs: SEGMENT_RETRY_MS,
    maxRetryDelayMs: SEGMENT_RETRY_MS,
    backoff: "linear",
    // Retry everything except a refused login: a missing segment may just not be ready yet.
    shouldRetry: (config, retryCount, _isTimeout, response) =>
      retryCount < config.maxNumRetry && response?.code !== 401 && response?.code !== 403,
  },
};

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

// Some manifests (e.g. Real-Debrid's) point at http:// segments, which an https page may not load.
const upgradeToHttps = (url) => (location.protocol === "https:" ? String(url).replace(/^http:\/\//i, "https://") : url);

function showMessage(text, kind = "error") {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}

async function loadSource(url) {
  const token = ++loadToken;
  currentUrl = url;
  mediaOffset = 0;
  restart = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (dash) {
    dash.reset();
    dash = null;
  }
  closeTrackMenu();
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
    dash.updateSettings({
      streaming: {
        retryAttempts: { MediaSegment: SEGMENT_RETRIES },
        retryIntervals: { MediaSegment: SEGMENT_RETRY_MS },
      },
    });
    dash.extend("RequestModifier", () => ({ modifyRequestHeader: (xhr) => xhr, modifyRequestURL: upgradeToHttps }), true);
    dash.initialize(video, url, false);
    return;
  }

  const isHls = pathname.endsWith(".m3u8");
  // Prefer hls.js even where HLS plays natively (Safari, recent Chrome): native playback
  // doesn't expose audio track switching in most browsers.
  if (isHls) {
    const { default: Hls } = await import(HLS_MODULE);
    if (token !== loadToken) return;
    if (Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (xhr, segmentUrl) => xhr.open("GET", upgradeToHttps(segmentUrl), true),
        fragLoadPolicy: { default: SEGMENT_LOAD_POLICY },
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR && !data.fatal) {
          showMessage("Waiting for the server to prepare this part of the video…", "info");
        } else if (data.fatal) {
          showMessage(`Couldn't play this stream (${data.details}). HLS needs the server to allow CORS.`);
        }
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        if ($("message").textContent.startsWith("Waiting for the server")) showMessage("");
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

// ---------- movie time & far jumps ----------
// Real-Debrid converts its streams on the fly, from the start. Jumping far ahead would wait for
// it to get there, so instead we ask for the manifest again with ?t=<seconds>: the conversion
// restarts at that point and the new stream begins at 0 again (same segment names). mediaOffset
// is where the current stream starts in the movie, so outside the player everything uses
// "movie time" = video.currentTime + mediaOffset.

let mediaOffset = 0;
let restart = null; // { target, resume } while reloading from a new starting point
let roomDrivesPlayback = false; // in a room, the room's hold/resume decides when to play again

const movieTime = () => (restart ? restart.target : (video.currentTime || 0) + mediaOffset);
const movieDuration = () => (Number.isFinite(video.duration) ? mediaOffset + video.duration : 0);
const isRestarting = () => restart !== null;

function canRestart() {
  if (!dash || !currentUrl) return false;
  const { hostname, pathname } = new URL(currentUrl);
  return /(^|\.)stream\.real-debrid\.com$/i.test(hostname) && pathname.endsWith(".mpd");
}

// End (in movie time) of the downloaded range around movie time t, or null if t isn't downloaded.
function loadedUntil(t) {
  const s = t - mediaOffset;
  for (let i = 0; i < video.buffered.length; i++) {
    if (s >= video.buffered.start(i) - 0.5 && s <= video.buffered.end(i) + 0.5) return video.buffered.end(i) + mediaOffset;
  }
  return null;
}

/**
 * Seek to a movie time. For a restartable stream, a jump before the current stream's start, or
 * well past what's downloaded, reloads the stream from there. `resume` says whether to play once
 * it's ready (default: if it was playing; never in a room, where the room resumes everyone
 * together). Resolves once the seek has started, or the reload has finished.
 */
function seekMovie(t, { resume } = {}) {
  const duration = movieDuration();
  t = Math.max(0, duration ? Math.min(t, duration - 0.5) : t);
  if (canRestart()) {
    const playhead = movieTime();
    const ahead = Math.max(loadedUntil(playhead) ?? playhead, playhead) + RESTART_AHEAD_S;
    if (restart || t < mediaOffset || (loadedUntil(t) === null && t > ahead)) return restartAt(t, resume);
  }
  video.currentTime = t - mediaOffset;
  return Promise.resolve();
}

async function restartAt(t, resume) {
  const start = Math.floor(t);
  const token = ++loadToken;
  resume ??= restart ? restart.resume : !video.paused;
  restart = { target: t, resume };
  video.dispatchEvent(new CustomEvent("wt-restart", { detail: { phase: "start", time: t } }));
  mediaOffset = start;
  const url = new URL(currentUrl);
  url.searchParams.set("t", String(start));
  const loaded = new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", done);
      resolve();
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", done);
  });
  dash.attachSource(url.href);
  await loaded;
  if (token !== loadToken) return; // superseded by another jump or a new video
  restart = null;
  video.currentTime = t - start; // an ordinary seek, so it's reported like one
  video.dispatchEvent(new CustomEvent("wt-restart", { detail: { phase: "end", time: t } }));
  if (resume && !roomDrivesPlayback) video.play().catch(() => {});
}

video.addEventListener("error", () => {
  if (!currentUrl || hls || dash) return;
  showMessage(
    "Couldn't play this URL. It may not be a direct media file, the format may be unsupported by this browser, or the server may block it.",
  );
});

// ---------- audio tracks & seek buttons ----------
// Choices are per person: each browser picks its own audio language.

const trackMenu = $("track-menu");
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

  for (const o of audioOptions()) {
    add(o.label, o.active, () => {
      programmaticSeek = movieTime(); // some players re-seek to flush the old audio
      o.select();
    });
  }
  trackMenu.hidden = false;
  $("player-wrap").classList.add("menu-open");
}

function closeTrackMenu() {
  menuKind = null;
  trackMenu.hidden = true;
  $("player-wrap").classList.remove("menu-open");
}

$("audio-btn").addEventListener("click", () => openTrackMenu("audio"));
document.addEventListener("click", (e) => {
  if (menuKind && !e.target.closest("#track-controls")) closeTrackMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTrackMenu();
});
video.addEventListener("loadedmetadata", refreshTrackButtons);
video.audioTracks?.addEventListener?.("addtrack", refreshTrackButtons);

// Jump back/ahead. In a room this is an ordinary seek, so it's shared like any other.
function skip(seconds) {
  if (currentUrl) seekMovie(movieTime() + seconds);
}
$("back-btn").addEventListener("click", () => skip(-SKIP_SECONDS));
$("forward-btn").addEventListener("click", () => skip(SKIP_SECONDS));
// Arrow keys too. Listening in the capture phase keeps the browser's own arrow handling (which
// jumps 1% of the duration) out of it.
let lastKeySkip = 0;
window.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if ($("player-wrap").hidden || e.target.closest?.("input, textarea, select")) return;
  e.preventDefault();
  e.stopPropagation();
  // Holding the key keeps skipping, but not at the keyboard's repeat rate.
  if (e.repeat && performance.now() - lastKeySkip < KEY_REPEAT_MS) return;
  lastKeySkip = performance.now();
  skip(e.key === "ArrowLeft" ? -SKIP_SECONDS : SKIP_SECONDS);
}, true);

// ---------- control bar ----------
// Our own controls instead of the browser's: they show movie time, which matters once a
// Real-Debrid stream has been restarted part-way (the <video> then starts at 0 mid-film).

const seekBar = $("seek-bar");
let scrubbing = false;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function renderControls() {
  const duration = movieDuration();
  const t = scrubbing ? Number(seekBar.value) : movieTime();
  const pct = (x) => (duration ? `${Math.min(100, (x / duration) * 100)}%` : "0%");
  seekBar.max = duration || 0;
  if (!scrubbing) seekBar.value = t;
  seekBar.style.setProperty("--played", pct(t));
  seekBar.style.setProperty("--loaded", pct(loadedUntil(movieTime()) ?? t));
  $("time-current").textContent = formatTime(t);
  $("time-total").textContent = duration ? formatTime(duration) : "--:--";
  $("player-wrap").classList.toggle("paused", video.paused);
  $("mute-btn").classList.toggle("muted", video.muted || video.volume === 0);
  $("volume-bar").value = video.muted ? 0 : video.volume;
}
for (const type of ["timeupdate", "durationchange", "progress", "play", "pause", "seeked", "loadedmetadata", "volumechange", "emptied", "wt-restart"]) {
  video.addEventListener(type, renderControls);
}

const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
$("play-btn").addEventListener("click", togglePlay);
video.addEventListener("click", togglePlay);
seekBar.addEventListener("input", () => {
  scrubbing = true;
  renderControls();
});
seekBar.addEventListener("change", () => {
  scrubbing = false;
  seekMovie(Number(seekBar.value));
  renderControls();
});
$("mute-btn").addEventListener("click", () => {
  if (video.muted || video.volume === 0) {
    video.muted = false;
    if (video.volume === 0) video.volume = 1;
  } else {
    video.muted = true;
  }
});
$("volume-bar").addEventListener("input", (e) => {
  video.volume = Number(e.target.value);
  video.muted = video.volume === 0;
});

// Fullscreen the whole player so our buttons stay usable.
function toggleFullscreen() {
  const wrap = $("player-wrap");
  if (document.fullscreenElement) document.exitFullscreen();
  else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
  else video.webkitEnterFullscreen?.(); // iPhone: only the bare video can go fullscreen
}
$("fullscreen-btn").addEventListener("click", toggleFullscreen);
video.addEventListener("dblclick", toggleFullscreen);

// Space toggles playback, like in most players.
window.addEventListener("keydown", (e) => {
  if (e.key !== " " || $("player-wrap").hidden || e.target.closest?.("input, textarea, select, button, a")) return;
  e.preventDefault();
  togglePlay();
});
renderControls();

// Fade the overlay buttons out while playing, like the native controls.
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

// ---------- Real-Debrid ----------

const RD_KEY_STORAGE = "wt-rd-key";
const RD_STREAMING_LINK = /^https:\/\/(?:www\.)?real-debrid\.com\/streaming-([a-z0-9]+)\/?(?:[?#].*)?$/i;
const RD_FORMAT_LABELS = { mpd: "DASH (.mpd)", m3u8: "HLS (.m3u8)", mp4: "MP4", webm: "WebM" };
const rdKeyRenderers = [];

const rdKey = () => localStorage.getItem(RD_KEY_STORAGE) ?? "";
const rdStreamingId = (raw) => String(raw).trim().match(RD_STREAMING_LINK)?.[1] ?? null;

function setRdKey(key) {
  if (key) localStorage.setItem(RD_KEY_STORAGE, key);
  else localStorage.removeItem(RD_KEY_STORAGE);
  for (const render of rdKeyRenderers) render();
}

function makeEl(tag, props = {}, children = []) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

const makeButton = (text, className, onClick) =>
  makeEl("button", { type: "button", className, textContent: text, onclick: onClick });

// A streaming link's id is the file's 13-character Real-Debrid id followed by a number
// (streaming-BTDT3JDZN7PZM40, streaming-OO3WOMAGWOID2128). The id itself can end in digits, so
// try the first 13 characters, then the other plausible cuts if Real-Debrid doesn't know it.
function rdApiIdCandidates(linkId) {
  return [...new Set([linkId.slice(0, 13), linkId.replace(/\d+$/, ""), linkId].filter(Boolean))];
}

async function fetchMediaInfos(linkId, key) {
  let lastError;
  for (const apiId of rdApiIdCandidates(linkId)) {
    try {
      return await fetchMediaInfosFor(apiId, key);
    } catch (err) {
      if (!err.unknownId) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

async function fetchMediaInfosFor(apiId, key) {
  let res;
  try {
    // Real-Debrid's API doesn't allow browser (CORS) requests, so our Worker relays the call.
    res = await fetch(`/api/rd/mediaInfos/${apiId}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Real-Debrid didn't answer, try again");
  }
  if (res.status === 404 && !res.headers.get("content-type")?.includes("json")) {
    throw new Error("this site's Worker is missing the Real-Debrid route (redeploy src/index.js)");
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) throw new Error("Real-Debrid rejected the API key");
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.unknownId = body?.error === "wrong_parameter" || body?.error === "unknown_ressource" || res.status === 404;
    throw err;
  }
  if (typeof body?.modelUrl !== "string") throw new Error("unexpected response from Real-Debrid");
  return body;
}

// Values the stream's baseUrl uses for each {placeholder} of modelUrl (its default selection).
function rdDefaults(info) {
  const model = info.modelUrl.split("/");
  const base = String(info.baseUrl ?? "").split("/");
  const defaults = {};
  model.forEach((segment, i) => {
    const name = segment.match(/^\{(\w+)\}/)?.[1];
    if (name && base[i]) defaults[name] = base[i].split(".")[0];
  });
  return defaults;
}

// Number repeated languages ("French 1", "French 2") so the options can be told apart.
function rdTrackOptions(tracks, describe) {
  const entries = Object.entries(tracks ?? {});
  const counts = {};
  for (const [, t] of entries) counts[t.lang] = (counts[t.lang] ?? 0) + 1;
  const seen = {};
  return entries.map(([value, t]) => {
    seen[t.lang] = (seen[t.lang] ?? 0) + 1;
    const lang = counts[t.lang] > 1 ? `${t.lang} ${seen[t.lang]}` : t.lang;
    return [value, [lang, describe(t)].filter(Boolean).join(" · ")];
  });
}

/**
 * Adds the Real-Debrid API key editor and the stream options panel to a URL form. A
 * real-debrid.com/streaming-… link in the input is looked up with the API, and the chosen
 * audio, subtitles, quality and format are turned into the stream URL in the input.
 * Returns a function for the submit handler: true if it took care of the submission.
 */
function setupRealDebrid(form, input) {
  const panel = makeEl("div", { className: "rd-options", hidden: true });
  const keyBox = makeEl("div", { className: "rd-key" });
  form.prepend(panel);
  form.append(keyBox);

  let editing = false;
  let lookup = 0;
  let builtUrl = null;
  let debounce = null;

  function renderKey() {
    const key = rdKey();
    if (editing) {
      const field = makeEl("input", {
        type: "text", value: key, placeholder: "Paste your Real-Debrid API key",
        autocomplete: "off", spellcheck: false,
      });
      const save = () => {
        editing = false;
        setRdKey(field.value.trim());
        if (rdStreamingId(input.value)) resolve();
      };
      const cancel = () => {
        editing = false;
        renderKey();
      };
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); save(); }
        if (e.key === "Escape") cancel();
      });
      keyBox.replaceChildren(
        makeEl("div", { className: "row" }, [
          field,
          makeButton("Save", "", save),
          ...(key ? [makeButton("Cancel", "secondary", cancel)] : []),
        ]),
        makeEl("p", { className: "hint" }, [
          "Get it from ",
          makeEl("a", { href: "https://real-debrid.com/apitoken", target: "_blank", rel: "noopener", textContent: "real-debrid.com/apitoken" }),
          ". It's stored only in this browser. Save an empty key to remove it.",
        ]),
      );
      field.focus();
    } else if (key) {
      keyBox.replaceChildren(
        makeEl("div", { className: "row hint" }, [
          `Real-Debrid API key: ••••${key.slice(-4)}`,
          makeButton("Edit", "secondary small", () => { editing = true; renderKey(); }),
        ]),
      );
    } else {
      keyBox.replaceChildren(
        makeEl("div", { className: "row hint" }, [
          "Have a real-debrid.com/streaming-… link?",
          makeButton("Add Real-Debrid API key", "secondary small", () => { editing = true; renderKey(); }),
        ]),
      );
    }
  }
  rdKeyRenderers.push(renderKey);
  renderKey();

  function renderOptions(info) {
    const defaults = rdDefaults(info);
    const audioCodec = defaults.audioCodec || "aac";
    const select = (label, options, preferred) => {
      const el = makeEl("select", {}, options.map(([value, text]) => makeEl("option", { value, textContent: text })));
      if (options.some(([value]) => value === preferred)) el.value = preferred;
      el.addEventListener("change", update);
      return [el, makeEl("label", {}, [makeEl("span", { textContent: label }), el])];
    };

    const [audio, audioLabel] = select("Audio", rdTrackOptions(info.details?.audio, (a) =>
      [a.codec, a.channels && `${a.channels} ch`].filter(Boolean).join(" ")), defaults.audio);
    const [subtitles, subtitlesLabel] = select("Subtitles", [["none", "Off"], ...rdTrackOptions(info.details?.subtitles, (s) => s.type)],
      defaults.subtitles ?? "none");
    const [quality, qualityLabel] = select("Quality",
      Object.entries(info.availableQualities ?? {}).map(([text, value]) => [value, text]), defaults.quality);
    // DASH by default: it's the format this was built for, and hls.js/dash.js handle the rest.
    const [format, formatLabel] = select("Format",
      Object.values(info.availableFormats ?? {}).map((ext) => [ext, RD_FORMAT_LABELS[ext] ?? ext]),
      Object.values(info.availableFormats ?? {}).includes("mpd") ? "mpd" : defaults.format);

    function update() {
      const values = { audio: audio.value, subtitles: subtitles.value, audioCodec, quality: quality.value, format: format.value };
      builtUrl = info.modelUrl.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(values[name] ?? ""));
      input.value = builtUrl;
    }

    panel.replaceChildren(
      makeEl("p", { className: "rd-title", textContent: info.filename ?? "Real-Debrid stream" }),
      makeEl("div", { className: "rd-grid" }, [audioLabel, subtitlesLabel, qualityLabel, formatLabel]),
      makeEl("p", { className: "hint", textContent: "Pick your options, then press the button to start the stream." }),
    );
    panel.hidden = false;
    update();
  }

  async function resolve() {
    const linkId = rdStreamingId(input.value);
    if (!linkId) return;
    clearTimeout(debounce);
    const token = ++lookup;
    const key = rdKey();
    if (!key) {
      editing = true;
      renderKey();
      return showMessage("Add your Real-Debrid API key to use Real-Debrid streaming links.");
    }
    showMessage("Looking up the Real-Debrid stream…", "info");
    try {
      const info = await fetchMediaInfos(linkId, key);
      if (token !== lookup) return;
      showMessage("");
      renderOptions(info);
    } catch (err) {
      if (token === lookup) showMessage(`Couldn't load the Real-Debrid stream: ${err.message}`);
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(debounce);
    if (rdStreamingId(input.value)) {
      debounce = setTimeout(resolve, 400);
    } else if (input.value !== builtUrl) {
      // The URL was replaced by something else: the options no longer apply.
      lookup++;
      builtUrl = null;
      panel.hidden = true;
    }
  });

  return () => {
    if (!rdStreamingId(input.value)) return false;
    resolve();
    return true;
  };
}

// ---------- home page ----------

function timeAgo(ms) {
  const minutes = Math.round(Math.abs(ms) / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// A readable name for the room's video: the file name from its URL.
function videoTitle(url) {
  if (!url) return "No video yet";
  try {
    const { pathname, hostname } = new URL(url);
    const file = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
    return file || hostname;
  } catch {
    return url;
  }
}

// Rooms this browser holds the host key for (saved when the room was created).
async function renderMyRooms() {
  const rooms = Object.keys(localStorage)
    .filter((k) => k.startsWith("wt-host:"))
    .map((k) => ({ roomId: k.slice("wt-host:".length), hostKey: localStorage.getItem(k) }));
  if (!rooms.length) {
    $("my-rooms").hidden = true;
    return;
  }

  const results = await Promise.all(
    rooms.map(async (room) => {
      try {
        const res = await fetch(`/api/rooms/${room.roomId}`, { headers: { "X-Host-Key": room.hostKey } });
        if (res.status === 404) {
          localStorage.removeItem(`wt-host:${room.roomId}`); // expired or deleted
          return null;
        }
        return res.ok ? { ...room, info: await res.json() } : { ...room, info: null };
      } catch {
        return { ...room, info: null };
      }
    }),
  );
  const live = results.filter(Boolean).sort((a, b) => (b.info?.lastActiveAt ?? 0) - (a.info?.lastActiveAt ?? 0));
  $("my-rooms").hidden = !live.length;
  $("room-list").replaceChildren(
    ...live.map(({ roomId, hostKey, info }) => {
      const details = [];
      if (info) {
        const now = Date.now();
        if (info.online.host || info.online.viewer) {
          details.push(`🟢 ${[info.online.host && "you", info.online.viewer && (info.guestName ?? "your guest")].filter(Boolean).join(" and ")} connected`);
        } else if (info.lastActiveAt) {
          details.push(`Last used ${timeAgo(now - info.lastActiveAt)} ago`);
        }
        if (info.guestName) details.push(`Guest: ${info.guestName}`);
        if (info.messages) details.push(`${info.messages} message${info.messages === 1 ? "" : "s"}`);
        if (info.expiresAt && !info.online.host && !info.online.viewer) details.push(`deleted in ${timeAgo(info.expiresAt - now)}`);
      } else {
        details.push("Couldn't load details");
      }
      const remove = makeButton("Delete", "secondary small", async () => {
        if (!confirm(`Delete room ${roomId}? This also deletes its chat, and the invite link stops working.`)) return;
        const res = await fetch(`/api/rooms/${roomId}`, { method: "DELETE", headers: { "X-Host-Key": hostKey } }).catch(() => null);
        if (!res || (!res.ok && res.status !== 404)) return showMessage("Couldn't delete the room, try again.");
        localStorage.removeItem(`wt-host:${roomId}`);
        renderMyRooms();
      });
      return makeEl("li", {}, [
        makeEl("div", { className: "room-info" }, [
          makeEl("span", { className: "room-title", textContent: videoTitle(info?.url) }),
          makeEl("span", { className: "hint", textContent: `Room ${roomId}${details.length ? " · " + details.join(" · ") : ""}` }),
        ]),
        makeEl("a", { href: `/room/${roomId}`, className: "button", textContent: "Open" }),
        remove,
      ]);
    }),
  );
}

function startHome() {
  $("home").hidden = false;
  renderMyRooms();

  const realDebrid = setupRealDebrid($("url-form"), $("url-input"));

  $("url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (realDebrid()) return;
    const url = parseHttpsUrl($("url-input").value);
    if (!url) return showMessage("Please enter a valid https:// URL.");
    await loadSource(url);
    video.play().catch(() => {});
  });

  $("create-room").addEventListener("click", async () => {
    if (realDebrid()) return; // choose the stream options first
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
  let reconnectTimer = null;
  let connectStartedAt = 0;
  let lastHeard = 0; // when the room last sent us anything
  let stopped = false;
  let unlocked = false; // the browser allows playback with sound (the user has clicked)
  let latest = null; // latest room state received, with receivedAt
  let version = 0; // newest room state version we know about
  let appliedPlaying = false; // what the room last told our player to do
  let myBuffering = false; // we told the room our player is stalled
  let bufferingSince = 0;
  let stallTimer = null;
  let shareNextSeek = false; // the next seek is ours but the room must hear about it
  let waitingShown = false;
  let myName = "";

  $("room").hidden = false;
  $("room-code").textContent = roomId;
  roomDrivesPlayback = true;

  function connect() {
    clearTimeout(reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const query = `?cid=${clientId}&name=${encodeURIComponent(myName)}${hostKey ? `&key=${encodeURIComponent(hostKey)}` : ""}`;
    const socket = new WebSocket(`${proto}://${location.host}/api/rooms/${roomId}/ws${query}`);
    ws = socket;
    connectStartedAt = lastHeard = performance.now();

    // Events from a socket we've already given up on are ignored.
    socket.addEventListener("open", () => {
      if (socket !== ws) return;
      retryDelay = 1000;
      lastHeard = performance.now();
      myBuffering = false; // a fresh connection starts with a clean buffering flag
    });
    socket.addEventListener("message", (e) => {
      if (socket !== ws) return;
      lastHeard = performance.now();
      if (e.data !== "pong") handleMessage(JSON.parse(e.data));
    });
    socket.addEventListener("close", (e) => {
      if (socket !== ws || stopped || [4000, 4001, 4004].includes(e.code)) return;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    $("presence").textContent = "Reconnecting…";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }

  // Abandon the current connection without waiting for the browser's close event, which can
  // take a minute or more on a dead network.
  function reconnectNow() {
    const old = ws;
    ws = null;
    try { old?.close(); } catch {}
    retryDelay = 1000;
    connect();
  }

  function checkConnection() {
    if (stopped || !ws) return;
    const now = performance.now();
    if (ws.readyState === WebSocket.CONNECTING) {
      if (now - connectStartedAt > CONNECT_TIMEOUT_MS) reconnectNow();
    } else if (ws.readyState === WebSocket.OPEN) {
      if (now - lastHeard > SILENCE_LIMIT_MS) reconnectNow();
      else ws.send("ping"); // answered by the server with "pong"
    }
  }
  setInterval(checkConnection, PING_INTERVAL_MS);

  // Coming back to the tab or the network: check right away instead of at the next ping.
  function probe() {
    if (stopped || !ws) return;
    if (ws.readyState !== WebSocket.OPEN) return reconnectNow();
    const sentAt = performance.now();
    ws.send("ping");
    setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN && lastHeard < sentAt) reconnectNow();
    }, 3000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") probe();
  });
  window.addEventListener("online", probe);

  function handleMessage(msg) {
    switch (msg.type) {
      case "welcome":
        setRole(msg.role);
        version = msg.state.version;
        $("chat-log").replaceChildren();
        for (const m of msg.chat ?? []) addChatMessage(m);
        resume(msg.state);
        break;
      case "chat":
        addChatMessage(msg.message);
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

  function renderPresence({ host, viewer, hostName, viewerName }) {
    $("presence").textContent =
      role === "host"
        ? viewer ? `🟢 ${viewerName ?? "Your friend"} is here` : "⚪ Waiting for your friend to join…"
        : host ? `🟢 ${hostName ?? "Host"} (host) is online` : "⚪ Host is offline";
  }

  // ----- chat -----

  function addChatMessage({ from, name, text, at }) {
    const log = $("chat-log");
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    log.append(
      makeEl("li", { className: from === role ? "mine" : "" }, [
        makeEl("span", { className: "meta", textContent: `${from === role ? "You" : name} · ${time}` }),
        text,
      ]),
    );
    if (nearBottom || from === role) log.scrollTop = log.scrollHeight;
  }

  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("chat-input").value.trim();
    if (!text) return;
    if (ws?.readyState !== WebSocket.OPEN) return showMessage("Not connected, the message wasn't sent.");
    ws.send(JSON.stringify({ type: "chat", text }));
    $("chat-input").value = "";
  });

  // ----- sending -----

  function sendUpdate(reason) {
    if (!role || ws?.readyState !== WebSocket.OPEN) return;
    const msg = {
      type: "update",
      reason,
      playing: !video.paused && !video.ended,
      time: movieTime(),
      base: version, // lets the room discard heartbeats that raced with a newer action
    };
    if (reason === "load") msg.url = currentUrl;
    ws.send(JSON.stringify(msg));
    if (reason !== "sync" && latest) {
      // Our own action is now the room's position (the server only acks it).
      latest = { ...latest, time: msg.time, playing: msg.playing, reason, receivedAt: performance.now() };
    }
  }

  // Where the room's playback should be right now, according to the latest state.
  function roomTime() {
    if (!latest) return NaN;
    return latest.time + (latest.playing ? (performance.now() - latest.receivedAt) / 1000 : 0);
  }

  // Tell the room when our player stalls or recovers so both sides can wait for each other.
  function setBuffering(buffering, time = movieTime()) {
    if (myBuffering === buffering || ws?.readyState !== WebSocket.OPEN) return;
    myBuffering = buffering;
    bufferingSince = performance.now();
    ws.send(JSON.stringify({ type: "buffering", buffering, time }));
  }

  function checkReady() {
    if (!myBuffering || isRestarting()) return;
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return setBuffering(false);
    // Stuck right before a gap in what's been downloaded (streams converted on the fly can have
    // them after a jump). hls.js only jumps gaps while playing, and during a hold we're paused,
    // so both people would wait forever. Jump it ourselves and tell the room.
    if (video.seeking || performance.now() - bufferingSince < GAP_ESCAPE_MS) return;
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      if (start > t && start - t <= MAX_GAP_JUMP) {
        shareNextSeek = true;
        video.currentTime = start + 0.05;
        return;
      }
    }
  }

  // Events caused by applyState() match what the room already knows, so only genuine
  // user actions (which differ from the room's state) get sent.
  video.addEventListener("play", () => {
    if (appliedPlaying || isRestarting()) return;
    appliedPlaying = true;
    sendUpdate("play");
  });
  video.addEventListener("pause", () => {
    if (!appliedPlaying || isRestarting()) return;
    appliedPlaying = false;
    sendUpdate("pause");
  });
  video.addEventListener("seeked", () => {
    if (isRestarting()) return;
    const ours = programmaticSeek !== null && Math.abs(movieTime() - programmaticSeek) < 0.5;
    programmaticSeek = null;
    if (ours) return;
    if (shareNextSeek) {
      shareNextSeek = false;
      return sendUpdate("seek");
    }
    // Not a person seeking: the player correcting itself by a fraction of a second. Sharing
    // those made both players keep re-seeking each other to the same spot.
    if (Math.abs(movieTime() - roomTime()) < MIN_SHARED_SEEK) return;
    sendUpdate("seek");
  });
  // A far jump reloads the stream: the room waits for us like for any buffering.
  video.addEventListener("wt-restart", (e) => {
    if (e.detail.phase === "start") setBuffering(true, e.detail.time);
  });
  video.addEventListener("waiting", () => {
    if (video.paused || !appliedPlaying || isRestarting()) return;
    clearTimeout(stallTimer);
    // Brief stalls sort themselves out; only make both people wait for a real one.
    stallTimer = setTimeout(() => {
      if (!video.paused && appliedPlaying && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setBuffering(true);
    }, STALL_REPORT_MS);
  });
  video.addEventListener("canplay", checkReady);
  video.addEventListener("playing", checkReady);
  setInterval(checkReady, 1000);

  setInterval(() => {
    // Drift correction: the host's position is the reference while playing normally.
    if (role === "host" && !video.paused && appliedPlaying && !myBuffering && !isRestarting()) sendUpdate("sync");
  }, SYNC_INTERVAL_MS);

  const realDebrid = setupRealDebrid($("room-url-form"), $("room-url-input"));

  $("room-url-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (realDebrid()) return;
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
    // Someone's deliberate action is matched closely; drift corrections and holds/resumes only
    // fix real differences, so they can't pull a player back to a spot it just got past.
    const tolerance = ["sync", "hold", "resume"].includes(s.reason) ? 1.0 : 0.5;
    if (Math.abs(movieTime() - target) > tolerance) {
      programmaticSeek = target;
      await seekMovie(target, { resume: false }); // playing is decided below
      if (latest !== s) return;
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

  // Everyone enters a name before joining. The click also lets the browser start playback with sound.
  $("name-input").value = localStorage.getItem("wt-name") ?? "";
  $("name-form").hidden = false;
  $("name-input").focus();
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    myName = $("name-input").value.replace(/\s+/g, " ").trim();
    if (!myName) return showMessage("Please enter your name.");
    localStorage.setItem("wt-name", myName);
    showMessage("");
    unlocked = true;
    $("name-form").hidden = true;
    $("room-bar").hidden = false;
    $("chat").hidden = false;
    connect();
  });
}

// ---------- router ----------

const roomMatch = location.pathname.match(/^\/room\/([a-z0-9]{4,16})\/?$/i);
if (roomMatch) startRoom(roomMatch[1].toLowerCase());
else startHome();
