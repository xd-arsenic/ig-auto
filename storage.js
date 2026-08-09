/*
 * Shared, account-namespaced storage helpers.
 * Loaded both as a content script (before content.js) and via importScripts()
 * in the background service worker, so everything hangs off the global `self`.
 */
(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    humanLevel: 50,              // backs the Simple-mode slider (popup only)
    minDelayMs: 3000,
    maxDelayMs: 8000,
    sessionCap: 100,
    reconcileEnabled: true,
    reconcileIntervalMin: 15,
    dryRun: false,
    cleanupEnabled: true,        // NEW: Enable 3-day cleanup by default
    cleanupIntervalMin: 60 * 24, // NEW: Daily (in minutes)
    // Humanization (opt-in; increases realism but makes runs much slower)
    browsePosts: false,          // Open + scroll through a post before following its likers
    likeComments: false,         // Occasionally like a comment on the post
    randomization: 40,           // 0-100: scales dwell times, swipes, and like odds
    flockPriority: false,        // Prioritize commenters whose username matches a keyword
    flockKeyword: "flock",       // The keyword to match in commenter usernames
    likeOnFollow: false,         // After following someone, sometimes like a recent post
    // Active hours: only act during this local-time window (wraps midnight).
    activeHoursEnabled: false,
    activeStartHour: 8,          // 0-23
    activeEndHour: 23,           // 0-23
    dailyBudget: 180,            // Max follows per calendar day (0 = unlimited)
    // Fatigue: work in bursts with longer breaks, slowing as a session drags on.
    fatigueEnabled: false,
    // Skip filters
    blacklist: "",               // Never follow these usernames (comma/space/newline)
    protectList: "",             // Never unfollow these usernames
    skipVerified: false,         // Skip verified (blue-check) accounts
    skipPrivate: false,          // Skip private accounts (needs a profile visit)
    minFollowers: 0,             // Skip accounts below this follower count (0 = off)
    maxFollowers: 0,             // Skip accounts above this follower count (0 = off)
    vetAllProfiles: false,       // Visit every candidate's profile to apply the
                                 // private/follower filters (thorough but slow)
  };

  function area() {
    return chrome.storage.local;
  }

  async function get(keys) {
    return area().get(keys);
  }

  async function set(obj) {
    return area().set(obj);
  }

  // Serialize read-modify-write operations so concurrent callers (e.g. a running
  // job following users while the cookie listener calls ensureAccount) can't
  // clobber each other's updates. All account/settings mutators run through this.
  let _writeChain = Promise.resolve();
  function withLock(fn) {
    const run = _writeChain.then(fn, fn);
    // Keep the chain alive even if a step rejects.
    _writeChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async function getSettings() {
    const { settings } = await get("settings");
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  async function setSettings(partial) {
    return withLock(async () => {
      const current = await getSettings();
      const next = Object.assign({}, current, partial || {});
      await set({ settings: next });
      return next;
    });
  }

  async function getAllAccounts() {
    const { accounts } = await get("accounts");
    return accounts || {};
  }

  async function getActiveAccountId() {
    const { activeAccountId } = await get("activeAccountId");
    return activeAccountId || null;
  }

  async function setActiveAccountId(accountId) {
    await set({ activeAccountId: accountId });
  }

  async function ensureAccount(accountId, username) {
    if (!accountId) return null;
    return withLock(async () => {
      const accounts = await getAllAccounts();
      if (!accounts[accountId]) {
        accounts[accountId] = { username: username || null, tracked: {} };
      } else if (username && accounts[accountId].username !== username) {
        accounts[accountId].username = username;
      }
      if (!accounts[accountId].tracked) accounts[accountId].tracked = {};
      await set({ accounts });
      await setActiveAccountId(accountId);
      return accounts[accountId];
    });
  }

  async function getAccount(accountId) {
    const accounts = await getAllAccounts();
    return accounts[accountId] || null;
  }

  // Cache the account's real (site-reported) follower/following/posts counts.
  async function setProfileStats(accountId, stats) {
    if (!accountId || !stats) return null;
    return withLock(async () => {
      const accounts = await getAllAccounts();
      if (!accounts[accountId]) {
        accounts[accountId] = { username: null, tracked: {} };
      }
      accounts[accountId].profile = {
        followers: stats.followers ?? null,
        following: stats.following ?? null,
        posts: stats.posts ?? null,
        updatedAt: Date.now(),
      };
      await set({ accounts });
      return accounts[accountId].profile;
    });
  }

  async function getProfileStats(accountId) {
    const acct = await getAccount(accountId);
    return (acct && acct.profile) || null;
  }

  // Normalize a username/target key (strip @, slashes, lowercase).
  function normTarget(target) {
    return String(target || "")
      .trim()
      .replace(/^@/, "")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
  }

  async function addTracked(accountId, target, source) {
    const key = normTarget(target);
    if (!accountId || !key) return null;
    return withLock(async () => {
      const accounts = await getAllAccounts();
      if (!accounts[accountId]) {
        accounts[accountId] = { username: null, tracked: {} };
      }
      const tracked = accounts[accountId].tracked || (accounts[accountId].tracked = {});
      // Don't clobber an already-tracked user's original record.
      if (!tracked[key]) {
        tracked[key] = {
          followedAt: Date.now(),
          source: source || null,
          status: "following",
        };
      }
      await set({ accounts });
      return tracked[key];
    });
  }

  async function markUnfollowed(accountId, target, reason) {
    const key = normTarget(target);
    if (!accountId || !key) return;
    return withLock(async () => {
      const accounts = await getAllAccounts();
      const acct = accounts[accountId];
      if (!acct || !acct.tracked || !acct.tracked[key]) return;
      acct.tracked[key].status = "unfollowed";
      acct.tracked[key].unfollowedAt = Date.now();
      // reason: "followed-back" (reconcile) | "no-follow-back" (cleanup)
      if (reason) acct.tracked[key].reason = reason;
      await set({ accounts });
    });
  }

  // ---- Daily action counters (for the rolling daily budget + analytics) ----
  function dayKey(ts) {
    const d = new Date(ts ?? Date.now());
    // Local-time YYYY-MM-DD.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Record a follow: bump today's count AND append a timestamp to the rolling
  // recent-follows list (used for the hourly rate cap). Persisted so both limits
  // survive a service-worker restart.
  async function incDaily(accountId, n = 1) {
    if (!accountId) return;
    return withLock(async () => {
      const accounts = await getAllAccounts();
      if (!accounts[accountId]) accounts[accountId] = { username: null, tracked: {} };
      const acct = accounts[accountId];
      const daily = acct.daily || (acct.daily = {});
      const k = dayKey();
      daily[k] = (daily[k] || 0) + n;
      // Keep ~60 days of history.
      const keys = Object.keys(daily).sort();
      while (keys.length > 60) delete daily[keys.shift()];

      // Rolling timestamps, pruned to the last hour (cap length for safety).
      const now = Date.now();
      const cutoff = now - 60 * 60 * 1000;
      let recent = (acct.recentFollows || []).filter((t) => t > cutoff);
      for (let i = 0; i < n; i++) recent.push(now);
      if (recent.length > 200) recent = recent.slice(-200);
      acct.recentFollows = recent;

      await set({ accounts });
      return daily[k];
    });
  }

  async function getTodayCount(accountId) {
    const acct = await getAccount(accountId);
    if (!acct || !acct.daily) return 0;
    return acct.daily[dayKey()] || 0;
  }

  // Timestamps of follows within the last `windowMs` (default 1h), oldest first.
  async function getRecentFollows(accountId, windowMs = 60 * 60 * 1000) {
    const acct = await getAccount(accountId);
    if (!acct || !acct.recentFollows) return [];
    const cutoff = Date.now() - windowMs;
    return acct.recentFollows.filter((t) => t > cutoff).sort((a, b) => a - b);
  }

  // Follows-per-day series + follow-back analytics.
  async function getAnalytics(accountId, days = 14) {
    const acct = await getAccount(accountId);
    const daily = (acct && acct.daily) || {};
    const perDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(Date.now() - i * 24 * 60 * 60 * 1000);
      perDay.push({ date: k, count: daily[k] || 0 });
    }

    const tracked = (acct && acct.tracked) || {};
    const vals = Object.values(tracked);
    const following = vals.filter((v) => v.status === "following").length;
    const followedBack = vals.filter((v) => v.reason === "followed-back").length;
    const noFollowBack = vals.filter((v) => v.reason === "no-follow-back").length;
    const decided = followedBack + noFollowBack;
    const rate = decided > 0 ? followedBack / decided : null;

    return {
      perDay,
      following,
      followedBack,
      noFollowBack,
      decided,
      rate,
      totalFollowed: vals.length,
    };
  }

  // All targets we're still actively following (candidates for reconcile).
  async function getTrackedFollowing(accountId) {
    const acct = await getAccount(accountId);
    if (!acct || !acct.tracked) return [];
    return Object.keys(acct.tracked).filter(
      (k) => acct.tracked[k].status === "following"
    );
  }

  // NEW: Get non-followers who haven't followed back after threshold time
  async function getNonFollowers(accountId, olderThanTimestamp) {
    const acct = await getAccount(accountId);
    if (!acct || !acct.tracked) return [];
    
    const nonFollowers = [];
    
    for (const [username, data] of Object.entries(acct.tracked)) {
      // Must be: following them, they didn't follow back, and older than threshold
      if (data.status === "following" && 
          data.followedAt && 
          data.followedAt < olderThanTimestamp &&
          !data.unfollowedAt) {
        nonFollowers.push({ username, ...data });
      }
    }
    
    // Sort by oldest first (so we unfollow oldest first)
    return nonFollowers.sort((a, b) => a.followedAt - b.followedAt);
  }

  // NEW: Get count of pending non-followers (for UI display)
  async function getNonFollowerCount(accountId) {
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const nonFollowers = await getNonFollowers(accountId, threeDaysAgo);
    return nonFollowers.length;
  }

  async function getStats(accountId) {
    const acct = await getAccount(accountId);
    if (!acct || !acct.tracked) return { following: 0, unfollowed: 0, total: 0 };
    const vals = Object.values(acct.tracked);
    const following = vals.filter((v) => v.status === "following").length;
    const unfollowed = vals.filter((v) => v.status === "unfollowed").length;
    return { following, unfollowed, total: vals.length };
  }

  // NEW: Extended stats including non-follower count
  async function getExtendedStats(accountId) {
    const stats = await getStats(accountId);
    const nonFollowerCount = await getNonFollowerCount(accountId);
    return { ...stats, nonFollowers: nonFollowerCount };
  }

  self.IGStore = {
    DEFAULT_SETTINGS,
    getSettings,
    setSettings,
    getAllAccounts,
    getActiveAccountId,
    setActiveAccountId,
    ensureAccount,
    getAccount,
    setProfileStats,
    getProfileStats,
    addTracked,
    markUnfollowed,
    getTrackedFollowing,
    getNonFollowers,        // NEW
    getNonFollowerCount,    // NEW
    getStats,
    getExtendedStats,       // NEW
    incDaily,
    getTodayCount,
    getRecentFollows,
    getAnalytics,
    normTarget,
  };
})();