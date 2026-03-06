# BrightStream

BrightStream is a Manifest V3 Chrome extension that turns YouTube into a whitelist-only viewing experience for kids.

## Features

- Redirects YouTube home (`/`) to Subscriptions.
- Blocks Shorts URLs (`/shorts/*`) to Subscriptions.
- Filters video tiles and recommendations so only whitelisted channels remain.
- Enforces watch-page guard: non-whitelisted videos are redirected away.
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

Stored in `chrome.storage.sync` under `ytWhitelistSettings`:

```json
{
  "version": 2,
  "mode": "strict",
  "channelIds": ["UCxxxx..."],
  "handles": ["@channel"],
  "blockShorts": true,
  "enforceWatchGuard": true,
  "parentLockEnabled": false,
  "pinHash": "",
  "debug": false
}
```

## Load locally

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `D:\dev\BrightStream`.

## Quick test

1. Open `https://www.youtube.com/` and confirm redirect to `https://www.youtube.com/feed/subscriptions`.
2. Open a Shorts URL and confirm redirect to subscriptions.
3. In extension popup, add a trusted channel while on that channel/watch page.
4. On subscriptions/watch/recommendations, confirm non-whitelisted videos are removed.
5. Open a non-whitelisted video URL directly and confirm redirect to subscriptions.
