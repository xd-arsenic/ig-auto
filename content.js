(function() {
  "use strict";
  
  const FOLLOW_LABELS = new Set(["follow", "follow back"]);
  const FOLLOWING_LABELS = new Set(["following", "requested"]);
  
  // ---- Utilities -----------------------------------------------------------
  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
  
  // ---- DOM Helpers -------------------------------------------------------
  function getAccountInfo() {
    const m = document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)/);
    const accountId = m ? m[1] : null;
    
    let username = null;
    const imgs = document.querySelectorAll('img[alt*="profile picture" i]');
    for (const img of imgs) {
      const a = img.closest('a[href^="/"]');
      if (a) {
        const href = a.getAttribute("href");
        const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
        if (match) {
          username = match[1].toLowerCase();
          break;
        }
      }
    }
    
    return { accountId, username };
  }
  
  function getUrl() {
    return location.href;
  }
  
  const RESERVED_PATHS = new Set([
    "p", "reel", "reels", "tv", "explore", "stories", "direct", "accounts",
  ]);
  
  // The profile whose page we're currently on, or null if this isn't a profile.
  function currentProfileUsername() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (!m || RESERVED_PATHS.has(m[1].toLowerCase())) return null;
    return m[1].toLowerCase();
  }
  
  // Parse counts like "1,234", "1.2k", "3.4M" into an integer.
  function parseCount(str) {
    if (str == null) return null;
    const s = String(str).trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
    if (!s) return null;
    const m = s.match(/^([\d.]+)([kmb])?$/);
    if (!m) {
      const digits = s.replace(/[^\d]/g, "");
      return digits ? parseInt(digits, 10) : null;
    }
    let n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
    return Math.round(n * mult);
  }
  
  // Prefer the exact number in a title attribute; fall back to visible text.
  function countFromAnchor(anchor) {
    if (!anchor) return null;
    const titled = anchor.querySelector("[title]");
    const title = titled && titled.getAttribute("title");
    if (title) {
      const n = parseCount(title);
      if (n != null) return n;
    }
    const txt = (anchor.textContent || "").replace(/followers?|following/gi, "");
    return parseCount(txt);
  }
  
  // Scrape the real follower/following/posts counts from a profile header.
  // Only meaningful when we're on the logged-in user's own profile.
  function getProfileStats() {
    const acc = getAccountInfo();
    const me = acc.username;
    const profile = currentProfileUsername();
    const onOwnProfile = !!(me && profile && me === profile);
    
    const scope = document.querySelector("header") || document.body;
    const stats = { followers: null, following: null, posts: null };
    
    stats.followers = countFromAnchor(scope.querySelector('a[href$="/followers/"]'));
    stats.following = countFromAnchor(scope.querySelector('a[href$="/following/"]'));
    
    // Posts count (and any missing follower/following) via labelled text.
    const candidates = scope.querySelectorAll("li, div, span, a, button");
    for (const el of candidates) {
      const t = (el.textContent || "").trim().toLowerCase();
      let m;
      if (stats.posts == null && (m = t.match(/^([\d.,]+\s*[kmb]?)\s*posts?$/))) {
        stats.posts = parseCount(m[1]);
      } else if (stats.followers == null && (m = t.match(/^([\d.,]+\s*[kmb]?)\s*followers?$/))) {
        stats.followers = parseCount(m[1]);
      } else if (stats.following == null && (m = t.match(/^([\d.,]+\s*[kmb]?)\s*following$/))) {
        stats.following = parseCount(m[1]);
      }
    }
    
    const hasAny =
      stats.followers != null || stats.following != null || stats.posts != null;
    
    return {
      accountId: acc.accountId,
      username: me,
      profile,
      onOwnProfile,
      stats: hasAny ? stats : null,
    };
  }
  
  function getScrollContainer() {
    const divs = document.querySelectorAll("div");
    let best = null;
    let bestHeight = 0;
    
    for (const el of divs) {
      const style = getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && 
          el.scrollHeight > el.clientHeight) {
        if (el.clientHeight > bestHeight) {
          bestHeight = el.clientHeight;
          best = el;
        }
      }
    }
    
    return best || document.scrollingElement;
  }
  
  // Resolve the element we actually scroll and whether it's the page/window.
  function scrollTargetEls() {
    const container = getScrollContainer();
    const usesWindow =
      container === document.scrollingElement ||
      container === document.documentElement ||
      !container;
    const scrollEl = usesWindow
      ? document.scrollingElement || document.documentElement
      : container;
    return { container, usesWindow, scrollEl };
  }
  
  function isAtBottom() {
    const { usesWindow, scrollEl } = scrollTargetEls();
    const viewport = usesWindow ? window.innerHeight : scrollEl.clientHeight;
    return scrollEl.scrollTop + viewport >= scrollEl.scrollHeight - 20;
  }
  
  // Resolve the username associated with an action button by walking up the DOM
  // and looking for the profile anchor in the same row. Returns null if none.
  function usernameForButton(btn) {
    let node = btn;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const a = node.querySelector('a[href^="/"]');
      if (a) {
        const href = a.getAttribute("href");
        const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
        if (match) return match[1].toLowerCase();
      }
    }
    return null;
  }
  
  // Walk up from an action button to the row container that holds the profile
  // link (used to read row-level metadata like the verified badge).
  function rowContainerForButton(btn) {
    let node = btn;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const a = node.querySelector('a[href^="/"]');
      if (a) {
        const href = a.getAttribute("href") || "";
        if (/^\/([A-Za-z0-9._]+)\/?$/.test(href)) return node;
      }
    }
    return null;
  }

  function isVerifiedIn(scope) {
    if (!scope) return false;
    return !!scope.querySelector('svg[aria-label="Verified" i], [title="Verified" i]');
  }

  function readRows() {
    const rows = [];
    const seen = new Set();
    const buttons = document.querySelectorAll('button, [role="button"]');
    
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (!FOLLOW_LABELS.has(text) && !FOLLOWING_LABELS.has(text)) continue;
      
      const username = usernameForButton(btn);
      if (!username || seen.has(username)) continue;
      seen.add(username);
      
      const container = rowContainerForButton(btn);
      rows.push({
        username,
        label: text,
        buttonText: btn.textContent,
        verified: isVerifiedIn(container),
      });
    }
    
    return rows;
  }
  
  // Re-find a row's action button at click time (avoids stale selectors as the
  // list re-renders/scrolls). Returns the button element or null.
  function findUserButton(username) {
    const target = String(username || "").toLowerCase();
    if (!target) return null;
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (!FOLLOW_LABELS.has(text) && !FOLLOWING_LABELS.has(text)) continue;
      if (usernameForButton(btn) === target) return btn;
    }
    return null;
  }
  
  // ---- Human-like Interactions ---------------------------------------------
  async function dispatchClickEl(el) {
    if (!el) return false;
    
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) {
      el.click();
      return true;
    }
    
    const cx = box.left + box.width / 2 + rand(-8, 8);
    const cy = box.top + box.height / 2 + rand(-8, 8);
    
    // Mouse move (sometimes)
    if (Math.random() < 0.4) {
      el.dispatchEvent(new MouseEvent('mousemove', { 
        bubbles: true, cancelable: true,
        clientX: cx + rand(-10, 10), 
        clientY: cy + rand(-10, 10)
      }));
      await sleep(rand(40, 120));
    }
    
    // Click sequence
    el.dispatchEvent(new MouseEvent('mousedown', { 
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, button: 0 
    }));
    await sleep(rand(60, 180));
    
    el.dispatchEvent(new MouseEvent('mouseup', { 
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, button: 0 
    }));
    await sleep(rand(30, 90));
    
    el.dispatchEvent(new MouseEvent('click', { 
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, button: 0 
    }));
    
    return true;
  }
  
  async function clickUser(args) {
    const btn = findUserButton(args && args.username);
    if (!btn) return false;
    return dispatchClickEl(btn);
  }
  
  // Real, human-ish scrolling. `amount` may be negative to scroll up. We fire a
  // genuine wheel event (so the site's own scroll / infinite-load handlers react
  // like they would for a real gesture) and then move the scroll position in a
  // few eased sub-steps to imitate momentum rather than teleporting.
  async function scroll(args) {
    const amount = Math.trunc(Number(args && args.amount) || 0);
    if (!amount) return { moved: 0, atBottom: isAtBottom() };
    
    const { container, usesWindow, scrollEl } = scrollTargetEls();
    
    try {
      const rect = usesWindow
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : container.getBoundingClientRect();
      const cx = rect.left + rect.width / 2 + rand(-20, 20);
      const cy = rect.top + rect.height / 2 + rand(-20, 20);
      const evtTarget = usesWindow
        ? document.scrollingElement || document.body
        : container;
      evtTarget.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 0,
          deltaY: amount,
          deltaMode: 0,
          clientX: cx,
          clientY: cy,
        })
      );
    } catch (_) {
      /* wheel dispatch is best-effort */
    }
    
    const steps = rand(3, 6);
    let moved = 0;
    let remaining = amount;
    for (let i = 0; i < steps; i++) {
      const isLast = i === steps - 1;
      const delta = isLast ? remaining : Math.round(amount / steps + rand(-6, 6));
      remaining -= delta;
      if (usesWindow) {
        window.scrollBy(0, delta);
      } else {
        scrollEl.scrollTop += delta;
      }
      moved += delta;
      await sleep(rand(10, 32));
    }
    
    return { moved, atBottom: isAtBottom(), scrollTop: Math.round(scrollEl.scrollTop) };
  }
  
  async function clickUnfollow() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const confirm = dialogs[dialogs.length - 1];
    if (!confirm) return false;
    
    const buttons = confirm.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (text === "unfollow") {
        await dispatchClickEl(btn);
        return true;
      }
    }
    return false;
  }
  
  // ---- Post browsing primitives --------------------------------------------
  // Best-effort like count from a post page ("N likes" or "… and N others").
  function detectLikeCount() {
    const scope = document.querySelector("article") || document.body;
    const els = scope.querySelectorAll("span, a, div");
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (!t || t.length > 48) continue;
      let m = t.match(/^([\d.,]+\s*[kmb]?)\s*likes$/i);
      if (m) return parseCount(m[1]);
      m = t.match(/\band\s+([\d.,]+\s*[kmb]?)\s+others?\b/i);
      if (m) return parseCount(m[1]);
    }
    return null;
  }
  
  // Comment/reply "like" heart buttons. Comment hearts are small (<=20px);
  // the main post like button is 24px, so a height filter separates them.
  function commentLikeButtons() {
    const out = [];
    const svgs = document.querySelectorAll('svg[aria-label="Like"], svg[aria-label="Unlike"]');
    for (const svg of svgs) {
      const h = parseInt(svg.getAttribute("height") || "0", 10);
      if (!h || h > 20) continue;
      const btn =
        svg.closest('[role="button"]') || svg.closest("button") || svg.parentElement;
      if (btn) out.push(btn);
    }
    return out;
  }
  
  // Resolve the commenter's username for a given comment like-button by walking
  // up to the tightest ancestor that contains a profile link.
  function usernameForCommentButton(btn) {
    let node = btn;
    for (let i = 0; i < 14 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const anchors = node.querySelectorAll('a[href^="/"]');
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/([A-Za-z0-9._]+)\/$/);
        if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
          return m[1].toLowerCase();
        }
      }
    }
    return null;
  }
  
  // List of comments as { index, username } where index maps to commentLikeButtons().
  function getComments() {
    return commentLikeButtons().map((btn, index) => ({
      index,
      username: usernameForCommentButton(btn),
    }));
  }
  
  function getPostStats() {
    const hasNext = !!document.querySelector('[aria-label="Next"]');
    const hasPrev = !!document.querySelector('[aria-label="Go back"]');
    return {
      likeCount: detectLikeCount(),
      commentLikeCount: commentLikeButtons().length,
      isCarousel: hasNext || hasPrev,
      hasNext,
      hasPrev,
    };
  }
  
  async function carousel(args) {
    const dir = args && args.dir === "prev" ? "prev" : "next";
    const label = dir === "next" ? "Next" : "Go back";
    const node = document.querySelector(`[aria-label="${label}"]`);
    if (!node) return false;
    const clickable = node.closest('button, [role="button"]') || node;
    return dispatchClickEl(clickable);
  }
  
  async function likeComment(args) {
    const index = Number(args && args.index) || 0;
    const btns = commentLikeButtons();
    const el = btns[index];
    if (!el) return false;
    // Don't toggle off a comment that's already liked.
    const svg = el.querySelector("svg[aria-label]");
    if (svg && svg.getAttribute("aria-label") === "Unlike") return false;
    return dispatchClickEl(el);
  }
  
  // Click the Follow button in a profile header. Returns whether it followed
  // (vs. already following / not found).
  async function clickProfileFollow() {
    const header = document.querySelector("header") || document.body;
    const buttons = header.querySelectorAll('button, [role="button"]');
    for (const b of buttons) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t === "follow" || t === "follow back") {
        const ok = await dispatchClickEl(b);
        return { followed: !!ok };
      }
      if (t === "following" || t === "requested") {
        return { followed: false, already: true };
      }
    }
    return { followed: false };
  }
  
  // Post/reel permalinks from a profile grid, as path strings.
  function getProfilePosts() {
    const out = [];
    const seen = new Set();
    const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/[A-Za-z0-9._]+\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/);
      if (m) {
        const path = m[0].endsWith("/") ? m[0] : m[0] + "/";
        if (!seen.has(path)) {
          seen.add(path);
          out.push(path);
        }
      }
    }
    return out;
  }
  
  // Like the main post (action-bar) on a post/reel page. 24px heart = main like.
  async function likePost() {
    const svgs = document.querySelectorAll('svg[aria-label="Like"]');
    for (const svg of svgs) {
      const h = parseInt(svg.getAttribute("height") || "0", 10);
      if (h >= 22) {
        const btn =
          svg.closest('[role="button"]') || svg.closest("button") || svg.parentElement;
        const ok = await dispatchClickEl(btn);
        return { liked: !!ok };
      }
    }
    if (document.querySelector('svg[aria-label="Unlike"][height="24"]')) {
      return { liked: false, already: true };
    }
    return { liked: false };
  }
  
  // ---- Action-block detection ----------------------------------------------
  // Phrases Instagram shows when it temporarily blocks an action (follow/like).
  const BLOCK_PHRASES = [
    "action blocked",
    "try again later",
    "we restrict certain activity",
    "we limit how often",
    "temporarily blocked",
    "you can’t do this right now",
    "you can't do this right now",
    "please wait a few minutes",
    "couldn’t follow",
    "couldn't follow",
    "limit reached",
  ];
  
  function textHasBlock(text) {
    const t = (text || "").toLowerCase();
    return BLOCK_PHRASES.some((p) => t.includes(p));
  }
  
  // Detect whether a "temporarily blocked / try again later" notice is on screen.
  function detectActionBlock() {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const d of dialogs) {
      if (textHasBlock(d.textContent)) {
        return { blocked: true, message: (d.textContent || "").trim().slice(0, 140) };
      }
    }
    // Some blocks render as a toast rather than a dialog. Only trust very
    // specific phrases at document scope to avoid false positives.
    const body = document.body ? document.body.innerText || "" : "";
    const lt = body.toLowerCase();
    for (const p of ["action blocked", "try again later", "we restrict certain activity"]) {
      if (lt.includes(p)) return { blocked: true, message: p };
    }
    return { blocked: false };
  }
  
  // Close the topmost dialog (e.g. dismiss a block notice) via a safe button or Escape.
  async function dismissDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    const dlg = dialogs[dialogs.length - 1];
    if (dlg) {
      const prefs = ["ok", "dismiss", "not now", "close", "cancel"];
      const btns = dlg.querySelectorAll('button, [role="button"]');
      for (const p of prefs) {
        for (const b of btns) {
          if ((b.textContent || "").trim().toLowerCase() === p) {
            await dispatchClickEl(b);
            return true;
          }
        }
      }
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })
    );
    return true;
  }
  
  // Current label of a user's action button in a list ("follow"/"following"/…), or null.
  function getUserButtonLabel(args) {
    const btn = findUserButton(args && args.username);
    if (!btn) return null;
    return (btn.textContent || "").trim().toLowerCase();
  }
  
  // Metadata about the profile currently open (any profile, not just our own):
  // privacy, verified badge, and follower/following/posts counts. Used by the
  // skip-filters when vetting a candidate before following.
  function getProfileMeta() {
    const bodyText = (document.body && document.body.innerText) || "";
    const isPrivate = /this account is private/i.test(bodyText);
    const header = document.querySelector("header") || document.body;
    const isVerified = isVerifiedIn(header);
    const stats = (getProfileStats().stats) || {};
    return {
      username: currentProfileUsername(),
      isPrivate,
      isVerified,
      followers: stats.followers ?? null,
      following: stats.following ?? null,
      posts: stats.posts ?? null,
    };
  }

  // Current follow state from a profile header: "following"/"requested"/"follow"/null.
  function getProfileFollowState() {
    const header = document.querySelector("header") || document.body;
    const buttons = Array.from(header.querySelectorAll('button, [role="button"]'));
    // Prefer the "already following" states if present.
    for (const b of buttons) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t === "following" || t === "requested") return t;
    }
    for (const b of buttons) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t === "follow" || t === "follow back") return t;
    }
    return null;
  }
  
  // ---- Command Router ------------------------------------------------------
  const commands = {
    getAccountInfo,
    getProfileStats,
    getUrl,
    isAtBottom,
    readRows,
    clickUser,
    scroll,
    clickUnfollow,
    getPostStats,
    getComments,
    carousel,
    likeComment,
    clickProfileFollow,
    getProfilePosts,
    likePost,
    detectActionBlock,
    dismissDialog,
    getUserButtonLabel,
    getProfileFollowState,
    getProfileMeta,
  };
  
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.action === "ping") {
        sendResponse({ ok: true });
        return;
      }
      
      if (msg.action !== "execute") {
        sendResponse({ ok: false, error: "unknown-action" });
        return;
      }
      
      const handler = commands[msg.command];
      if (!handler) {
        sendResponse({ ok: false, error: `unknown-command: ${msg.command}` });
        return;
      }
      
      try {
        const result = await handler(msg.args);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });
  
})();