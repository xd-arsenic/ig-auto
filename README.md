# IG Auto

> Built strictly for educational, testing, and research use in a local sandbox or mock environment. **Do not use it on the live Instagram platform.**
>
> Automating the real Instagram website violates [Instagram's Terms of Service](https://help.instagram.com/581066165581870/) and can get your account suspended or banned. Use at your own risk; the author takes no responsibility for bans, data loss, or other consequences of misuse.

## Preview

Support for:

- Chrome side panel
- Firefox sidebar
- Toolbar popup (Chrome and Firefox)

**Chrome side panel:**

![IG Auto as a full-height side panel on the right in Chrome](preview_full.png)

**Firefox sidebar:**

![IG Auto in the Firefox sidebar on the left](firefox_preview.png)

**Chrome popup:**

![IG Auto as a popup under the Chrome toolbar icon](preview_full_2.png)

## Features

- Follow an account's followers or a post's likers.
- Track follows per account and auto-unfollow people who follow back, or who don't.
- Data is namespaced by logged-in account (`ds_user_id`), so switching users switches the tracked data.
- Pacing controls: randomized delays, session/daily/hourly caps, active hours, and action-block backoff. Pause, resume, and stop anytime.

## Install (load unpacked)

### Chrome (114+)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open your Instagram-clone tab and click the extension icon.

### Firefox (128+)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.
3. Open your Instagram-clone tab; open the sidebar (or click the toolbar icon for the popup).

The manifest works in both browsers. Each shows an install warning for the other browser's keys; both are harmless and ignored. If an Instagram tab was open before you loaded the extension, refresh it so the content script injects.

### Display modes

- **Chrome**: opens as a side panel by default, and resets to the side panel every 7 days. The header button toggles between the side panel and the toolbar popup.
- **Firefox**: uses the native sidebar (open it from the toolbar) and the toolbar popup. The header toggle is hidden because Firefox can't rebind the toolbar icon.

## Usage

Two modes, toggled at the top:

- **Simple** — one Human-likeness slider (Fast → Stealth) sets every humanization option. The card shows what the current level does (delay range, post browsing, breaks, waking hours).
- **Advanced** — all settings exposed individually. Adjust and press *Save advanced settings*.

### One input for everything

Paste into the **"What should I run on?"** box, one per line:

- usernames, `@handles`, or profile links → follows that account's **followers**
- post links or shortcodes → follows that post's **likers**

Accounts and posts can be mixed. Each line is classified live (e.g. *2 accounts · 1 post · 3 in queue*), and the batch runs as one queue that advances automatically under a single session cap. When you're viewing a profile or post, a suggestion to add it appears at the top.

- **Preview only (dry run)** — toggle on the run card; logs every action it *would* take without following anyone (stops at the normal session cap).
- **Maintenance tools** — *Reconcile* unfollows people who followed back; *Cleanup* unfollows people who didn't after 3 days. Automatic versions run on the Advanced schedule.
- **Job controls** — Pause / Resume / Stop appear while a job runs. Jobs survive page reloads.

## Settings (Advanced)

- **Min / Max delay (ms)** — randomized wait between actions.
- **Session cap** — maximum actions per run.
- **Auto-reconcile** — toggle the background follow-back check and set its interval.
- **Humanization** (opt-in; slower):
  - **Browse posts first** — opens a post, scrolls its carousel, and dwells before following its likers.
  - **Occasionally like a comment** — likes 0–2 comments (usually none); always one on popular posts (>100 likes).
  - **Prioritize keyword accounts** — always likes comments from usernames containing the **Keyword** (default `flock`). At higher randomization, also visits those accounts, follows them, and likes some posts.
  - **Randomization** (0–100) — scales dwell times, image swipes, comment-like odds, and keyword-account engagement.
  - **Like a recent post after following** — sometimes opens a followed user's profile and likes their latest post, between targets (never mid-scan).
- **Activity limits:**
  - **Active hours** — only acts during a local-time window (wraps midnight, e.g. `22 → 6`). Outside it, runs and scheduled tasks sleep until the window reopens.
  - **Daily follow budget** — rolling per-day cap across all runs (default 180). Pauses until local midnight when hit.
  - **Hourly rate cap** — automatic, scaled by Randomization; ~15–20 follows/hour at max. Pauses until the oldest follow ages out. Persisted across restarts.
  - **Fatigue mode** — works in bursts with longer breaks, and grows the base delay over a session.
- **Filters:**
  - **Blacklist** — never follow these usernames.
  - **Protect list** — never unfollow these (used by reconcile and cleanup).
  - **Skip verified** — skip blue-check accounts.
  - **Skip private** / **Follower range (min/max)** — need the profile page, so they apply only where a profile is already open (e.g. keyword-account visits) unless *Vet every profile* is on.
  - **Vet every profile before following** — applies the private/follower filters to everyone. Per target, scans the list for candidates, visits each profile, checks the filters, and follows those that pass. Much slower; only used when a profile-level filter is set.

### Analytics

The Analytics panel shows a 14-day follows-per-day chart, today's follow count, and a follow-back rate. The rate comes from reconcile/cleanup outcomes: each unfollow is tagged `followed-back` or `no-follow-back`.

### Action-block backoff

Instagram blocks new follows if you go too fast. Each follow is verified (the button must flip to *Following*/*Requested*). If an "Action Blocked / Try Again Later" notice appears instead, the run enters a **waiting** state and retries on an escalating schedule:

1. 1st and 2nd block → 10–45 min each
2. 3rd block → 1–3 hours
3. 4th and beyond → 2–6 hours (max)

A successful follow resets the escalation. While waiting, the popup shows a live countdown, and Pause/Stop still work.

### Self-resuming jobs

Jobs survive a service-worker shutdown or browser restart. A heartbeat alarm keeps the worker warm; if it's torn down mid-run (or during a backoff wait), it wakes and resumes where it left off. Queue position, action counts, session-cap progress, and backoff level are all persisted. Re-scanning a list on resume is safe: already-followed users show *Following* and are skipped, and tracking dedupes. Paused jobs are never auto-resumed; pressing Resume rebuilds the runner even after a shutdown.

## How it works

| File            | Role |
| --------------- | ---- |
| `manifest.json` | One MV3 config for both browsers: permissions (`storage`, `alarms`, `cookies`, `scripting`, `tabs`, `sidePanel`) + `instagram.com` host. Chrome uses `side_panel` + `service_worker`; Firefox uses `sidebar_action` + background `scripts`. Each browser ignores the other's keys. |
| `background.js` | Background worker (service worker on Chrome, event page on Firefox): job runner (follow/unfollow, pacing, caps, backoff), reconcile/cleanup alarms, self-resume heartbeat, account switching via the `ds_user_id` cookie (with a cookie fallback for account detection), and side-panel/sidebar/popup switching. |
| `content.js`    | In-page DOM automation: account detection, dialog scrolling, row parsing, follow/unfollow/like clicks. |
| `storage.js`    | Account-namespaced storage helpers, loaded in the content script and the background. |
| `inject.js`     | MAIN-world shim at `document_start` that smooths over automation tells (`navigator.webdriver`, `window.chrome`, permissions/languages). |
| `popup.html/.css/.js` | The UI: run jobs, edit settings, account indicator, live progress, and activity log. |
| `ctx.js`        | Tags the page as popup vs. side panel/sidebar so CSS can size each. |

### Data model

Stored in `chrome.storage.local`:

```
accounts: {
  "<ds_user_id>": {
    username,
    profile: { followers, following, posts, updatedAt },   // real site counts
    tracked: {
      "<targetUsername>": { followedAt, source, status: "following" | "unfollowed", unfollowedAt?, reason? }
    },
    daily: { "YYYY-MM-DD": count },       // for the daily budget + chart
    recentFollows: [ timestamp, ... ]     // rolling ~1h window for the hourly cap
  }
}
settings: { uiMode, humanLevel, minDelayMs, maxDelayMs, sessionCap, randomization, dailyBudget, ... }
activeAccountId: "<ds_user_id>"
displayMode: "sidepanel" | "popup"
job: { id, type, param, status, progress, ... }
logs: [ { t, level, message } ]
```

A run is one `follow` job whose `param.items` is a mixed list of `{ kind: "followers" | "likers", value }`, so it interleaves account and post targets. `source` is `followers-of:<user>` or `post-likers:<shortcode>`. `uiMode` and `humanLevel` back the Simple-mode slider, which derives the concrete humanization fields.
