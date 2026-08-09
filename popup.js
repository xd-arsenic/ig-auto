"use strict";

const $ = (id) => document.getElementById(id);

let view = "home"; // "home" | "activity"
let currentContext = null;
let lastJob = null;

const RUNNING_STATES = new Set(["running", "waiting", "paused"]);

// ---- Messaging -----------------------------------------------------------
// A single stalled round-trip (e.g. messaging the content script while the
// running job is mid-navigation) must never freeze the popup's render loop, so
// every call is raced against a timeout and resolves to null on miss.
async function sendToBackground(action, payload = {}, timeoutMs = 4000) {
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({ action, ...payload }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch (e) {
    return null;
  }
}

// ---- Settings ------------------------------------------------------------
// storage.js (loaded first) owns the canonical DEFAULT_SETTINGS and the
// write-locked read-modify-write mutators; the popup goes through them so the
// defaults never drift and rapid toggles can't clobber each other.
const Store = self.IGStore;

async function getSettings() {
  return Store.getSettings();
}

async function patchSettings(partial) {
  return Store.setSettings(partial);
}

// ---- Toggle helpers (styled div switches) --------------------------------
const TOGGLE_IDS = [
  "browsePosts", "likeComments", "likeOnFollow", "flockPriority",
  "activeHoursEnabled", "fatigueEnabled", "skipVerified", "skipPrivate",
  "vetAllProfiles", "reconcileEnabled", "cleanupEnabled",
];
const SCHEDULE_TOGGLES = new Set(["reconcileEnabled", "cleanupEnabled"]);

function setTgl(id, on) {
  const el = $(id);
  if (el) el.classList.toggle("on", !!on);
}
function tglOn(id) {
  const el = $(id);
  return !!el && el.classList.contains("on");
}

// Number / text inputs → setting key
const FIELD_MAP = {
  minDelay: "minDelayMs",
  maxDelay: "maxDelayMs",
  sessionCap: "sessionCap",
  activeStartHour: "activeStartHour",
  activeEndHour: "activeEndHour",
  dailyBudget: "dailyBudget",
  minFollowers: "minFollowers",
  maxFollowers: "maxFollowers",
  reconcileInterval: "reconcileIntervalMin",
  flockKeyword: "flockKeyword",
  blacklist: "blacklist",
  protectList: "protectList",
};

// Reflect stored settings into the controls.
async function loadSettings() {
  const s = await getSettings();

  $("humanLevel").value = s.humanLevel ?? 50;
  setDry(!!s.dryRun);

  $("minDelay").value = s.minDelayMs;
  $("maxDelay").value = s.maxDelayMs;
  $("sessionCap").value = s.sessionCap;
  $("randomization").value = s.randomization ?? 40;
  $("randPct").textContent = `${s.randomization ?? 40}%`;

  $("flockKeyword").value = s.flockKeyword || "flock";
  $("activeStartHour").value = s.activeStartHour ?? 8;
  $("activeEndHour").value = s.activeEndHour ?? 23;
  $("dailyBudget").value = s.dailyBudget ?? 0;
  $("blacklist").value = s.blacklist || "";
  $("protectList").value = s.protectList || "";
  $("minFollowers").value = s.minFollowers ?? 0;
  $("maxFollowers").value = s.maxFollowers ?? 0;
  $("reconcileInterval").value = s.reconcileIntervalMin;

  setTgl("browsePosts", s.browsePosts);
  setTgl("likeComments", s.likeComments);
  setTgl("likeOnFollow", s.likeOnFollow);
  setTgl("flockPriority", s.flockPriority);
  setTgl("activeHoursEnabled", s.activeHoursEnabled);
  setTgl("fatigueEnabled", s.fatigueEnabled);
  setTgl("skipVerified", s.skipVerified);
  setTgl("skipPrivate", s.skipPrivate);
  setTgl("vetAllProfiles", s.vetAllProfiles);
  setTgl("reconcileEnabled", s.reconcileEnabled !== false);
  setTgl("cleanupEnabled", s.cleanupEnabled !== false);

  renderPace(s.humanLevel ?? 50);
  return s;
}

// ---- Dry-run pseudo-checkbox --------------------------------------------
function setDry(on) {
  $("dryToggle").classList.toggle("on", on);
  $("dryMark").textContent = on ? "✓" : "";
  $("startBtn").textContent = on ? "Start dry run" : "Start following";
}

// ---- Human-likeness preset engine ---------------------------------------
function presetFromLevel(level) {
  const H = Math.max(0, Math.min(100, Number(level) || 0));
  return {
    randomization: H,
    minDelayMs: Math.round(2000 + H * 80), // ~2s → ~10s
    maxDelayMs: Math.round(5000 + H * 180), // ~5s → ~23s
    sessionCap: Math.round(60 + H * 0.6), // 60 → 120
    browsePosts: H >= 35,
    likeComments: H >= 55,
    likeOnFollow: H >= 60,
    fatigueEnabled: H >= 45,
    activeHoursEnabled: H >= 70,
  };
}

// Effective throttle for a given human-likeness level. Mirrors the engine's
// two real constraints so the label is honest: (1) a randomized gap between
// follows (min/maxDelay), and (2) a rolling hourly cap that tightens with the
// level (~15–20/hr at max). The sustained rate is whichever is stricter.
function paceMetrics(level) {
  const H = Math.max(0, Math.min(100, Number(level) || 0));
  const R = H / 100;
  const minMs = Math.round(2000 + H * 80); // matches presetFromLevel
  const maxMs = Math.round(5000 + H * 180);
  const avgSec = (minMs + maxMs) / 2000;
  const delayPerHr = 3600 / avgSec;
  // Same shape as JobRunner.hourlyCap with the 15–20 midpoint (~17).
  const hourlyMax = 17;
  const cap = R >= 1 ? hourlyMax : Math.max(hourlyMax, Math.round(hourlyMax / (0.35 + 0.65 * R)));
  const perHr = Math.round(Math.min(delayPerHr, cap));
  const cappedByHour = cap < delayPerHr;
  return { minMs, maxMs, perHr, cappedByHour };
}

// Colour + label for a given human-likeness level, matching the prototype's
// orange → rose → magenta interpolation.
function paceStyle(level) {
  const H = Math.max(0, Math.min(100, Number(level) || 0));
  const label = H > 66 ? "Stealth" : H > 33 ? "Balanced" : "Fast";
  const stops = [[245, 132, 43], [232, 56, 93], [194, 42, 134]];
  const p = (H / 100) * (stops.length - 1);
  const i0 = Math.min(Math.floor(p), stops.length - 2);
  const f = p - i0;
  const rgb = stops[i0].map((c, j) => Math.round(c + (stops[i0 + 1][j] - c) * f));
  const color = `rgb(${rgb.join(",")})`;
  const bg = `rgba(${rgb.join(",")},.12)`;

  const m = paceMetrics(H);
  const gap = `${Math.round(m.minMs / 1000)}–${Math.round(m.maxMs / 1000)}s between follows`;
  const rate = m.cappedByHour ? `~${m.perHr}/hr (hourly cap)` : `~${m.perHr}/hr`;
  const desc =
    label === "Stealth"
      ? `${rate} · ${gap} · browses & likes · waking hours`
      : label === "Balanced"
      ? `${rate} · ${gap} · some browsing · short breaks`
      : `${rate} · ${gap} · minimal dwell · highest detection risk`;
  return { label, color, bg, desc };
}

function renderPace(level) {
  const ps = paceStyle(level);
  const pill = $("pacePill");
  pill.textContent = ps.label;
  pill.style.background = ps.bg;
  pill.style.color = ps.color;
  $("paceDesc").textContent = ps.desc;
  $("humanLevel").style.accentColor = ps.color;
}

async function applyPreset() {
  const H = parseInt($("humanLevel").value, 10) || 0;
  const preset = presetFromLevel(H);
  await patchSettings(Object.assign({ humanLevel: H }, preset));
  await loadSettings();
}

// ---- Target parsing / classification ------------------------------------
const RESERVED_USERNAMES = new Set([
  "p", "reel", "reels", "tv", "explore", "stories", "direct", "accounts",
]);

function splitTokens(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseUsername(token) {
  let s = String(token || "").trim();
  if (!s) return "";
  if (s.startsWith("@")) s = s.slice(1);
  if (/instagram\.com/i.test(s) || /^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s.startsWith("http") ? s : `https://${s}`);
      const m = decodeURIComponent(u.pathname).match(/^\/([A-Za-z0-9._]+)\/?/);
      return m ? m[1].toLowerCase() : "";
    } catch (_) {
      return "";
    }
  }
  const m = s.match(/^([A-Za-z0-9._]+)\/?$/);
  return m ? m[1].toLowerCase() : "";
}

function classifyToken(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  const post = s.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (post) return { kind: "likers", value: post[1] };
  const u = parseUsername(s);
  if (u && !RESERVED_USERNAMES.has(u)) return { kind: "followers", value: u };
  return null;
}

function classifyTargets(text) {
  const items = [];
  const seen = new Set();
  for (const tok of splitTokens(text)) {
    const it = classifyToken(tok);
    if (!it) continue;
    const key = `${it.kind}:${it.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }
  return { items };
}

function canonicalToken(it) {
  return it.kind === "likers" ? `https://instagram.com/p/${it.value}/` : `@${it.value}`;
}

function renderRunChips() {
  const box = $("runChips");
  const { items } = classifyTargets($("runInput").value);
  $("startBtn").style.opacity = items.length ? "1" : ".55";
  box.innerHTML = "";

  if (!items.length && !currentContext) {
    const span = document.createElement("span");
    span.className = "chips-empty";
    span.textContent = "Handles, profile links or post links — mix them freely.";
    box.appendChild(span);
    return;
  }

  items.forEach((it, i) => {
    const chip = document.createElement("span");
    chip.className = "chip " + (it.kind === "likers" ? "post" : "acct");
    const label =
      it.kind === "likers" ? `▣ likers of ${it.value}` : `@ ${it.value}`;
    chip.textContent = `${label} ✕`;
    chip.title = "Remove";
    chip.addEventListener("click", () => {
      const rest = items.filter((_, j) => j !== i);
      $("runInput").value = rest.map(canonicalToken).join("\n");
      renderRunChips();
    });
    box.appendChild(chip);
  });

  // "+ current page" suggestion when we're on a profile/post and it's not
  // already in the queue.
  if (currentContext) {
    const c = classifyToken(currentContext.add);
    const already =
      c && items.some((it) => it.kind === c.kind && it.value === c.value);
    if (!already) {
      const add = document.createElement("span");
      add.className = "chip add";
      add.textContent = "+ current page";
      add.title = currentContext.title;
      add.addEventListener("click", addContextToInput);
      box.appendChild(add);
    }
  }
}

// ---- Smart current-tab context ------------------------------------------
async function detectContext() {
  currentContext = null;
  let active;
  try {
    [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    /* ignore */
  }
  if (!active?.url || !active.url.includes("instagram.com")) return;

  try {
    const u = new URL(active.url);
    const path = decodeURIComponent(u.pathname);
    const post = path.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (post) {
      currentContext = {
        kind: "likers",
        add: active.url,
        title: `Follow likers of this post (${post[1]})`,
      };
    } else {
      const prof = path.match(/^\/([A-Za-z0-9._]+)\/?$/);
      if (prof && !RESERVED_USERNAMES.has(prof[1].toLowerCase())) {
        currentContext = {
          kind: "followers",
          add: prof[1],
          title: `Follow @${prof[1]}'s followers`,
        };
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function addContextToInput() {
  if (!currentContext) return;
  const box = $("runInput");
  const existing = box.value;
  const c = classifyToken(currentContext.add);
  const already =
    c && classifyTargets(existing).items.some((it) => it.kind === c.kind && it.value === c.value);
  if (!already) {
    box.value = existing.trim()
      ? `${existing.trim()}\n${currentContext.add}`
      : currentContext.add;
  }
  renderRunChips();
  box.focus();
}

// ---- Formatting helpers --------------------------------------------------
function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const v = Number(n);
  if (v >= 1000) {
    const k = v / 1000;
    return (k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(v);
}

function timeAgo(t) {
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clock(ts) {
  const secs = Math.max(0, Math.round((ts - Date.now()) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function dayKeyLocal(ts) {
  const d = new Date(ts ?? Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---- Log rendering -------------------------------------------------------
function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

function logSymbol(e) {
  const m = e.message || "";
  if (e.level === "error") return { s: "✕", c: "#c22a5c" };
  if (e.level === "warn") return { s: "!", c: "#c07622" };
  if (/unfollow/i.test(m)) return { s: "－", c: "#c07622" };
  if (/follow(ed|ing)? @|\bfollow(ed|ing)?\b|would follow/i.test(m)) return { s: "＋", c: "#1a9e50" };
  if (/like/i.test(m)) return { s: "♥", c: "#c22a5c" };
  if (/navigat|back to|going to|returning|to your followers/i.test(m)) return { s: "→", c: "#9b98a3" };
  if (/view|brows|dwell|scroll|visit|open|wait/i.test(m)) return { s: "…", c: "#9b98a3" };
  return { s: "·", c: "#9b98a3" };
}

function logLine(entry) {
  const { s, c } = logSymbol(entry);
  const div = document.createElement("div");
  div.className = "ln";
  const tm = document.createElement("span");
  tm.className = "tm";
  tm.textContent = fmtTime(entry.t);
  const sym = document.createElement("span");
  sym.className = "sym";
  sym.style.color = c;
  sym.textContent = s;
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = entry.message || "";
  div.appendChild(tm);
  div.appendChild(sym);
  div.appendChild(msg);
  return div;
}

function fillLog(boxId, entries, emptyText) {
  const box = $(boxId);
  box.innerHTML = "";
  if (!entries.length) {
    const div = document.createElement("div");
    div.className = "ln empty";
    div.textContent = emptyText;
    box.appendChild(div);
    return;
  }
  entries.forEach((e) => box.appendChild(logLine(e)));
}

async function renderLogs() {
  const { logs } = await chrome.storage.local.get("logs");
  const recent = (logs || []).slice().reverse(); // newest first
  fillLog("liveLog", recent.slice(0, 6), "Waiting for activity…");
  fillLog("recentLog", recent.slice(0, 3), "No activity yet — start a run.");
  fillLog("fullLog", recent.slice(0, 40), "No activity yet — start a run.");
}

// ---- Stats + analytics ---------------------------------------------------
async function getAccount() {
  const { accounts, activeAccountId } = await chrome.storage.local.get([
    "accounts",
    "activeAccountId",
  ]);
  return { acct: accounts?.[activeAccountId] || null, activeAccountId, accounts };
}

function computeStats(acct) {
  const tracked = (acct && acct.tracked) || {};
  const daily = (acct && acct.daily) || {};
  const vals = Object.values(tracked);
  return {
    following: vals.filter((v) => v.status === "following").length,
    unfollowed: vals.filter((v) => v.status === "unfollowed").length,
    followedBack: vals.filter((v) => v.reason === "followed-back").length,
    noFollowBack: vals.filter((v) => v.reason === "no-follow-back").length,
    dayCount: daily[dayKeyLocal()] || 0,
    daily,
    profile: (acct && acct.profile) || null,
  };
}

async function renderStatsUI() {
  const { acct } = await getAccount();
  const st = computeStats(acct);

  // Header stat line (home).
  $("hFollowers").textContent = st.profile ? fmtNum(st.profile.followers) : "—";
  $("hBot").textContent = fmtNum(st.following);
  $("hUnfollowed").textContent = fmtNum(st.unfollowed);
  $("hAgo").textContent = st.profile?.updatedAt ? timeAgo(st.profile.updatedAt) : "";

  // Idle summary.
  $("miniBack").textContent = st.followedBack;
  $("miniDidnt").textContent = st.following;
  $("miniToday").textContent = st.dayCount;

  // Activity view.
  $("actToday").textContent = st.dayCount;
  $("actBack").textContent = st.followedBack;
  $("actUnfollowed").textContent = st.unfollowed;

  renderChart(st.daily);
  return st;
}

function renderChart(daily) {
  const days = 14;
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKeyLocal(Date.now() - i * 24 * 60 * 60 * 1000);
    series.push({ date: k, count: daily[k] || 0 });
  }
  const max = Math.max(1, ...series.map((d) => d.count));
  const chart = $("chart");
  const xrow = $("chartX");
  chart.innerHTML = "";
  xrow.innerHTML = "";
  series.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "bar2";
    col.title = `${d.date}: ${d.count}`;
    const f = document.createElement("div");
    f.className = "f" + (i === days - 1 ? " today" : "");
    f.style.height = `${Math.max(4, Math.round((d.count / max) * 100))}%`;
    col.appendChild(f);
    chart.appendChild(col);

    const lbl = document.createElement("div");
    lbl.textContent = d.date.slice(8); // DD
    xrow.appendChild(lbl);
  });
}

// ---- Job / running rendering --------------------------------------------
function progressKeyFor(type) {
  if (type === "reconcile" || type === "unfollowNonFollowers") return "unfollowed";
  return "followed";
}

async function renderRunningCard(job, st) {
  const p = (job && job.progress) || {};
  const status = (job && job.status) || "idle";
  const settings = await getSettings();
  const paused = status === "paused";
  const waiting = status === "waiting";

  const dotColor = paused || waiting ? "#e8a13c" : "#22c463";
  const textColor = paused || waiting ? "#c07622" : "#1a9e50";
  $("statusDot").style.background = dotColor;
  $("statusText").style.color = textColor;

  const label = paceStyle(settings.humanLevel).label.toUpperCase();
  const base = paused ? "PAUSED" : waiting ? "WAITING" : "RUNNING";
  $("statusText").textContent = base + " · " + label + (settings.dryRun ? " · DRY" : "");

  const key = progressKeyFor(job && job.type);
  const count = Number(p[key] || p.preview || 0);
  $("runCount").textContent = count;

  const cap = Math.max(1, Number(settings.sessionCap) || 1);
  const budget = Number(settings.dailyBudget) || 0;
  $("runCountSub").textContent =
    `/ ${cap} this run · ${st.dayCount}/${budget > 0 ? budget : "∞"} today`;

  $("barFill").style.width = Math.min(100, Math.round((count / cap) * 100)) + "%";

  updateNextIn(job);
  renderQueue(job);

  // Pause button reflects state.
  $("pauseBtn").textContent = paused ? "▶ Resume" : "❚❚ Pause";
}

function updateNextIn(job) {
  const p = (job && job.progress) || {};
  const status = (job && job.status) || "idle";
  const el = $("nextIn");
  if (status === "waiting" && p.waitUntil) {
    el.textContent =
      (p.backoffLevel ? `blocked · retry in ` : `retry in `) + clock(p.waitUntil);
  } else if (status === "paused") {
    el.textContent = "paused";
  } else {
    el.textContent = "";
  }
}

// Normalize a job's targets into { kind, value } items for the queue view.
// The unified "follow" job carries param.items; the legacy followFollowers /
// followLikers jobs carry a bare param.targets array, so map those by type.
function queueItems(job) {
  const p = (job && job.param) || {};
  if (Array.isArray(p.items)) return p.items;
  if (Array.isArray(p.targets)) {
    const kind = job && job.type === "followLikers" ? "likers" : "followers";
    return p.targets.map((value) => ({ kind, value }));
  }
  return [];
}

function renderQueue(job) {
  const box = $("queueList");
  box.innerHTML = "";
  const items = queueItems(job);
  const p = (job && job.progress) || {};

  if (!items.length) {
    const row = document.createElement("div");
    row.className = "queue-item";
    row.innerHTML = `<span class="ic">▣</span> ${prettyType(job && job.type)}`;
    box.appendChild(row);
    return;
  }

  const idx = Math.max(0, (Number(p.queueIndex) || 1) - 1);
  const remaining = items.length - idx;
  items.slice(idx).forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    const isPost = it.kind === "likers";
    const ic = document.createElement("span");
    ic.className = "ic" + (isPost ? "" : " acct");
    ic.textContent = isPost ? "▣" : "@";
    row.appendChild(ic);
    row.appendChild(
      document.createTextNode(
        " " + (isPost ? `likers of ${it.value}` : it.value)
      )
    );
    if (i === 0) {
      const left = document.createElement("span");
      left.className = "left";
      left.textContent = `${remaining} left`;
      row.appendChild(left);
    }
    box.appendChild(row);
  });
}

function prettyType(t) {
  switch (t) {
    case "follow": return "following";
    case "followFollowers": return "follow followers";
    case "followLikers": return "follow likers";
    case "reconcile": return "reconcile";
    case "unfollowNonFollowers": return "cleanup";
    default: return t || "job";
  }
}

// ---- Chrome (view + card visibility) ------------------------------------
function renderChrome(job) {
  const status = (job && job.status) || "idle";
  const running = RUNNING_STATES.has(status);
  const isHome = view === "home";

  $("brandHome").hidden = !isHome;
  $("brandBack").hidden = isHome;
  $("hdrStats").hidden = !isHome;

  $("composeCard").hidden = !(isHome && !running);
  $("runningCard").hidden = !(isHome && running);

  $("homeBody").hidden = !isHome;
  $("activityBody").hidden = isHome;

  $("runningBody").hidden = !running;
  $("idleBody").hidden = running;
}

// ---- Live state ----------------------------------------------------------
async function refreshState() {
  const res = await sendToBackground("getState");
  lastJob = res && res.ok ? res.job : null;
  const running = RUNNING_STATES.has((lastJob && lastJob.status) || "idle");

  // Everything below reads from storage only, so the running-card counter keeps
  // ticking from the persisted job progress even while the job is busy driving
  // the tab. We must NOT block this loop on content-script round-trips.
  await renderAccountInfo(lastJob, running);
  const st = await renderStatsUI();
  renderChrome(lastJob);
  if (running) await renderRunningCard(lastJob, st);
  await renderLogs();

  // The Instagram tab belongs to the job while it runs; only ask the content
  // script for fresh profile counts when idle, and never await it here.
  if (!running) sendToBackground("getProfileStats");
}

async function renderAccountInfo(job, running) {
  let username = null, accountId = null;

  const { accounts, activeAccountId } = await chrome.storage.local.get([
    "accounts",
    "activeAccountId",
  ]);
  if (activeAccountId && accounts?.[activeAccountId]) {
    username = accounts[activeAccountId].username;
    accountId = activeAccountId;
  } else if (job?.accountId) {
    username = job.username;
    accountId = job.accountId;
  }

  // Fall back to querying the content script only when we still don't know the
  // account and nothing is running (so we don't poke the job's busy tab).
  if (!accountId && !running) {
    const acc = await sendToBackground("getAccountInfo");
    if (acc && acc.ok && acc.account?.accountId) {
      username = acc.account.username;
      accountId = acc.account.accountId;
    }
  }

  $("accountLabel").textContent = accountId
    ? username ? `@${username}` : `id ${accountId}`
    : "no account";
  $("accountDot").classList.toggle("on", !!accountId);
}

function startError(code) {
  switch (code) {
    case "no-tab":
    case "no-ig-tab":
      return "Open an Instagram tab first.";
    case "no-account":
      return "Couldn't detect your account — open Instagram and log in.";
    case "injection-failed":
    case "content-not-ready":
      return "Instagram page isn't ready — reload the tab and retry.";
    case "busy":
      return "A job is already running.";
    case "inactive-hours":
      return "Outside active hours — will run when the window opens.";
    default:
      return code || "Failed to start.";
  }
}

// ---- Wiring --------------------------------------------------------------
function goto(v) {
  view = v;
  renderChrome(lastJob);
}

// ---- Display mode (side panel <-> popup) ---------------------------------
// Both surfaces render this same page. The ?ctx=popup marker (set for the popup
// surface on both Chrome and Firefox) tells us which surface we're actually in,
// which is what the toggle icon should reflect.
let displayMode = new URLSearchParams(location.search).get("ctx") === "popup"
  ? "popup"
  : "sidepanel";

function renderModeButton() {
  const btn = $("modeBtn");
  const panelIcon = $("dockIconPanel"); // chevron in = "dock to side"
  const popupIcon = $("dockIconPopup"); // chevron out = "pop out"
  if (!btn || !panelIcon || !popupIcon) return;
  const isPopup = displayMode === "popup";
  // Popup mode offers docking to the side panel; side-panel mode offers popping out.
  panelIcon.style.display = isPopup ? "" : "none";
  popupIcon.style.display = isPopup ? "none" : "";
  btn.title = isPopup ? "Dock to side panel" : "Switch to popup window";
}

// Firefox exposes sidebarAction and has no chrome.sidePanel; Chrome is the
// reverse. Feature-detect so the same button works on both engines.
const HAS_SIDEBAR_ACTION = typeof browser !== "undefined" && !!browser.sidebarAction;
const HAS_SIDE_PANEL = typeof chrome !== "undefined" && !!chrome.sidePanel;

async function switchDisplayMode() {
  const goToPanel = displayMode !== "sidepanel"; // currently popup -> dock to side
  if (goToPanel) {
    await enterPanelMode();
  } else {
    await enterPopupMode();
  }
}

async function enterPanelMode() {
  if (HAS_SIDEBAR_ACTION) {
    // Firefox: sidebarAction.open() must be called synchronously inside the
    // click's user gesture — any await before it (even storage) drops the
    // gesture and Firefox silently refuses to open the sidebar. So open first,
    // persist after, then close the popup.
    let opened = false;
    try { browser.sidebarAction.open(); opened = true; } catch (_) {}
    try { browser.storage.local.set({ displayMode: "sidepanel" }); } catch (_) {}
    if (opened) window.close();
    return;
  }
  // Chrome: persist the mode first so the panel reads the right state, then open
  // it while we still hold the click's user gesture (~5s activation).
  await sendToBackground("setDisplayMode", { mode: "sidepanel" }, 4000);
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (_) {}
  window.close(); // close the popup; the panel is now open
}

async function enterPopupMode() {
  if (HAS_SIDEBAR_ACTION) {
    // Firefox: we're running inside the sidebar page, so we can't close it here
    // (that would destroy this context before the popup opens). Hand off to the
    // background, which closes the sidebar and then opens the popup.
    try { browser.storage.local.set({ displayMode: "popup" }); } catch (_) {}
    try { browser.runtime.sendMessage({ action: "openActionPopup" }); } catch (_) {}
    return;
  }
  // Chrome: rebind the toolbar icon to the anchored popup, then close THIS panel
  // and let the background open the popup afterwards. Opening it from here fails
  // because closing the panel steals focus and dismisses the popup; openPopup()
  // needs no user gesture, so the background does it once the panel is gone. If
  // that fails (old Chrome), the next toolbar-icon click opens the bound popup.
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.action.setPopup({ popup: "popup.html?ctx=popup" });
  } catch (_) {}
  try { chrome.storage.local.set({ displayMode: "popup" }); } catch (_) {}
  let windowId;
  try { windowId = (await chrome.windows.getCurrent()).id; } catch (_) {}
  // Await the message so it's actually delivered before window.close() tears
  // down this context. The background replies immediately, then opens the popup
  // after a short delay (once this panel has finished closing).
  try { await chrome.runtime.sendMessage({ action: "openActionPopup", windowId }); } catch (_) {}
  window.close(); // close the panel; the background opens the popup next
}

async function setupModeButton() {
  const btn = $("modeBtn");
  // Firefox can't rebind the toolbar icon and the popup<->sidebar toggle is
  // unreliable there, so hide the button and let users open the sidebar via the
  // native Firefox sidebar controls.
  if (HAS_SIDEBAR_ACTION) {
    if (btn) btn.style.display = "none";
    return;
  }
  // displayMode is already derived from the ?ctx marker (the surface we're in).
  // On Chrome without that marker, fall back to the persisted mode.
  if (new URLSearchParams(location.search).get("ctx") !== "popup") {
    const res = await sendToBackground("getDisplayMode", {}, 4000);
    if (res && res.mode) displayMode = res.mode;
  }
  renderModeButton();
  if (btn) btn.addEventListener("click", switchDisplayMode);
}

function wire() {
  // View navigation.
  $("brandBack").addEventListener("click", () => goto("home"));
  $("goActivity1").addEventListener("click", () => goto("activity"));
  $("goActivity2").addEventListener("click", () => goto("activity"));

  // The side panel stays open across navigation, so a one-shot detect at load
  // goes stale. Re-detect (and refresh the "+ current page" suggestion) whenever
  // the user switches tabs, a page finishes loading, or they refocus the panel.
  const redetect = async () => {
    await detectContext();
    renderRunChips();
  };
  chrome.tabs.onActivated.addListener(redetect);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === "complete" || info.url) redetect();
  });
  window.addEventListener("focus", redetect);

  // Unified input.
  $("runInput").addEventListener("input", renderRunChips);

  // Advanced collapse.
  const toggleAdv = () => {
    const open = $("advPanel").hidden;
    $("advPanel").hidden = !open;
    $("advToggle").classList.toggle("open", open);
  };
  $("advToggle").addEventListener("click", toggleAdv);
  $("advHide").addEventListener("click", toggleAdv);

  // Dry run.
  $("dryToggle").addEventListener("click", async () => {
    const on = !$("dryToggle").classList.contains("on");
    setDry(on);
    await patchSettings({ dryRun: on });
  });

  // Human-likeness slider.
  $("humanLevel").addEventListener("input", () => {
    renderPace(parseInt($("humanLevel").value, 10) || 0);
  });
  $("humanLevel").addEventListener("change", applyPreset);

  // Randomization slider (advanced).
  $("randomization").addEventListener("input", () => {
    $("randPct").textContent = `${$("randomization").value}%`;
  });
  $("randomization").addEventListener("change", async () => {
    const v = Math.max(0, Math.min(100, parseInt($("randomization").value, 10) || 0));
    await patchSettings({ randomization: v });
  });

  // Toggles.
  TOGGLE_IDS.forEach((id) => {
    $(id).addEventListener("click", async () => {
      const on = !tglOn(id);
      setTgl(id, on);
      await patchSettings({ [id]: on });
      if (SCHEDULE_TOGGLES.has(id)) await sendToBackground("updateSchedule");
    });
  });

  // Number / text inputs → persist on change.
  Object.entries(FIELD_MAP).forEach(([elId, key]) => {
    $(elId).addEventListener("change", async () => {
      const el = $(elId);
      let val;
      if (el.type === "number") {
        val = parseInt(el.value, 10);
        if (isNaN(val)) val = 0;
        if (key === "activeStartHour" || key === "activeEndHour")
          val = Math.max(0, Math.min(23, val));
        else if (key === "minDelayMs" || key === "maxDelayMs")
          val = Math.max(1000, val);
        else if (key === "sessionCap" || key === "reconcileIntervalMin")
          val = Math.max(1, val);
        else val = Math.max(0, val);
      } else if (key === "flockKeyword") {
        val = (el.value || "flock").trim().toLowerCase();
      } else {
        val = (el.value || "").trim();
      }
      const patch = { [key]: val };
      // Keep max ≥ min for the delay pair.
      if (key === "maxDelayMs" || key === "minDelayMs") {
        const s = await getSettings();
        const min = key === "minDelayMs" ? val : s.minDelayMs;
        const max = key === "maxDelayMs" ? val : s.maxDelayMs;
        if (max < min) patch[key === "minDelayMs" ? "maxDelayMs" : "minDelayMs"] = val;
      }
      await patchSettings(patch);
      if (key === "reconcileIntervalMin") await sendToBackground("updateSchedule");
    });
  });

  // Start.
  $("startBtn").addEventListener("click", async () => {
    const { items } = classifyTargets($("runInput").value);
    if (!items.length) {
      await appendLogStore("warn", "Add at least one profile or post link.");
      await renderLogs();
      return;
    }
    // User-initiated: give the background time to inject + detect the account
    // (can take a few seconds on a still-loading tab). A null here means the
    // round-trip timed out, NOT that the start failed — so we only surface an
    // explicit {ok:false}; otherwise we optimistically refresh.
    const res = await sendToBackground(
      "startJob",
      { job: { type: "follow", param: { items } } },
      20000
    );
    if (res && !res.ok) {
      await appendLogStore("error", startError(res.error));
      await renderLogs();
    } else {
      await refreshState();
    }
  });

  // Job controls.
  $("pauseBtn").addEventListener("click", async () => {
    const status = (lastJob && lastJob.status) || "idle";
    await sendToBackground(status === "paused" ? "resume" : "pause", {}, 10000);
    await refreshState();
  });
  $("stopBtn").addEventListener("click", async () => {
    await sendToBackground("stop", {}, 10000);
    await refreshState();
  });

  // Maintenance.
  $("reconcileNow").addEventListener("click", async () => {
    const res = await sendToBackground("reconcileNow", {}, 20000);
    if (res == null) await refreshState(); // timed out; assume it kicked off
    else if (res.ok) await appendLogStore("info", "Started: reconcile follow-backs");
    else if (res.reason === "none-to-unfollow")
      await appendLogStore("info", "No follow-backs to unfollow");
    else await appendLogStore("error", startError(res.reason));
    await renderLogs();
  });
  $("cleanupNow").addEventListener("click", async () => {
    const res = await sendToBackground("cleanupNow", {}, 20000);
    if (res == null) {
      await refreshState(); // timed out; assume it kicked off
    } else if (res.ok) {
      await appendLogStore(
        "info",
        res.reason === "none-to-unfollow"
          ? "No non-followers to cleanup (within 3 days or followed back)."
          : `Started: cleanup ${res.toUnfollow} non-followers`
      );
    } else {
      await appendLogStore("error", startError(res?.reason));
    }
    await renderLogs();
  });

  $("exportTracked").addEventListener("click", exportTracked);
  $("exportLog").addEventListener("click", exportLogs);
  $("clearLog").addEventListener("click", async () => {
    await chrome.storage.local.set({ logs: [] });
    await renderLogs();
  });

  // Live updates from background.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "log") {
      renderLogs();
      renderStatsUI();
    } else if (msg.type === "job") {
      lastJob = msg.job;
      renderChrome(lastJob);
      renderStatsUI().then((st) => {
        if (RUNNING_STATES.has((lastJob && lastJob.status) || "idle"))
          renderRunningCard(lastJob, st);
      });
    }
  });
}

// The background owns the canonical log; for popup-local notices we push an
// entry into the same store so it shows up in the log views.
async function appendLogStore(level, message) {
  const { logs } = await chrome.storage.local.get("logs");
  const arr = logs || [];
  arr.push({ t: Date.now(), level, message });
  await chrome.storage.local.set({ logs: arr.slice(-500) });
}

async function exportTracked() {
  const { acct, activeAccountId } = await getAccount();
  const a = acct || { tracked: {} };
  const payload = {
    exportedAt: new Date().toISOString(),
    accountId: activeAccountId,
    username: a.username || null,
    tracked: a.tracked || {},
  };
  downloadJSON(payload, `ig-tracked-${a.username || activeAccountId || "account"}.json`);
}

async function exportLogs() {
  const { logs } = await chrome.storage.local.get("logs");
  const lines = (logs || []).map(
    (e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.message}`
  );
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  triggerDownload(blob, `ig-log-${dayKeyLocal()}.txt`);
}

function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  triggerDownload(blob, name);
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- Init ----------------------------------------------------------------
async function init() {
  wire();
  await setupModeButton();
  await loadSettings();
  await detectContext();
  renderRunChips();
  await refreshState();

  // Poll state periodically, and tick the countdown every second.
  setInterval(refreshState, 2500);
  setInterval(() => {
    if (lastJob && lastJob.status === "waiting") updateNextIn(lastJob);
  }, 1000);
}

document.addEventListener("DOMContentLoaded", init);
