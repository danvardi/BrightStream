# BrightStream

BrightStream is a Manifest V3 Chrome extension that turns YouTube into a whitelist-only viewing experience for kids.

## Features

- Redirects YouTube home (`/`) to Subscriptions.
- Blocks Shorts URLs (`/shorts/*`) to Subscriptions.
- Filters video tiles and recommendations so only whitelisted channels remain.
- Enforces watch-page guard: blocked channels are redirected away.
- Supports shared daily watch limits via rate-limit groups (minutes/day), assignable per whitelisted channel.
- Options page shows daily watch stats per whitelisted channel and aggregated per rate-limit group (today only; Open/Unlimited shows N/A).
- Popup actions to add/remove the current channel, with best-effort YouTube subscribe when adding.
- Options page to edit whitelist, import/export JSON, and manage whitelist subscriptions (status, per-channel subscribe, subscribe-all).
- Legacy JSON imports with per-channel minutes are auto-mapped into rate-limit groups (reuse same-minute group if it exists, otherwise create one).

## Files

- `manifest.json`
- `rules.json`
- `redirect_guard.js`
- `filter.js`
- `popup.html`, `popup.js`
- `options.html`, `options.js`
- `styles.css`

## Data model

Settings are stored in `chrome.storage.sync` under `ytWhitelistSettings`:

```json
{
  "version": 4,
  "mode": "strict",
  "channelIds": ["UCxxxx..."],
  "handles": ["@channel"],
  "rateLimitGroupsById": {
    "open": { "name": "Open", "minutes": null },
    "30min": { "name": "30 min", "minutes": 30 },
    "60min": { "name": "60 min", "minutes": 60 },
    "5min-kids": { "name": "Kids 5", "minutes": 5 }
  },
  "channelRateLimitGroupByKey": {
    "id:UCxxxx...": "30min",
    "handle:@channel": "5min-kids"
  },
  "blockShorts": true,
  "enforceWatchGuard": true,
  "whitelistSubscriptionsByDefault": true,
  "parentLockEnabled": false,
  "pinHash": "",
  "debug": false
}
```

Daily usage counters are stored locally in `chrome.storage.local` under:

- `ytRateUsageDailyV2` (rate-limit enforcement, per group)
- `ytRateUsageByKeyDailyV1` (options stats, per whitelist key)

```json
{
  "dayKey": "2026-03-07",
  "secondsByGroupId": {
    "30min": 1842,
    "5min-kids": 300
  }
}
```

```json
{
  "dayKey": "2026-03-07",
  "secondsByKey": {
    "id:UCxxxx...": 900,
    "handle:@channel": 300
  }
}
```

## Load locally

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `D:\dev\BrightStream`.

## Quick test

1. Open `https://www.youtube.com/` and confirm redirect to `https://www.youtube.com/feed/subscriptions`.
2. Assign two channels to the same rate-limit group (for example `30 min`) and optionally a third channel to another group (for example `5 min`).
3. Watch channels in the same group past the shared limit (for example 15 + 15 minutes in the 30-min group) and verify:
   - current video can finish,
   - new starts from any channel in that group are redirected,
   - recommendation side videos from channels in that group are removed,
   - subscriptions feed tiles from channels in that group are removed until next day.
4. Verify non-whitelisted channels are still blocked as before.
