# BrightStream

BrightStream is a Manifest V3 Chrome extension that turns YouTube into a whitelist-only viewing experience for kids.

## Features

- Redirects YouTube home (`/`) to Subscriptions.
- Blocks Shorts URLs (`/shorts/*`) to Subscriptions.
- Filters video tiles and recommendations so only whitelisted channels remain.
- Enforces watch-page guard: blocked channels are redirected away.
- Supports per-channel daily watch limits (minutes/day) for whitelisted channels.
- Popup actions to add/remove the current channel.
- Options page to edit whitelist and import/export JSON.

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
  "version": 3,
  "mode": "strict",
  "channelIds": ["UCxxxx..."],
  "handles": ["@channel"],
  "channelRateLimitsMinutesByKey": {
    "id:UCxxxx...": 30,
    "handle:@channel": 15
  },
  "blockShorts": true,
  "enforceWatchGuard": true,
  "whitelistSubscriptionsByDefault": true,
  "parentLockEnabled": false,
  "pinHash": "",
  "debug": false
}
```

Daily usage counters are stored locally in `chrome.storage.local` under `ytRateUsageDailyV1`:

```json
{
  "dayKey": "2026-03-07",
  "secondsByKey": {
    "id:UCxxxx...": 1842,
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
2. Configure a channel daily limit in settings (for example `1` minute).
3. Watch that channel past the limit and verify:
   - current video can finish,
   - new starts from that channel are redirected,
   - recommendation side videos from that channel are removed,
   - subscriptions feed tiles from that channel are removed until next day.
4. Verify non-whitelisted channels are still blocked as before.