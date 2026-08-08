# IG Auto

> This browser extension is created strictly for educational, testing, and research purposes. **It is not intended for, and should not be used on, the live Instagram platform.**
>
> Automating interactions on the actual Instagram website strictly violates [Instagram's Terms of Service](https://help.instagram.com/581066165581870/). Using this extension on your actual Instagram account may result in the immediate suspension or permanent banning of your account.
>
> This tool is designed to be used **exclusively in a local sandbox or mock environment**.
>
> By downloading or using this extension, you agree that you are using it at your own risk. The creator assumes no responsibility or liability for any account bans, data loss, or other consequences resulting from the misuse of this tool on the live Instagram network.

## Preview

![IG Auto docked as a full-height side panel next to the site, showing the run card, human-likeness slider, and activity analytics](preview_full.png)

## Features

- **Follow an account's followers** — open a profile, follow everyone in its followers list.
- **Follow a post's likers** — follow everyone who liked a given post.
- **Follow-back tracking** — every follow is recorded per account.
- **Auto-unfollow on follow-back** — a timer (and a manual button) checks your own followers and unfollows tracked users who followed you back.
- **Multi-account aware** — data is namespaced by the logged-in account (`ds_user_id`). Switching users automatically switches the tracked database; nothing is mixed between accounts.
- **Human-like pacing** — randomized delays, a per-run session cap, plus pause / resume / stop.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder (`ig-sandbox-extension`).
4. Open your Instagram-clone tab and click the extension icon. The UI opens as a **docked side panel** on the right (full height, stays open while you browse — Chrome 114+). The same page also works as a fallback popup.

If you loaded the extension while an Instagram tab was already open, refresh that tab once so the content script is injected.

## Usage

Open the popup while on the clone site. The interface has two modes, switchable with the toggle at the top:

- **Simple** — a single **Human-likeness** slider (Fast → Stealth) configures every humanization setting for you. Move it and the popup shows exactly what that level will do (delay range, whether it browses posts, takes breaks, sticks to waking hours, etc.). No individual toggles to fiddle with.
- **Advanced** — every setting exposed individually (timing, humanization, activity limits, filters, automation schedule). Adjust anything and press *Save advanced settings*.

### One box for everything

There's a single **"What should I run on?"** box. Paste any mix of:

- usernames, `@handles`, or profile links → follows that account's **followers**;
- post links or shortcodes → follows that post's **likers**.

Mix accounts and posts freely, one per line. The popup classifies each line live (e.g. *2 accounts · 1 post · 3 in queue*) and runs them all as a single queue, advancing automatically. The whole run shares one session cap; the progress line shows `target N/total` plus the target being processed.

If you're already viewing a profile or post on the site, a **smart card** appears at the top suggesting it — click *Add* to drop it into the box.

- **Preview only (dry run)** — a toggle right on the run card: logs every action it *would* take without actually following anyone.
- **Follow-backs & cleanup**: under *Maintenance tools* — *Reconcile* unfollows people who followed you back; *Cleanup* unfollows people who never did after 3 days; automatic versions run on the schedule in Advanced settings.
- **Job controls**: *Pause*, *Resume*, and *Stop* appear in the status strip while a job is active. Jobs survive page reloads (needed because opening a followers/likers list reloads the page).

## Settings (Advanced mode)

- **Min / Max delay (ms)** — randomized wait between each follow/unfollow.
- **Session cap** — maximum actions per run, to stay conservative.
- **Auto-reconcile** — enable/disable the background follow-back check and set its interval (minutes).
- **Humanization** (opt-in, makes runs much slower):
  - **Browse posts first** — before following a post's likers, open the post, scroll through its carousel images back and forth, and dwell.
  - **Occasionally like a comment** — reads the comments and likes 0–2 of them. Usually none; a comment is always liked on popular posts (>100 likes).
  - **Prioritize keyword accounts** — comments from usernames containing the configured **Keyword** (default `flock`) are *always* liked. At higher randomization the bot will also visit those accounts, follow them, and like/browse some of their posts. At max randomization this happens for nearly every match and digs much deeper.
  - **Randomization** (0–100 slider) — scales dwell times, number of image swipes, comment-like odds, and how aggressively keyword accounts are engaged. Higher is more human-like but noticeably slower.
  - **Like a recent post after following** — after following someone, sometimes opens their profile and likes their latest post. Done between targets (never mid-scan) so it doesn't disrupt the follow queue.
- **Activity limits** (behave like a real person):
  - **Active hours** — only act during a local-time window (wraps midnight, e.g. `22 → 6`). Outside it, the run sleeps until the window reopens; scheduled reconcile/cleanup also skip outside these hours.
  - **Daily follow budget** — a rolling per-calendar-day cap across *all* runs (not just per-session), default **180**. When hit, the run pauses until local midnight, then continues.
  - **Hourly rate cap** — applied automatically and scaled by the Randomization slider: it tightens as humanization rises, and at maximum humanization allows no more than **~15–20 follows per hour**. When hit, the run pauses until the oldest follow in the window ages out. Both limits are persisted, so they hold across restarts.
  - **Fatigue mode** — works in bursts of follows separated by longer breaks, and the base delay grows the longer a session runs.
- **Filters** — choose who to skip:
  - **Blacklist** — usernames you'll never follow.
  - **Protect list** — usernames you'll never unfollow (honored by reconcile *and* cleanup).
  - **Skip verified** — skip blue-check accounts.
  - **Skip private** and **Follower range (min/max)** — need the profile page, so by default they apply only where a profile is already opened (e.g. keyword-account visits).
  - **Vet every profile before following** — applies the private/follower filters to *everyone*. It runs in two phases per target: first it scans the list to collect candidates, then it visits each candidate's profile in turn, checks the filters, and follows the ones that pass. Much slower, and only kicks in when a profile-level filter (private/follower range) is actually set.

### Analytics

The **Analytics** panel shows a 14-day follows-per-day bar chart, today's follow count, and a **follow-back rate** derived from reconcile/cleanup outcomes (each unfollow is tagged `followed-back` or `no-follow-back`).

### Action-block backoff

Instagram temporarily blocks new follows if you go too fast. Each follow is verified (the button must flip to *Following*/*Requested*); if a "Try Again Later / Action Blocked" notice is detected instead, the run parks itself in a **waiting** state and retries later on an escalating schedule:

1. 1st block → wait a random **10–45 min**
2. 2nd block → wait another random **10–45 min**
3. 3rd block → wait a random **1–3 hours**
4. 4th block and beyond → wait a random **2–6 hours** (the maximum)

A successful follow resets the escalation. While waiting, the popup shows a live countdown, and Pause/Stop still work.

### Self-resuming jobs

A running job survives a service-worker shutdown or a browser restart. A persistent **heartbeat** alarm keeps the worker warm and, if it's ever torn down mid-run (or during a multi-hour backoff wait), wakes it back up and restarts the job from where it left off — the queue position, action counts, session-cap progress, and backoff level are all persisted. Re-scanning a list on resume is safe and idempotent: already-followed users show *Following* and are skipped, and tracking dedupes. **Paused** jobs are never auto-resumed (that's your call); pressing **Resume** rebuilds the runner even if the worker had been shut down.

## How it works


| File                  | Role                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`       | MV3 config: permissions (`storage`, `alarms`, `cookies`, `scripting`, `tabs`) + `instagram.com` host.                       |
| `storage.js`          | Shared, account-namespaced storage helpers (loaded in both the content script and the service worker).                      |
| `content.js`          | All DOM automation: account detection, dialog scrolling, row parsing, follow/unfollow, and the reload-surviving job runner. |
| `background.js`       | Service worker: reconcile timer via `chrome.alarms`, account switching via the `ds_user_id` cookie, control messages.       |
| `popup.html/.css/.js` | Control panel: run jobs, settings, current-account indicator, live progress + activity log.                                 |


### Data model

Stored in `chrome.storage.local`:

```
accounts: {
  "<ds_user_id>": {
    username: "me",
    tracked: {
      "<targetUsername>": { followedAt, source, status: "following" | "unfollowed", unfollowedAt? }
    }
  }
}
settings: { uiMode, humanLevel, minDelayMs, maxDelayMs, sessionCap, reconcileEnabled, reconcileIntervalMin, ... }
activeAccountId: "<ds_user_id>"
job: { id, type, param, status, progress, ... }
logs: [ { t, level, message } ]
```

The popup starts a unified `follow` job whose `param.items` is a mixed list of `{ kind: "followers" | "likers", value }`, so one run can interleave account and post targets. (`uiMode` / `humanLevel` back the Simple-mode slider; the slider derives the concrete humanization fields.)

`source` is either `followers-of:<user>` or `post-likers:<shortcode>`.