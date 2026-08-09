// Chrome runs this as a service worker, where storage.js is pulled in with
// importScripts. Firefox runs the background as an event page and can't use
// importScripts, so there it's loaded ahead of us via background.scripts in the
// manifest. Either way storage.js defines self.IGStore.
if (typeof importScripts === "function") {
  importScripts("storage.js");
}

const Store = self.IGStore;
const RECONCILE_ALARM = "ig-reconcile";
const CLEANUP_ALARM = "ig-cleanup";
// Heartbeat alarm: kept alive for the whole lifetime of an active job. It both
// keeps the service worker warm and, if the worker was torn down, wakes it back
// up so an interrupted job can resume itself.
const HEARTBEAT_ALARM = "ig-heartbeat";
const TERMINAL_STATUSES = new Set(["done", "stopped", "error"]);
// How many times a job may self-heal from an unexpected error before we give
// up and mark it terminally errored. Reset to 0 whenever it makes real progress.
const MAX_RETRIES = 8;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function gaussianRand(min, max) {
  let u = 0, v = 0;
  while(u === 0) u = Math.random();
  while(v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const mean = (min + max) / 2;
  const std = (max - min) / 6;
  return Math.max(min, Math.min(max, Math.floor(mean + num * std)));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Pick `k` distinct indices from [0, n), in random order.
function pickIndices(n, k) {
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(k, n)));
}

// Parse a comma/space/newline list of usernames into a normalized Set.
function parseUserList(str) {
  const set = new Set();
  String(str || "")
    .split(/[\s,]+/)
    .forEach((t) => {
      const n = (t || "")
        .trim()
        .replace(/^@/, "")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
      if (n) set.add(n);
    });
  return set;
}

function clampHour(h) {
  h = Number(h);
  if (isNaN(h)) return 0;
  return Math.max(0, Math.min(23, Math.floor(h)));
}

// Whether we're currently outside the configured active-hours window. Used to
// keep scheduled reconcile/cleanup from firing overnight.
async function outsideActiveHours(now = new Date()) {
  const s = await Store.getSettings();
  if (!s.activeHoursEnabled) return false;
  const start = clampHour(s.activeStartHour);
  const end = clampHour(s.activeEndHour);
  if (start === end) return false;
  const h = now.getHours() + now.getMinutes() / 60;
  const within = start < end ? h >= start && h < end : h >= start || h < end;
  return !within;
}

// ---- Tab Management ------------------------------------------------------
async function findInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "*://*.instagram.com/*" });
  if (!tabs || !tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

// Reads the logged-in account id straight from the ds_user_id cookie. This is a
// robust fallback for when the content script can't report it (e.g. Firefox
// messaging hiccups) and works even for HttpOnly cookies the page JS can't see.
async function getAccountIdFromCookie() {
  const urls = ["https://www.instagram.com/", "https://instagram.com/"];
  for (const url of urls) {
    try {
      const c = await chrome.cookies.get({ url, name: "ds_user_id" });
      if (c && c.value) return c.value;
    } catch (_) {}
  }
  return null;
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["storage.js", "content.js"],
      });
      await sleep(500);
      return true;
    } catch (e) {
      return false;
    }
  }
}

async function sendCommand(tabId, command, args = {}) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "execute",
      command,
      args,
    });
    return response?.result;
  } catch (e) {
    // The content script is momentarily unreachable (a navigation swapped the
    // page out, or the worker just woke). Try to re-inject once and retry
    // before surfacing the error to the caller.
    const ok = await ensureContentScriptInjected(tabId);
    if (!ok) throw e;
    await sleep(300);
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "execute",
      command,
      args,
    });
    return response?.result;
  }
}

// ---- Job Execution Engine ------------------------------------------------
class JobRunner {
  constructor(job, tabId) {
    this.job = job;
    this.tabId = tabId;
    this.counters = { acted: 0, skipped: 0, preview: 0 };
    this.handled = new Set();
    this.shouldStop = false;
    this.isPaused = false;
    this.lastUser = null;
    this.currentListUrl = null;
    // Identifies this runner's job so a stale runner (e.g. one told to stop when
    // a new job started) can't overwrite a newer job's state in storage.
    this.jobId = job.id;
    this.progressKey =
      job.type === "followFollowers" ||
      job.type === "followLikers" ||
      job.type === "follow"
        ? "followed"
        : "unfollowed";

    // ---- Resume state -----------------------------------------------------
    // Restore everything needed to pick a job back up mid-flight after a
    // service-worker restart. Re-scanning a list is idempotent: users already
    // followed show "Following" and are skipped, and addTracked dedupes.
    const p = (job && job.progress) || {};
    this.consecutiveBlocks = p.backoffLevel || 0;
    this.counters.acted = p[this.progressKey] || 0;
    this.counters.preview = p.preview || 0;
    // 0-based index of the queue target to (re)start from.
    this.queueStart = p.queueCursor || 0;

    // ---- Fatigue / session state (not persisted; best-effort) -------------
    this.sessionStart = Date.now();
    this.sinceBreak = 0;
    this.burstTarget = rand(8, 18);
    // The follows-per-hour ceiling at max humanization (R=1). Chosen once so the
    // cap doesn't jitter mid-run. Looser caps at lower humanization scale off it.
    this.hourlyMax = rand(15, 20);
    // Usernames whose recent post we'll like once the current target finishes.
    this.pendingLikes = [];
  }

  // Grows the base delay as a session drags on (up to ~+60% after an hour),
  // mimicking a person tiring. Only used when fatigue mode is on.
  fatigueFactor() {
    const mins = (Date.now() - this.sessionStart) / 60000;
    return 1 + Math.min(0.6, (mins / 60) * 0.6);
  }

  // After a burst of follows, take a longer human break. Resets the burst.
  async maybeFatigueBreak() {
    const s = await Store.getSettings();
    if (!s.fatigueEnabled) return;
    this.sinceBreak++;
    if (this.sinceBreak < this.burstTarget) return;
    this.sinceBreak = 0;
    this.burstTarget = rand(8, 18);
    const R = Math.max(0, Math.min(1, (Number(s.randomization) || 0) / 100));
    const ms = Math.round(rand(3, 12) * 60 * 1000 * (1 + R));
    await this.log("info", `Taking a break for ~${this.fmtDur(ms)} (fatigue).`);
    await this.interruptibleWait(ms, "on a break");
  }

  // Follows allowed per rolling hour, given the humanization level R (0..1).
  // At max humanization (R=1) this is 15–20/hr; it loosens as R drops.
  hourlyCap(R) {
    if (R >= 1) return this.hourlyMax;
    return Math.max(this.hourlyMax, Math.round(this.hourlyMax / (0.35 + 0.65 * R)));
  }

  // ---- Active-hours + daily-budget gating -------------------------------
  isWithinActiveHours(s, now = new Date()) {
    if (!s.activeHoursEnabled) return true;
    const start = clampHour(s.activeStartHour);
    const end = clampHour(s.activeEndHour);
    if (start === end) return true; // full day
    const h = now.getHours() + now.getMinutes() / 60;
    return start < end ? h >= start && h < end : h >= start || h < end;
  }

  msUntilActiveStart(s, now = new Date()) {
    const start = clampHour(s.activeStartHour);
    const next = new Date(now);
    next.setHours(start, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  msUntilMidnight(now = new Date()) {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime() - now.getTime();
  }

  // Block until it's OK to perform a follow: within active hours and under the
  // daily budget. Uses interruptible waits so it stays stop/pause-able and
  // survives worker restarts. Returns "go" or "stopped".
  async gateBeforeFollow() {
    for (let guard = 0; guard < 1000; guard++) {
      if (this.shouldStop) return "stopped";
      if (!(await this.checkPaused())) return "stopped";
      const s = await Store.getSettings();

      if (!this.isWithinActiveHours(s)) {
        const ms = this.msUntilActiveStart(s);
        await this.log(
          "info",
          `Outside active hours — sleeping ~${this.fmtDur(ms)} until the window opens.`
        );
        if (!(await this.interruptibleWait(ms, "outside active hours"))) return "stopped";
        continue;
      }

      if (s.dailyBudget > 0) {
        const used = await Store.getTodayCount(this.job.accountId);
        if (used >= s.dailyBudget) {
          const ms = this.msUntilMidnight();
          await this.log(
            "info",
            `Daily budget of ${s.dailyBudget} reached — pausing ~${this.fmtDur(ms)} until it resets.`
          );
          if (!(await this.interruptibleWait(ms, "daily budget reached"))) return "stopped";
          continue;
        }
      }

      // Hourly rate cap (tightens with humanization; ~15–20/hr at max).
      const R = Math.max(0, Math.min(1, (Number(s.randomization) || 0) / 100));
      const cap = this.hourlyCap(R);
      const recent = await Store.getRecentFollows(this.job.accountId, 60 * 60 * 1000);
      if (recent.length >= cap) {
        const oldest = recent[0];
        const ms = Math.max(1000, 60 * 60 * 1000 - (Date.now() - oldest) + rand(2, 20) * 1000);
        await this.log(
          "info",
          `Hourly limit (${cap}/hr) reached — pausing ~${this.fmtDur(ms)}.`
        );
        if (!(await this.interruptibleWait(ms, `hourly limit ${cap}/hr`))) return "stopped";
        continue;
      }

      return "go";
    }
    return "go";
  }

  // Cheap, row-level skip filters (no profile visit needed).
  async rowFilterSkip(row) {
    const s = await Store.getSettings();
    const blacklist = parseUserList(s.blacklist);
    if (blacklist.has(row.username)) return "blacklisted";
    if (s.skipVerified && row.verified) return "verified";
    return null;
  }

  // Deeper filters that need the profile open (verified/private/follower count).
  // Assumes the tab is already on the user's profile. Returns a reason or null.
  async profileFilterSkip(username) {
    const s = await Store.getSettings();
    const blacklist = parseUserList(s.blacklist);
    if (blacklist.has(username)) return "blacklisted";
    const needMeta =
      s.skipVerified || s.skipPrivate || s.minFollowers > 0 || s.maxFollowers > 0;
    if (!needMeta) return null;
    const meta = (await sendCommand(this.tabId, "getProfileMeta")) || {};
    if (s.skipVerified && meta.isVerified) return "verified";
    if (s.skipPrivate && meta.isPrivate) return "private";
    if (typeof meta.followers === "number") {
      if (s.minFollowers > 0 && meta.followers < s.minFollowers) return "too-few-followers";
      if (s.maxFollowers > 0 && meta.followers > s.maxFollowers) return "too-many-followers";
    }
    return null;
  }

  // After a target's list is processed, like a recent post from a random subset
  // of the people we just followed (opt-in "like on follow"). Done here rather
  // than mid-scan so we never navigate away while walking the list.
  async processPendingLikes() {
    const s = await Store.getSettings();
    const list = this.pendingLikes.slice();
    this.pendingLikes = [];
    if (!s.likeOnFollow || !list.length) return;

    const R = Math.max(0, Math.min(1, (Number(s.randomization) || 0) / 100));
    const k = Math.max(1, Math.round(list.length * (0.3 + 0.4 * R)));
    for (const idx of pickIndices(list.length, Math.min(k, list.length))) {
      const user = list[idx];
      if (this.shouldStop) return;
      if (!(await this.checkPaused())) return;
      try {
        await chrome.tabs.update(this.tabId, { url: `https://instagram.com/${user}/` });
        await this.waitForNavigation(`/${user}/`);
        await sleep(this.scaled(700, 1600, R));
        const posts = (await sendCommand(this.tabId, "getProfilePosts")) || [];
        if (!posts.length) continue;
        const href = posts[0];
        await chrome.tabs.update(this.tabId, { url: `https://instagram.com${href}` });
        await this.waitForNavigation(href.replace(/\/$/, ""));
        await sleep(this.scaled(700, 1600, R));
        if (this.job.dryRun) {
          await this.log("info", `[dry-run] Would like a recent post by @${user}`);
        } else {
          const liked = await sendCommand(this.tabId, "likePost");
          if (liked && liked.liked) await this.log("info", `Liked a recent post by @${user}`);
        }
        await sleep(this.scaled(700, 1800, R));
      } catch (_) {
        /* best-effort; keep going */
      }
    }
  }

  // ---- "Vet every profile" mode (thorough, slow) -------------------------
  // Phase 1: scan the current list and collect candidate usernames (label
  // follow/follow-back, passing the cheap row filters), without following.
  // Scrolls the list like processList but never navigates away.
  async collectCandidates(maxCollect) {
    const out = [];
    const seen = new Set();
    let stableBottom = 0;
    while (!this.shouldStop && out.length < maxCollect) {
      if (!(await this.checkPaused())) return out;
      const rows = (await sendCommand(this.tabId, "readRows")) || [];
      for (const row of rows) {
        if (row.label !== "follow" && row.label !== "follow back") continue;
        if (seen.has(row.username) || this.handled.has(row.username)) continue;
        seen.add(row.username);
        const skip = await this.rowFilterSkip(row);
        if (skip) {
          await this.log("info", `Skipped @${row.username} (${skip})`);
          this.handled.add(row.username);
          continue;
        }
        out.push(row.username);
        if (out.length >= maxCollect) break;
      }
      const atBottom = await sendCommand(this.tabId, "isAtBottom");
      if (atBottom) {
        stableBottom++;
        if (stableBottom >= 3) break;
      } else {
        stableBottom = 0;
      }
      await this.humanScroll();
    }
    return out;
  }

  // Phase 2: visit each collected profile, apply the deep filters, and follow
  // the ones that pass. Mirrors the counters/caps/humanization of processList.
  // Returns "done" | "cap" | "stopped".
  async vetAndFollow(candidates, source) {
    const settings = await Store.getSettings();
    const effectiveCap = Math.max(1, (Number(settings.sessionCap) || 100) + rand(-2, 3));
    const R = Math.max(0, Math.min(1, (Number(settings.randomization) || 0) / 100));

    for (const user of candidates) {
      if (this.shouldStop) return "stopped";
      if (!(await this.checkPaused())) return "stopped";
      // In dry-run only `preview` grows; in a live run only `acted` does — so
      // the sum caps both against the same session limit.
      if (this.counters.acted + this.counters.preview >= effectiveCap) {
        await this.log("warn", `${this.job.dryRun ? "Preview" : "Session"} cap reached (${effectiveCap})`);
        return "cap";
      }
      if (this.handled.has(user)) continue;
      this.handled.add(user);

      const path = `/${user}/`;
      try {
        await chrome.tabs.update(this.tabId, { url: `https://instagram.com${path}` });
        await this.waitForNavigation(path);
      } catch (_) {
        continue;
      }
      if (!(await this.checkPaused())) return "stopped";
      await sleep(this.scaled(500, 1400, R));

      const skip = await this.profileFilterSkip(user);
      if (skip) {
        await this.log("info", `Skipped @${user} (${skip})`);
        continue;
      }

      if (this.job.dryRun) {
        await this.log("info", `[dry-run] Would follow @${user}`);
        this.counters.preview++;
        await this.updateJob({ progress: { preview: this.counters.preview, lastUser: user } });
        continue;
      }

      const pre = await sendCommand(this.tabId, "getProfileFollowState");
      if (pre === "following" || pre === "requested") {
        await this.log("info", `Already following @${user}`);
        continue;
      }

      if ((await this.gateBeforeFollow()) === "stopped") return "stopped";
      const res = await this.followWithBackoff({
        doClick: () => sendCommand(this.tabId, "clickProfileFollow"),
        verify: () => this.verifyProfileFollow(),
        reloadUrl: path,
      });
      if (res === "stopped") return "stopped";
      if (res === "ok") {
        await Store.addTracked(this.job.accountId, user, source);
        await Store.incDaily(this.job.accountId, 1);
        this.counters.acted++;
        await this.updateJob({
          progress: { [this.progressKey]: this.counters.acted, lastUser: user, retries: 0 },
        });
        if (settings.likeOnFollow && Math.random() < 0.3 + 0.5 * R) {
          this.pendingLikes.push(user);
        }
        await this.log("info", `Followed @${user}`);
        await this.humanDelay();
        await this.maybeFatigueBreak();
      } else {
        // Clicked but unconfirmed — pace anyway so misses don't rapid-fire.
        await this.log("warn", `Couldn't confirm follow of @${user} — pacing before next`);
        await this.humanDelay();
      }
    }
    return "done";
  }

  async run() {
    await this.updateJob({ status: "running", progress: { waitUntil: null } });
    
    let threw = false;
    try {
      switch (this.job.type) {
        case "followFollowers":
          await this.runFollowQueue(
            this.getTargets().map((v) => ({ kind: "followers", value: v }))
          );
          break;
        case "followLikers":
          await this.runFollowQueue(
            this.getTargets().map((v) => ({ kind: "likers", value: v }))
          );
          break;
        case "follow":
          await this.runFollowQueue(this.getItems());
          break;
        case "reconcile":
          await this.runReconcile();
          break;
        case "unfollowNonFollowers":
          await this.runUnfollowNonFollowers();
          break;
      }
    } catch (e) {
      threw = true;
      await this.log("error", `Job error: ${e && e.message ? e.message : e}`);
    }
    
    try {
      if (this.shouldStop) {
        await this.updateJob({ status: "stopped" });
        return;
      }
      
      if (threw) {
        // Transient failure (tab closed mid-run, content script disconnect, a
        // navigation timeout, etc.). Rather than killing the job, park it so the
        // heartbeat resumes it shortly — with a capped, growing delay so a
        // persistent problem doesn't spin. Real progress resets the counter.
        const cur = await getJob();
        const prev = (cur && cur.progress && cur.progress.retries) || 0;
        const retries = prev + 1;
        if (retries > MAX_RETRIES) {
          await this.log("error", `Giving up after ${MAX_RETRIES} failed retries.`);
          await this.updateJob({ status: "error", progress: { retries } });
        } else {
          const delay = Math.min(5 * 60 * 1000, 15000 * retries);
          await this.log(
            "warn",
            `Job interrupted — retrying (#${retries}) in ${Math.round(delay / 1000)}s.`
          );
          await this.updateJob({
            status: "waiting",
            progress: { retries, waitUntil: Date.now() + delay, waitReason: "interrupted" },
          });
        }
        return;
      }
      
      await this.updateJob({ status: "done" });
    } finally {
      // Release the runner slot so a parked ("waiting") job can be resumed by
      // the heartbeat even while this worker stays alive. Identity-checked so we
      // never clear a newer runner that replaced us.
      if (activeRunner === this) activeRunner = null;
    }
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  stop() {
    this.shouldStop = true;
    this.isPaused = false;
  }

  async checkPaused() {
    while (this.isPaused && !this.shouldStop) {
      await sleep(500);
    }
    return !this.shouldStop;
  }

  async runUnfollowNonFollowers() {
    const me = this.job.username;

    await this.log("info", "Opening your following list");
    const opened = await this.openList(me, "following");
    if (!opened) {
      await this.log("warn", "Couldn't open your following list");
      return;
    }
    
    if (!(await this.checkPaused())) return;
    
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const toUnfollow = await Store.getNonFollowers(this.job.accountId, threeDaysAgo);
    
    if (toUnfollow.length === 0) {
      await this.log("info", "No non-followers to unfollow (3+ days)");
      return;
    }
    
    await this.log("info", `Found ${toUnfollow.length} non-followers to unfollow`);
    
    const unfollowSet = new Set(toUnfollow.map(u => u.username));
    const settings = await Store.getSettings();
    const protect = parseUserList(settings.protectList);
    
    await this.processList(async (row) => {
      if (!unfollowSet.has(row.username)) return "skip";
      if (protect.has(row.username)) {
        await this.log("info", `Protected @${row.username} — skipping unfollow`);
        return "skip";
      }
      
      if (row.label !== "following" && row.label !== "requested") {
        await Store.markUnfollowed(this.job.accountId, row.username, "no-follow-back");
        return "skip";
      }
      
      if (this.job.dryRun) {
        await this.log("info", `[dry-run] Would unfollow @${row.username} (no follow-back after 3 days)`);
        return "preview";
      }
      
      await this.scrollUserIntoView(row.username);
      const res = await this.unfollowRow(row.username, () => this.openList(me, "following"));
      if (res === "stopped") return "skip";
      if (res !== "ok") {
        await this.log("warn", `Couldn't confirm unfollow of @${row.username} — leaving tracked`);
        await this.humanDelay();
        return "skip";
      }
      await Store.markUnfollowed(this.job.accountId, row.username, "no-follow-back");
      await this.log("info", `Unfollowed @${row.username} (no follow-back after 3 days)`);
      return "acted";
    });
  }

  // Resolve the list of targets for a follow job. Supports the new batch form
  // (param.targets: []) and the legacy single-target form for compatibility.
  getTargets() {
    const p = this.job.param || {};
    if (Array.isArray(p.targets)) return p.targets.filter(Boolean);
    if (p.username) return [p.username];
    if (p.shortcode) return [p.shortcode];
    return [];
  }

  // Resolve a heterogeneous queue for the unified "follow" job type. Each item
  // is { kind: "followers" | "likers", value }, so a single run can mix account
  // targets (follow their followers) and post targets (follow their likers).
  getItems() {
    const p = this.job.param || {};
    if (Array.isArray(p.items)) {
      return p.items
        .filter((it) => it && it.value && (it.kind === "followers" || it.kind === "likers"))
        .map((it) => ({ kind: it.kind, value: String(it.value) }));
    }
    // Back-compat: a bare targets array is treated as follower lists.
    return this.getTargets().map((v) => ({ kind: "followers", value: v }));
  }

  // A randomized delay that grows with the randomization level R (0..1):
  // at R=0 it's the raw base delay, at R=1 up to ~3x longer.
  scaled(min, max, R) {
    return Math.round(rand(min, max) * (1 + R * 2));
  }

  // Open a profile's followers/following list. Instagram renders these as a
  // modal that only appears when the header count is clicked — a direct
  // /followers/ URL just shows the profile with no list — so we load the
  // profile and click the count, then fall back to the legacy URL if needed.
  // Returns true once the dialog is open. `which` is "followers" | "following".
  async openList(username, which) {
    const profilePath = `/${username}/`;

    // Land on the profile page if we're not already there (and not sitting on a
    // stale list/post URL from a previous target).
    const cur = await sendCommand(this.tabId, "getUrl");
    const onProfile =
      cur &&
      cur.includes(profilePath) &&
      !cur.includes("/followers/") &&
      !cur.includes("/following/") &&
      !cur.includes("/p/");
    if (!onProfile) {
      await chrome.tabs.update(this.tabId, { url: `https://instagram.com${profilePath}` });
      await this.waitForNavigation(profilePath);
      await sleep(rand(900, 1800));
    }

    let res = await sendCommand(this.tabId, "openFollowList", { which });
    if (res && res.opened) return true;

    // Fallback: some builds still open the modal from the direct URL.
    await this.log("info", `Opening ${which} via direct URL (header count not found)…`);
    await chrome.tabs.update(this.tabId, {
      url: `https://instagram.com${profilePath}${which}/`,
    });
    await this.waitForNavigation(`/${which}/`);
    await sleep(rand(900, 1800));
    res = await sendCommand(this.tabId, "openFollowList", { which });
    return !!(res && res.opened);
  }

  // Decide how many comments to like given the post's like count and how many
  // comment like-buttons are available. Mostly zero; guaranteed >=1 on popular
  // posts (>100 likes). R nudges the odds upward.
  decideCommentLikes(likeCount, available, R) {
    if (!available || available < 1) return 0;
    if (typeof likeCount === "number" && likeCount > 100) {
      const two = Math.random() < 0.35 + 0.25 * R ? 2 : 1;
      return Math.min(two, available);
    }
    const pAny = 0.12 + 0.33 * R; // chance to like anything at all
    if (Math.random() > pAny) return 0;
    const two = Math.random() < 0.2 + 0.3 * R ? 2 : 1;
    return Math.min(two, available);
  }

  // Human-style pre-visit of a post before following its likers: open the post,
  // scroll through carousel images back and forth, optionally like a comment or
  // two, and dwell. All behaviors are gated by settings and scaled by R.
  async browsePost(shortcode) {
    const s = await Store.getSettings();
    const wantBrowse = !!s.browsePosts;
    const wantComments = !!s.likeComments;
    const wantFlock = !!s.flockPriority;
    const keyword = String(s.flockKeyword || "flock").trim().toLowerCase();
    if (!wantBrowse && !wantComments && !wantFlock) return;

    const R = Math.max(0, Math.min(1, (Number(s.randomization) || 0) / 100));
    const effectiveCap = Math.max(1, Number(s.sessionCap) || 100);
    const postPath = `/p/${shortcode}/`;

    const url = await sendCommand(this.tabId, "getUrl");
    if (!url || !url.includes(postPath) || url.includes("/liked_by/")) {
      await chrome.tabs.update(this.tabId, { url: `https://instagram.com${postPath}` });
      await this.waitForNavigation(postPath);
    }
    if (!(await this.checkPaused())) return;

    await this.log("info", `Viewing post ${shortcode}`);
    await sleep(this.scaled(600, 1600, R));

    const stats = (await sendCommand(this.tabId, "getPostStats")) || {};

    // Scroll through carousel images, sometimes stepping back.
    if (wantBrowse && stats.isCarousel) {
      const swipes = Math.max(1, Math.round(rand(1, 3) * (0.5 + R)));
      let pos = 0;
      for (let i = 0; i < swipes; i++) {
        if (this.shouldStop) return;
        if (!(await this.checkPaused())) return;
        const ok = await sendCommand(this.tabId, "carousel", { dir: "next" });
        if (!ok) break;
        pos++;
        await sleep(this.scaled(500, 1500, R));
        if (pos > 0 && Math.random() < 0.3 + 0.2 * R) {
          await sendCommand(this.tabId, "carousel", { dir: "prev" });
          pos--;
          await sleep(this.scaled(400, 1200, R));
        }
      }
    }

    // Drift down into the comments a little before reading them.
    const readComments = wantComments || wantFlock;
    if (readComments && Math.random() < 0.6 + 0.3 * R) {
      await sendCommand(this.tabId, "scroll", { amount: rand(150, 400) });
      await sleep(this.scaled(500, 1400, R));
    }

    const comments = readComments
      ? (await sendCommand(this.tabId, "getComments")) || []
      : [];
    const likedIdx = new Set();

    // Always like comments from accounts matching the keyword (e.g. "flock").
    const flockUsers = [];
    if (wantFlock && keyword) {
      for (const c of comments) {
        if (!c.username || !c.username.includes(keyword)) continue;
        if (!flockUsers.includes(c.username)) flockUsers.push(c.username);
        if (typeof c.index !== "number" || likedIdx.has(c.index)) continue;
        if (this.job.dryRun) {
          await this.log("info", `[dry-run] Would like @${c.username}'s comment (keyword)`);
        } else {
          const ok = await sendCommand(this.tabId, "likeComment", { index: c.index });
          if (ok) {
            likedIdx.add(c.index);
            await this.log("info", `Liked @${c.username}'s comment (keyword match)`);
          }
          await sleep(this.scaled(500, 1400, R));
        }
      }
    }

    // Occasionally like a comment or two at random (mostly none).
    if (wantComments && comments.length) {
      const n = this.decideCommentLikes(stats.likeCount, comments.length, R);
      if (n > 0) {
        const pool = comments
          .map((c) => c.index)
          .filter((i) => typeof i === "number" && !likedIdx.has(i));
        for (const p of pickIndices(pool.length, Math.min(n, pool.length))) {
          const idx = pool[p];
          if (this.shouldStop) return;
          if (!(await this.checkPaused())) return;
          if (this.job.dryRun) {
            await this.log("info", `[dry-run] Would like a comment on ${shortcode}`);
          } else {
            const ok = await sendCommand(this.tabId, "likeComment", { index: idx });
            if (ok) {
              likedIdx.add(idx);
              await this.log("info", `Liked a comment on ${shortcode}`);
            }
          }
          await sleep(this.scaled(700, 2000, R));
        }
      }
    }

    await sleep(this.scaled(400, 1200, R));

    // Engage keyword accounts: visit their profile, follow, and maybe like a
    // few of their posts. Odds and count scale with the randomization level, so
    // at max it happens for nearly every match and digs much deeper.
    let detoured = false;
    if (wantFlock && flockUsers.length) {
      const maxVisits = Math.max(1, Math.round(1 + R * 3));
      let visits = 0;
      for (const user of flockUsers) {
        if (visits >= maxVisits) break;
        if (this.shouldStop) return;
        if (!(await this.checkPaused())) return;
        if (this.counters.acted + this.counters.preview >= effectiveCap) break;
        if (this.handled.has(user)) continue;
        if (Math.random() > 0.2 + 0.75 * R) continue;
        visits++;
        detoured = true;
        await this.engageFlockProfile(user, R);
      }
    }

    // If we wandered off to a keyword account's profile/posts, head back to the
    // original post (like tapping "back") and dwell a moment before opening its
    // likers — much more natural than jumping straight from a stranger's profile
    // to the likers dialog.
    if (detoured && !this.shouldStop) {
      await chrome.tabs.update(this.tabId, { url: `https://instagram.com${postPath}` });
      await this.waitForNavigation(postPath);
      await this.log("info", `Back to post ${shortcode}`);
      await sleep(this.scaled(600, 1600, R));
      if (Math.random() < 0.4 + 0.2 * R) {
        await sendCommand(this.tabId, "scroll", { amount: rand(-300, -120) });
        await sleep(this.scaled(400, 1000, R));
      }
    }

    // Settle before heading to the likers list.
    await sleep(this.scaled(500, 1500, R));
  }

  // Visit a keyword-matched commenter's profile, follow them, and (scaled by R)
  // like a few of their posts, browsing carousel photos along the way. Every
  // dwell/step is randomized; at high R the whole visit becomes much longer.
  async engageFlockProfile(username, R) {
    const path = `/${username}/`;
    await chrome.tabs.update(this.tabId, { url: `https://instagram.com${path}` });
    await this.waitForNavigation(path);
    if (!(await this.checkPaused())) return;

    await this.log("info", `Visiting keyword account @${username}`);
    await sleep(this.scaled(800, 2000, R));

    // We're on the profile now, so we can apply the deeper skip-filters
    // (verified / private / follower thresholds) before deciding to follow.
    const skip = await this.profileFilterSkip(username);
    if (skip) {
      this.handled.add(username);
      await this.log("info", `Skipped keyword account @${username} (${skip})`);
      return;
    }

    if (this.job.dryRun) {
      // Count keyword-account follows toward the preview + cap, like every other
      // dry-run follow, so the previewed total is honest.
      this.handled.add(username);
      this.counters.preview++;
      await this.updateJob({ progress: { preview: this.counters.preview, lastUser: username } });
      await this.log("info", `[dry-run] Would follow @${username}`);
    } else {
      const pre = await sendCommand(this.tabId, "getProfileFollowState");
      if (pre === "following" || pre === "requested") {
        this.handled.add(username);
        await this.log("info", `Already following @${username}`);
      } else {
        if ((await this.gateBeforeFollow()) === "stopped") return;
        const res = await this.followWithBackoff({
          doClick: () => sendCommand(this.tabId, "clickProfileFollow"),
          verify: () => this.verifyProfileFollow(),
          reloadUrl: path,
        });
        if (res === "stopped") return;
        if (res === "ok") {
          await Store.addTracked(this.job.accountId, username, "keyword-comment");
          await Store.incDaily(this.job.accountId, 1);
          this.handled.add(username);
          this.counters.acted++;
          await this.updateJob({
            progress: { [this.progressKey]: this.counters.acted, lastUser: username, retries: 0 },
          });
          await this.log("info", `Followed keyword account @${username}`);
        } else {
          await this.log("warn", `Couldn't follow @${username}`);
        }
      }
    }
    await sleep(this.scaled(600, 1500, R));

    // Maybe like/browse a few of their posts.
    if (Math.random() > 0.2 + 0.6 * R) return;
    const posts = (await sendCommand(this.tabId, "getProfilePosts")) || [];
    if (!posts.length) return;

    const count = Math.max(1, Math.round(rand(1, 2) * (0.5 + R * 2)));
    for (const p of pickIndices(posts.length, Math.min(count, posts.length))) {
      if (this.shouldStop) return;
      if (!(await this.checkPaused())) return;
      const href = posts[p];
      const frag = href.replace(/\/$/, "");
      await chrome.tabs.update(this.tabId, { url: `https://instagram.com${href}` });
      await this.waitForNavigation(frag);
      await sleep(this.scaled(700, 1800, R));

      const pstats = (await sendCommand(this.tabId, "getPostStats")) || {};
      if (pstats.isCarousel) {
        const swipes = Math.max(1, Math.round(rand(1, 3) * (0.5 + R)));
        for (let i = 0; i < swipes; i++) {
          if (this.shouldStop) return;
          if (!(await this.checkPaused())) return;
          const ok = await sendCommand(this.tabId, "carousel", { dir: "next" });
          if (!ok) break;
          await sleep(this.scaled(500, 1400, R));
          if (Math.random() < 0.3 + 0.2 * R) {
            await sendCommand(this.tabId, "carousel", { dir: "prev" });
            await sleep(this.scaled(400, 1000, R));
          }
        }
      }

      if (this.job.dryRun) {
        await this.log("info", `[dry-run] Would like a post by @${username}`);
      } else {
        const liked = await sendCommand(this.tabId, "likePost");
        if (liked && liked.liked) {
          await this.log("info", `Liked a post by @${username}`);
        }
      }
      await sleep(this.scaled(700, 2000, R));
    }
  }

  // Unified queue runner for both "followers" (of accounts) and "likers"
  // (of posts). Navigates to each target in turn and auto-advances to the next
  // once a target's list is exhausted. A session-cap hit or stop halts the
  // entire queue.
  async runFollowQueue(items) {
    if (!items || items.length === 0) {
      await this.log("warn", "No targets provided");
      return;
    }
    
    await this.updateJob({ progress: { queueTotal: items.length } });
    
    for (let i = this.queueStart; i < items.length; i++) {
      if (this.shouldStop) return;
      if (!(await this.checkPaused())) return;
      
      const kind = items[i].kind;
      const target = items[i].value;
      const desired =
        kind === "followers" ? `/${target}/followers/` : `/p/${target}/liked_by/`;
      const source =
        kind === "followers" ? `followers-of:${target}` : `post-likers:${target}`;
      const label =
        kind === "followers" ? `followers of @${target}` : `likers of ${target}`;
      
      await this.updateJob({
        progress: { queueIndex: i + 1, queueCursor: i, currentTarget: target },
      });
      await this.log("info", `(${i + 1}/${items.length}) Following ${label}`);
      
      // Human-style pre-visit of the post (opt-in) before opening its likers.
      if (kind === "likers") {
        await this.browsePost(target);
        if (this.shouldStop) return;
        if (!(await this.checkPaused())) return;
      }
      
      if (kind === "followers") {
        const opened = await this.openList(target, "followers");
        if (!opened) {
          await this.log("warn", `Couldn't open @${target}'s followers list — skipping`);
          await this.updateJob({ progress: { queueCursor: i + 1 } });
          continue;
        }
      } else {
        const url = await sendCommand(this.tabId, "getUrl");
        if (!url || !url.includes(desired)) {
          await chrome.tabs.update(this.tabId, { url: `https://instagram.com${desired}` });
          await this.waitForNavigation(desired);
        }
      }
      
      if (!(await this.checkPaused())) return;
      
      const startActed = this.counters.acted;
      const startPreview = this.counters.preview;
      this.currentListUrl = desired;
      
      // "Vet every profile" mode: only worth the detour when a filter actually
      // needs the profile page (private / follower range). Otherwise the fast
      // in-list path already covers blacklist + verified.
      const gs = await Store.getSettings();
      const needsProfile =
        gs.skipPrivate || gs.minFollowers > 0 || gs.maxFollowers > 0;
      const useVet = gs.vetAllProfiles && needsProfile;
      
      let status;
      if (useVet) {
        await this.log("info", "Vetting every profile before following (thorough mode)…");
        const cap = Math.max(1, Number(gs.sessionCap) || 100);
        const remaining = Math.max(0, cap - this.counters.acted);
        const maxCollect = Math.max(30, remaining * 3 + 30);
        const candidates = await this.collectCandidates(maxCollect);
        if (this.shouldStop) return;
        status = await this.vetAndFollow(candidates, source);
      } else {
      if (gs.vetAllProfiles && !needsProfile) {
        await this.log(
          "info",
          "Vet-all is on but no profile filter (private/followers) is set — following normally."
        );
      }
      status = await this.processList(async (row) => {
        if (row.label === "follow" || row.label === "follow back") {
          // Cheap skip-filters (blacklist / verified) before doing anything.
          const skip = await this.rowFilterSkip(row);
          if (skip) {
            await this.log("info", `Skipped @${row.username} (${skip})`);
            return "skip";
          }
          if (this.job.dryRun) {
            await this.log("info", `[dry-run] Would follow @${row.username}`);
            return "preview";
          }
          // Respect active-hours + daily budget before each follow.
          if ((await this.gateBeforeFollow()) === "stopped") return "skip";
          // Scroll the row into view so the follow happens where we're looking.
          await this.scrollUserIntoView(row.username);
          const res = await this.followWithBackoff({
            doClick: () => sendCommand(this.tabId, "clickUser", { username: row.username }),
            verify: () => this.verifyListFollow(row.username),
            // Followers live in a modal, so after a backoff cool-down we must
            // reopen it rather than just reloading a URL.
            reloadUrl: kind === "likers" ? this.currentListUrl : null,
            reopen: kind === "followers" ? () => this.openList(target, "followers") : null,
          });
          if (res === "stopped") return "skip";
          if (res === "ok") {
            await Store.addTracked(this.job.accountId, row.username, source);
            await Store.incDaily(this.job.accountId, 1);
            const s = await Store.getSettings();
            const R = Math.max(0, Math.min(1, (Number(s.randomization) || 0) / 100));
            if (s.likeOnFollow && Math.random() < 0.3 + 0.5 * R) {
              this.pendingLikes.push(row.username);
            }
            await this.log("info", `Followed @${row.username}`);
            return "acted";
          }
          // We clicked but couldn't confirm it. Still pace like a human before
          // the next attempt so a string of misses can't turn into rapid-fire
          // clicking (which both looks robotic and trips action blocks).
          await this.log("warn", `Couldn't confirm follow of @${row.username} — pacing before next`);
          await this.humanDelay();
          return "skip";
        }
        return "skip";
      });
      }
      
      // Per-target summary line.
      const actedHere = this.counters.acted - startActed;
      const previewHere = this.counters.preview - startPreview;
      const name = kind === "followers" ? `@${target}` : target;
      const summary = this.job.dryRun
        ? `would follow ${previewHere}`
        : `${actedHere} followed`;
      await this.log("info", `${name}: ${summary}`);
      
      // Cap reached or user stopped/paused-then-stopped: halt the whole queue.
      if (status === "cap" || status === "stopped") return;
      
      // Like a recent post from a few people we just followed (opt-in). Done
      // between targets so we never navigate away mid-scan.
      await this.processPendingLikes();
      if (this.shouldStop) return;
      
      // Target fully processed — advance the resume cursor so a restart won't
      // needlessly re-scan a finished target.
      await this.updateJob({ progress: { queueCursor: i + 1 } });
    }
    
    await this.log(
      "info",
      `Queue complete — processed ${items.length} target${items.length > 1 ? "s" : ""}`
    );
  }

  async runReconcile() {
    const me = this.job.username;

    await this.log("info", "Opening your followers");
    const opened = await this.openList(me, "followers");
    if (!opened) {
      await this.log("warn", "Couldn't open your followers list");
      return;
    }
    
    if (!(await this.checkPaused())) return;
    
    const tracked = await Store.getTrackedFollowing(this.job.accountId);
    const trackedSet = new Set(tracked);
    const settings = await Store.getSettings();
    const protect = parseUserList(settings.protectList);
    
    await this.processList(async (row) => {
      if (!trackedSet.has(row.username)) return "skip";
      if (row.label !== "following" && row.label !== "requested") return "skip";
      if (protect.has(row.username)) {
        await this.log("info", `Protected @${row.username} — skipping unfollow`);
        return "skip";
      }
      
      if (this.job.dryRun) {
        await this.log("info", `[dry-run] Would unfollow @${row.username} (followed back)`);
        return "preview";
      }
      
      await this.scrollUserIntoView(row.username);
      const res = await this.unfollowRow(row.username, () => this.openList(me, "followers"));
      if (res === "stopped") return "skip";
      if (res !== "ok") {
        await this.log("warn", `Couldn't confirm unfollow of @${row.username} — leaving tracked`);
        await this.humanDelay();
        return "skip";
      }
      await Store.markUnfollowed(this.job.accountId, row.username, "followed-back");
      await this.log("info", `Unfollowed @${row.username} (followed back)`);
      return "acted";
    });
  }

  // Returns a status so callers (notably the multi-target queue) can decide
  // whether to advance to the next target ("done") or halt the whole run
  // ("cap" or "stopped").
  async processList(onRow) {
    let stableBottom = 0;
    // Snapshot the (jittered) cap once per run so the stopping threshold is
    // stable — recomputing it per row makes the stop point wobble. In a live
    // run only `acted` grows; in a dry run only `preview` does, so both are
    // measured against this same limit.
    const settings = await Store.getSettings();
    const effectiveCap = (Number(settings.sessionCap) || 100) + rand(-2, 3);
    
    while (!this.shouldStop) {
      if (!(await this.checkPaused())) return "stopped";
      
      const rows = await sendCommand(this.tabId, "readRows");
      
      for (const row of rows) {
        if (this.handled.has(row.username)) continue;
        if (this.shouldStop) return "stopped";
        if (!(await this.checkPaused())) return "stopped";
        
        if (Math.random() < 0.15) {
          await sleep(rand(1000, 3000));
        }
        
        const result = await onRow(row);
        this.handled.add(row.username);
        
        if (result === "acted") {
          this.counters.acted++;
          await this.updateJob({
            progress: {
              [this.progressKey]: this.counters.acted,
              lastUser: row.username,
              retries: 0,
            },
          });
          if (this.counters.acted >= effectiveCap) {
            await this.log("warn", `Session cap reached (${effectiveCap})`);
            return "cap";
          }
          
          await this.humanDelay();
        } else if (result === "preview") {
          this.counters.preview++;
          await this.updateJob({
            progress: { preview: this.counters.preview, lastUser: row.username },
          });
          // Dry runs preview only as far as a real run would go.
          if (this.counters.preview >= effectiveCap) {
            await this.log("warn", `Preview cap reached (${effectiveCap})`);
            return "cap";
          }
        }
      }
      
      const atBottom = await sendCommand(this.tabId, "isAtBottom");
      if (atBottom) {
        stableBottom++;
        if (stableBottom >= 3) return "done";
      } else {
        stableBottom = 0;
      }
      
      await this.humanScroll();
    }
    return "stopped";
  }

  // Bring a row into view before acting on it, so the follow/unfollow happens
  // at the row we're actually looking at — never while the list has drifted
  // somewhere else. Best-effort; a virtualized-away row just no-ops.
  async scrollUserIntoView(username) {
    try {
      await sendCommand(this.tabId, "scrollToUser", { username });
    } catch (_) {}
    // Dwell on the row before acting; the pause grows with the human-likeness
    // level so the scroll → look → follow rhythm slows down at higher stealth.
    const s = await Store.getSettings();
    const R = Math.max(0, Math.min(1, (Number(s.randomization) || 0) / 100));
    await sleep(this.scaled(180, 460, R));
  }

  async humanScroll() {
    // Occasionally drift back up first, like a human re-reading a few rows.
    if (Math.random() < 0.18) {
      const ups = rand(1, 2);
      for (let i = 0; i < ups; i++) {
        await sendCommand(this.tabId, "scroll", { amount: -rand(80, 260) });
        await sleep(rand(200, 700));
      }
      await sleep(rand(400, 1200));
    }
    
    // Main downward travel, in a randomized number of variable-size chunks.
    const chunks = rand(2, 5);
    for (let i = 0; i < chunks; i++) {
      await sendCommand(this.tabId, "scroll", { amount: rand(120, 420) });
      await sleep(rand(150, 550));
      
      // Small chance of a tiny corrective up-scroll mid-run.
      if (Math.random() < 0.1) {
        await sendCommand(this.tabId, "scroll", { amount: -rand(40, 140) });
        await sleep(rand(150, 400));
      }
    }
    
    // Occasional longer "reading" pause.
    if (Math.random() < 0.3) {
      await sleep(rand(2000, 5000));
    }
  }

  async humanDelay() {
    const s = await Store.getSettings();
    let ms = gaussianRand(s.minDelayMs, s.maxDelayMs);
    if (s.fatigueEnabled) ms = Math.round(ms * this.fatigueFactor());
    await sleep(ms);
  }

  // Escalating cool-down after an Instagram action block, keyed by how many
  // consecutive blocks we've hit: 1st & 2nd → 10–45 min, 3rd → 1–3 h,
  // 4th and beyond → 2–6 h (the max).
  backoffDuration(level) {
    if (level <= 2) return rand(10, 45) * 60 * 1000;
    if (level === 3) return rand(1, 3) * 60 * 60 * 1000;
    return rand(2, 6) * 60 * 60 * 1000;
  }

  fmtDur(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // Sleep for `totalMs`, in small chunks, so we can honor stop/pause and keep
  // the popup's countdown fresh. Freezes the countdown while paused. Returns
  // false if the run was stopped during the wait.
  async interruptibleWait(totalMs, reason) {
    let remaining = totalMs;
    await this.updateJob({
      status: "waiting",
      progress: {
        waitUntil: Date.now() + remaining,
        backoffLevel: this.consecutiveBlocks,
        waitReason: reason || null,
      },
    });
    while (remaining > 0) {
      if (this.shouldStop) return false;
      if (this.isPaused) {
        await sleep(500);
        continue;
      }
      const chunk = Math.min(20000, remaining);
      await sleep(chunk);
      remaining -= chunk;
      await this.updateJob({ progress: { waitUntil: Date.now() + remaining } });
    }
    if (!this.shouldStop) {
      await this.updateJob({ status: "running", progress: { waitUntil: null, waitReason: null } });
    }
    return !this.shouldStop;
  }

  // Attempt a follow and confirm it took. If Instagram blocked the action, wait
  // out the escalating backoff (reloading the page between tries) and retry
  // until it succeeds or the run is stopped.
  //   doClick   → performs the follow click, returns anything
  //   verify    → returns "ok" | "blocked" | "failed"
  //   reloadUrl → path to reload before each retry (keeps the button fresh)
  // Returns "ok" | "failed" | "stopped".
  async followWithBackoff({ doClick, verify, reloadUrl, reopen, actionName = "Follow" }) {
    const verb = actionName.toLowerCase() + "s"; // "follows" / "unfollows"
    // Poll the verification a few times before concluding it failed. The
    // Follow button (especially in the likers/followers modal) can take a
    // second or two to flip to "Following", and the row may re-render — a
    // single check misreads those genuine follows as failures, which both
    // loses the tracked follow AND skips the human pacing delay (making the
    // run fire clicks back-to-back).
    const confirm = async () => {
      for (let i = 0; i < 6; i++) {
        const st = await verify();
        if (st === "ok" || st === "blocked") return st;
        await sleep(rand(400, 750));
      }
      return "failed";
    };

    await doClick();
    await sleep(rand(600, 1100));
    let state = await confirm();

    while (state === "blocked") {
      if (this.shouldStop) return "stopped";
      this.consecutiveBlocks++;
      const waitMs = this.backoffDuration(this.consecutiveBlocks);
      await this.log(
        "warn",
        `Instagram action block detected — pausing ${verb} for ${this.fmtDur(waitMs)} (block #${this.consecutiveBlocks}), then retrying.`
      );
      try {
        await sendCommand(this.tabId, "dismissDialog");
      } catch (_) {}

      const ok = await this.interruptibleWait(waitMs, `action block #${this.consecutiveBlocks}`);
      if (!ok) return "stopped";

      if (reopen) {
        try {
          await reopen();
          await sleep(rand(800, 1600));
        } catch (_) {}
      } else if (reloadUrl) {
        try {
          await chrome.tabs.update(this.tabId, { url: `https://instagram.com${reloadUrl}` });
          await this.waitForNavigation(reloadUrl);
          await sleep(rand(800, 1600));
        } catch (_) {}
      }

      await doClick();
      await sleep(rand(600, 1100));
      state = await confirm();
    }

    if (state === "ok") {
      if (this.consecutiveBlocks > 0) {
        await this.log("info", `${actionName} succeeded — action block appears lifted.`);
        this.consecutiveBlocks = 0;
        await this.updateJob({ progress: { backoffLevel: 0 } });
      }
      return "ok";
    }
    return "failed";
  }

  // Confirm an unfollow: the row's button must have flipped back to Follow, or
  // the user dropped out of the list entirely (only possible on our own
  // *following* list). An action-block notice takes precedence so we never mark
  // someone unfollowed while still following them.
  async verifyUnfollow(username) {
    const b = await sendCommand(this.tabId, "detectActionBlock");
    if (b && b.blocked) return "blocked";
    const label = await sendCommand(this.tabId, "getUserButtonLabel", { username });
    if (label === "following" || label === "requested") return "failed";
    return "ok"; // "follow"/"follow back" or gone from the list
  }

  // Perform one verified, block-aware unfollow of a list row. Reopens the given
  // list on backoff (unfollows happen inside the followers/following modal).
  // Returns "ok" | "failed" | "stopped".
  async unfollowRow(username, reopen) {
    return this.followWithBackoff({
      actionName: "Unfollow",
      doClick: async () => {
        await sendCommand(this.tabId, "clickUser", { username });
        await sleep(rand(500, 1000));
        await sendCommand(this.tabId, "clickUnfollow");
      },
      verify: () => this.verifyUnfollow(username),
      reopen,
    });
  }

  // Confirm a list follow by re-reading the row's button; distinguish a genuine
  // block from an ordinary miss.
  async verifyListFollow(username) {
    const label = await sendCommand(this.tabId, "getUserButtonLabel", { username });
    if (label === "following" || label === "requested") return "ok";
    const b = await sendCommand(this.tabId, "detectActionBlock");
    if (b && b.blocked) return "blocked";
    return "failed";
  }

  // Confirm a profile-header follow the same way.
  async verifyProfileFollow() {
    const label = await sendCommand(this.tabId, "getProfileFollowState");
    if (label === "following" || label === "requested") return "ok";
    const b = await sendCommand(this.tabId, "detectActionBlock");
    if (b && b.blocked) return "blocked";
    return "failed";
  }

  async waitForNavigation(pathFragment) {
    for (let i = 0; i < 30; i++) {
      try {
        const url = await sendCommand(this.tabId, "getUrl");
        if (url && url.includes(pathFragment)) {
          await ensureContentScriptInjected(this.tabId);
          return;
        }
      } catch (_) {
        // Page is mid-reload: the content script isn't reachable yet.
        // Attempt to (re)inject and keep polling instead of aborting the job.
        await ensureContentScriptInjected(this.tabId);
      }
      await sleep(500);
    }
    throw new Error("Navigation timeout");
  }

  async updateJob(patch) {
    const { job } = await chrome.storage.local.get("job");
    if (!job) return;
    // A newer job replaced ours (e.g. the user started a different run): stay
    // silent instead of clobbering it as this stale runner winds down.
    if (this.jobId && job.id !== this.jobId) return;
    const next = { ...job, ...patch, progress: { ...job.progress, ...(patch.progress || {}) } };
    await chrome.storage.local.set({ job: next });
    if (patch.status) await syncHeartbeat(next);
    chrome.runtime.sendMessage({ type: "job", job: next }).catch(() => {});
  }

  async log(level, message) {
    const entry = { t: Date.now(), level, message };
    const { logs } = await chrome.storage.local.get("logs");
    const next = (logs || []).concat(entry).slice(-200);
    await chrome.storage.local.set({ logs: next });
    chrome.runtime.sendMessage({ type: "log", entry }).catch(() => {});
  }
}

// ---- Scheduling -----------------------------------------------------------
async function scheduleReconcile() {
  const s = await Store.getSettings();
  await chrome.alarms.clear(RECONCILE_ALARM);
  if (s.reconcileEnabled) {
    const minutes = Math.max(1, Number(s.reconcileIntervalMin) || 15);
    const jitter = rand(-2, 2);
    chrome.alarms.create(RECONCILE_ALARM, { 
      periodInMinutes: Math.max(1, minutes + jitter) 
    });
  }
}

async function scheduleCleanup() {
  const s = await Store.getSettings();
  await chrome.alarms.clear(CLEANUP_ALARM);
  if (s.cleanupEnabled !== false) {
    const minutes = Math.max(60, Number(s.cleanupIntervalMin) || 1440);
    const jitter = rand(-30, 30);
    chrome.alarms.create(CLEANUP_ALARM, { 
      periodInMinutes: Math.max(60, minutes + jitter)
    });
  }
}

// ---- Heartbeat + self-resume ----------------------------------------------
// Arm the heartbeat while a job is active; clear it once the job is terminal.
async function syncHeartbeat(job) {
  const active = job && !TERMINAL_STATUSES.has(job.status);
  try {
    if (active) {
      await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
    } else {
      await chrome.alarms.clear(HEARTBEAT_ALARM);
    }
  } catch (_) {}
}

// Re-entrancy guard so overlapping heartbeats / startup events can't spin up
// two runners for the same job.
let resuming = false;

// Resume an interrupted job if one is parked in storage but no runner is live.
// Handles a worker that was torn down mid-run or mid-backoff-wait, or a browser
// restart. Paused jobs are left alone (the user paused them on purpose).
async function resumeJobIfNeeded() {
  if (activeRunner || resuming) return;
  const job = await getJob();
  if (!job || TERMINAL_STATUSES.has(job.status)) {
    await syncHeartbeat(job);
    return;
  }
  // Keep the heartbeat armed for any non-terminal job (incl. paused/waiting).
  await syncHeartbeat(job);

  if (job.status === "paused") return;
  if (job.status === "waiting") {
    const until = (job.progress && job.progress.waitUntil) || 0;
    if (until && Date.now() < until) return; // still cooling down
  }

  resuming = true;
  try {
    const tab = await findInstagramTab();
    if (!tab) return;
    const injected = await ensureContentScriptInjected(tab.id);
    if (!injected) return;
    // Re-check after the awaits above: a concurrent startJob/stop may have run.
    if (activeRunner) return;
    const fresh = await getJob();
    if (!fresh || fresh.id !== job.id || TERMINAL_STATUSES.has(fresh.status)) return;
    if (fresh.status === "paused") return;
    await appendLog("info", "Resuming interrupted job after restart…");
    activeRunner = new JobRunner(fresh, tab.id);
    activeRunner.run();
  } finally {
    resuming = false;
  }
}

// ---- State Management -----------------------------------------------------
let activeRunner = null;
// Guards the startJob handler: its setup is async (tab lookup, injection,
// account detection), so two quick clicks could otherwise interleave and spin
// up two runners driving the same tab at once.
let starting = false;

async function getJob() {
  const { job } = await chrome.storage.local.get("job");
  return job || null;
}

async function saveJob(job) {
  await chrome.storage.local.set({ job });
  await syncHeartbeat(job);
}

// Module-level log writer (mirrors JobRunner.log) for events that happen
// outside a runner, e.g. the resume path.
async function appendLog(level, message) {
  const entry = { t: Date.now(), level, message };
  const { logs } = await chrome.storage.local.get("logs");
  const next = (logs || []).concat(entry).slice(-200);
  await chrome.storage.local.set({ logs: next });
  chrome.runtime.sendMessage({ type: "log", entry }).catch(() => {});
}

// ---- Message Handling -----------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.action) {
      case "ping":
        sendResponse({ ok: true });
        break;
        
      case "startJob": {
        if (starting) {
          sendResponse({ ok: false, error: "busy" });
          return;
        }
        starting = true;
        try {
          if (activeRunner) {
            activeRunner.stop();
            activeRunner = null;
          }
          
          const tab = await findInstagramTab();
          if (!tab) {
            sendResponse({ ok: false, error: "no-tab" });
            return;
          }
          
          const injected = await ensureContentScriptInjected(tab.id);
          if (!injected) {
            sendResponse({ ok: false, error: "injection-failed" });
            return;
          }
          
          const accountInfo = await sendCommand(tab.id, "getAccountInfo");
          if (!accountInfo || !accountInfo.accountId) {
            sendResponse({ ok: false, error: "no-account" });
            return;
          }
          
          const settings = await Store.getSettings();
          const job = {
            id: `${Date.now()}`,
            type: msg.job.type,
            param: msg.job.param || {},
            status: "running",
            progress: { followed: 0, unfollowed: 0, preview: 0 },
            startedAt: Date.now(),
            accountId: accountInfo.accountId,
            username: accountInfo.username,
            dryRun: settings.dryRun,
          };
          
          await saveJob(job);
          
          activeRunner = new JobRunner(job, tab.id);
          activeRunner.run();
          
          sendResponse({ ok: true, job });
        } finally {
          starting = false;
        }
        break;
      }
      
      case "pause": {
        if (activeRunner) activeRunner.pause();
        // Persist paused even if no runner is live (worker may have been torn
        // down); the heartbeat won't auto-resume a paused job.
        const job = await getJob();
        if (job && !TERMINAL_STATUSES.has(job.status)) {
          await saveJob({ ...job, status: "paused" });
        }
        sendResponse({ ok: true });
        break;
      }
        
      case "resume": {
        const job = await getJob();
        if (job && job.status === "paused") {
          if (activeRunner) {
            // Release the existing (parked) loop. Do NOT call run() again, or a
            // second concurrent loop would run on the same runner.
            activeRunner.resume();
            await saveJob({ ...job, status: "running" });
          } else {
            // Worker was torn down while paused — rebuild the runner and resume
            // from persisted progress.
            const tab = await findInstagramTab();
            if (tab && (await ensureContentScriptInjected(tab.id))) {
              await saveJob({ ...job, status: "running" });
              activeRunner = new JobRunner({ ...job, status: "running" }, tab.id);
              activeRunner.run();
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }
        
      case "stop": {
        if (activeRunner) {
          activeRunner.stop();
          activeRunner = null;
        }
        const job = await getJob();
        if (job) await saveJob({ ...job, status: "stopped" });
        sendResponse({ ok: true });
        break;
      }
        
      case "getState": {
        const job = await getJob();
        sendResponse({ ok: true, job });
        break;
      }
        
      case "getAccountInfo": {
        const tab = await findInstagramTab();
        let account = null;
        // Preferred path: ask the content script (gets the @username too).
        if (tab) {
          const injected = await ensureContentScriptInjected(tab.id);
          if (injected) {
            try { account = await sendCommand(tab.id, "getAccountInfo"); } catch (_) {}
          }
        }
        // Fallback: read the login cookie directly. Fixes "no account" when the
        // content script is unreachable (notably on Firefox).
        if (!account || !account.accountId) {
          const cookieId = await getAccountIdFromCookie();
          if (cookieId) {
            const existing = await Store.getAccount(cookieId);
            account = {
              accountId: cookieId,
              username: (account && account.username) || existing?.username || null,
            };
          }
        }
        if (account?.accountId) {
          await Store.ensureAccount(account.accountId, account.username);
          sendResponse({ ok: true, account });
        } else {
          sendResponse({ ok: false, error: tab ? "no-account" : "no-tab" });
        }
        break;
      }
        
      case "getProfileStats": {
        const tab = await findInstagramTab();
        if (!tab) {
          sendResponse({ ok: false, error: "no-tab" });
          break;
        }
        const injected = await ensureContentScriptInjected(tab.id);
        if (!injected) {
          sendResponse({ ok: false, error: "injection-failed" });
          break;
        }
        try {
          const info = await sendCommand(tab.id, "getProfileStats");
          // Only trust/persist counts scraped from the user's own profile.
          if (info?.onOwnProfile && info.accountId && info.stats) {
            await Store.setProfileStats(info.accountId, info.stats);
          }
          sendResponse({ ok: true, info });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }
        
      case "updateSchedule":
        await scheduleReconcile();
        await scheduleCleanup();
        sendResponse({ ok: true });
        break;
        
      case "reconcileNow": {
        const res = await triggerReconcile();
        sendResponse(res);
        break;
      }
        
      case "cleanupNow": {
        const res = await triggerCleanup();
        sendResponse(res);
        break;
      }

      case "getDisplayMode": {
        sendResponse({ ok: true, mode: await getStoredDisplayMode() });
        break;
      }

      case "setDisplayMode": {
        const mode = await applyDisplayMode(msg.mode);
        try {
          await chrome.storage.local.set({ displayMode: mode });
        } catch (_) {}
        sendResponse({ ok: true, mode });
        break;
      }

      case "openActionPopup": {
        // Called right after the side panel closes itself. We open the popup
        // here (not in the panel) so the panel's teardown can't steal focus and
        // instantly dismiss the popup. openPopup() needs no user gesture in
        // Chrome, but it rejects if the window isn't focused. We wait for the
        // panel to finish closing, re-focus the window, then open once.
        const windowId = msg.windowId;
        // Reply immediately so the panel's await resolves and it can close.
        sendResponse({ ok: true });
        openActionPopupSoon(windowId);
        break;
      }
        
      default:
        sendResponse({ ok: false, error: "unknown-action" });
    }
  })();
  return true;
});

async function triggerReconcile() {
  const tab = await findInstagramTab();
  if (!tab) return { ok: false, reason: "no-ig-tab" };
  
  // Any live runner or non-terminal job (running / waiting-on-backoff / paused)
  // means we're busy — never overwrite the user's in-flight job.
  const existing = await getJob();
  if (activeRunner || (existing && !TERMINAL_STATUSES.has(existing.status))) {
    return { ok: false, reason: "busy" };
  }
  if (await outsideActiveHours()) return { ok: false, reason: "inactive-hours" };
  
  try {
    const accountInfo = await sendCommand(tab.id, "getAccountInfo");
    if (!accountInfo.username) {
      return { ok: false, reason: "no-account" };
    }
    
    const settings = await Store.getSettings();
    const job = {
      id: `${Date.now()}`,
      type: "reconcile",
      param: {},
      status: "running",
      progress: { followed: 0, unfollowed: 0, preview: 0 },
      startedAt: Date.now(),
      accountId: accountInfo.accountId,
      username: accountInfo.username,
      dryRun: settings.dryRun,
    };
    
    await saveJob(job);
    activeRunner = new JobRunner(job, tab.id);
    activeRunner.run();
    
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return { ok: false, reason: "content-not-ready", error: e.message };
  }
}

async function triggerCleanup() {
  const tab = await findInstagramTab();
  if (!tab) return { ok: false, reason: "no-ig-tab" };
  
  // Any live runner or non-terminal job means we're busy — don't clobber it.
  const existing = await getJob();
  if (activeRunner || (existing && !TERMINAL_STATUSES.has(existing.status))) {
    return { ok: false, reason: "busy" };
  }
  if (await outsideActiveHours()) return { ok: false, reason: "inactive-hours" };
  
  try {
    const accountInfo = await sendCommand(tab.id, "getAccountInfo");
    if (!accountInfo.username) {
      return { ok: false, reason: "no-account" };
    }
    
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const toUnfollow = await Store.getNonFollowers(accountInfo.accountId, threeDaysAgo);
    
    if (toUnfollow.length === 0) {
      return { ok: true, reason: "none-to-unfollow", count: 0 };
    }
    
    const settings = await Store.getSettings();
    const job = {
      id: `${Date.now()}`,
      type: "unfollowNonFollowers",
      param: {},
      status: "running",
      progress: { unfollowed: 0, toUnfollow: toUnfollow.length },
      startedAt: Date.now(),
      accountId: accountInfo.accountId,
      username: accountInfo.username,
      dryRun: settings.dryRun,
    };
    
    await saveJob(job);
    activeRunner = new JobRunner(job, tab.id);
    activeRunner.run();
    
    return { ok: true, tabId: tab.id, toUnfollow: toUnfollow.length };
  } catch (e) {
    return { ok: false, reason: "error", error: e.message };
  }
}

// Alarm handlers
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    // Keeps the worker warm and resumes any interrupted job.
    await resumeJobIfNeeded();
    return;
  }
  
  if (alarm.name === RECONCILE_ALARM) {
    const s = await Store.getSettings();
    if (!s.reconcileEnabled) return;
    // Keep the pre-action jitter short: an MV3 service worker can be torn down
    // during long awaits, which would silently skip the run. Timing spread is
    // already provided by the per-interval jitter in scheduleReconcile().
    await sleep(rand(0, 5) * 1000);
    await triggerReconcile();
    await scheduleReconcile();
  }
  
  if (alarm.name === CLEANUP_ALARM) {
    const s = await Store.getSettings();
    if (s.cleanupEnabled === false) return;
    await sleep(rand(0, 10) * 1000);
    await triggerCleanup();
    await scheduleCleanup();
  }
});

chrome.cookies.onChanged.addListener(async (info) => {
  if (!info?.cookie || info.cookie.name !== "ds_user_id" || info.removed) return;
  await Store.ensureAccount(info.cookie.value, null);
});

// The UI can live either as a full-height docked side panel or as the classic
// transient toolbar popup. Both surfaces render popup.html; we just flip which
// one the toolbar icon opens. Persisted in storage so it survives restarts.
async function applyDisplayMode(mode) {
  const m = mode === "popup" ? "popup" : "sidepanel";
  // Firefox has no chrome.sidePanel and doesn't rebind the toolbar icon; the
  // sidebar/popup switch happens directly in the UI via sidebarAction there.
  if (!chrome.sidePanel || !chrome.action || !chrome.action.setPopup) return m;
  try {
    if (m === "popup") {
      // Icon click opens the standard anchored popup (Chrome docks it under the
      // toolbar icon with native rounded corners + spacing). The ctx flag lets
      // popup.html pin a fixed width; the side panel loads the plain path.
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: "popup.html?ctx=popup" });
    } else {
      await chrome.action.setPopup({ popup: "" });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (_) {}
  return m;
}

// Opens the toolbar action popup once the side panel has finished closing. The
// delay matters: opening too early (while the panel is still tearing down)
// dismisses the popup as focus shifts back to the page. openPopup() also rejects
// unless the target window is focused, so we assert focus first.
async function openActionPopupSoon(windowId) {
  // Firefox: close the sidebar first (openPopup rejects while a panel is open),
  // then open the popup. Done from the background because the sidebar page can't
  // close itself and still open the popup afterwards.
  if (typeof browser !== "undefined" && browser.sidebarAction) {
    try { await browser.sidebarAction.close(); } catch (_) {}
    try { await browser.action.openPopup(); } catch (e) {
      console.warn("[IG Auto] openPopup (firefox) failed:", e && e.message);
    }
    return;
  }
  if (!chrome.action || !chrome.action.openPopup) return;
  await sleep(300);
  try {
    if (windowId != null) {
      try { await chrome.windows.update(windowId, { focused: true }); } catch (_) {}
      await chrome.action.openPopup({ windowId });
    } else {
      await chrome.action.openPopup();
    }
  } catch (e) {
    console.warn("[IG Auto] openActionPopup failed:", e && e.message);
  }
}

async function getStoredDisplayMode() {
  try {
    const { displayMode } = await chrome.storage.local.get("displayMode");
    return displayMode === "popup" ? "popup" : "sidepanel";
  } catch (_) {
    return "sidepanel";
  }
}

// The UI defaults to the docked side panel on first install, and re-defaults to
// it periodically (every DISPLAY_MODE_RESET_MS) so the side panel stays the
// primary surface even if the user occasionally pops out to a window.
const DISPLAY_MODE_RESET_MS = 7 * 24 * 60 * 60 * 1000;

async function resolveDisplayModeWithReset() {
  try {
    const { displayMode, displayModeResetAt } = await chrome.storage.local.get([
      "displayMode",
      "displayModeResetAt",
    ]);
    const now = Date.now();
    const firstRun = !displayModeResetAt;
    const dueForReset = displayModeResetAt && now - displayModeResetAt >= DISPLAY_MODE_RESET_MS;
    if (firstRun || dueForReset || displayMode == null) {
      await chrome.storage.local.set({ displayMode: "sidepanel", displayModeResetAt: now });
      return "sidepanel";
    }
    return displayMode === "popup" ? "popup" : "sidepanel";
  } catch (_) {
    return "sidepanel";
  }
}

async function initDisplayMode() {
  await applyDisplayMode(await resolveDisplayModeWithReset());
}

chrome.runtime.onInstalled.addListener(() => {
  initDisplayMode();
  scheduleReconcile();
  scheduleCleanup();
  resumeJobIfNeeded();
});

chrome.runtime.onStartup.addListener(() => {
  initDisplayMode();
  scheduleReconcile();
  scheduleCleanup();
  resumeJobIfNeeded();
});

initDisplayMode();

// The heartbeat alarm persists across service-worker restarts, so if the worker
// is torn down mid-job it will be woken within ~30s and resume via onAlarm.
// Nudge a resume check on cold spin-up too (guarded against races below).
resumeJobIfNeeded();