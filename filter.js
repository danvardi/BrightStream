(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
  const RATE_USAGE_KEY = "ytRateUsageDailyV1";
  const SUBS_URL = "https://www.youtube.com/feed/subscriptions";
  const WATCH_GUARD_HIDE_STYLE_ID = "brightstream-watch-guard-style";
  const TILE_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-compact-radio-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-lockup-view-model",
    "yt-lockup-view-model",
    "ytd-reel-shelf-renderer",
    "ytd-reel-item-renderer"
  ];

  const DEFAULTS = {
    version: 3,
    mode: "strict",
    channelIds: [],
    handles: [],
    channelRateLimitsMinutesByKey: {},
    blockShorts: true,
    enforceWatchGuard: true,
    whitelistSubscriptionsByDefault: true,
    parentLockEnabled: false,
    pinHash: "",
    debug: false
  };

  const SEARCH_RESOLVE_RETRY_DELAY_MS = 150;
  const SEARCH_RESOLVE_MAX_RETRIES = 20;

  let settings = { ...DEFAULTS };
  let rateUsage = { dayKey: "", secondsByKey: {} };
  let observer = null;
  let watchGuardTimer = null;
  let watchGuardProbeToken = 0;
  let bootstrapTimer = null;
  let recommendationsTicker = null;
  let playbackTicker = null;
  let playbackLastTickAt = 0;
  let playbackCarrySeconds = 0;
  let playbackPendingPersistSeconds = 0;
  let playbackUsageDirty = false;
  let rateUsageFlushInFlight = null;
  let playbackVideoEl = null;
  let exemptPlayback = { videoId: "", channelKey: "" };
  const recommendationIdentityCache = new Map();
  const recommendationResolveInFlight = new Set();
  const searchPendingTilesByVideoId = new Map();
  const searchRetryTimers = new WeakMap();

  function log(...args) {
    if (settings.debug) {
      console.log("[BrightStream]", ...args);
    }
  }

  function normalizeHandle(value) {
    if (!value) return "";
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) return "";
    return cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
  }

  function normalizeChannelId(value) {
    if (!value) return "";
    return value.trim();
  }

  function normalizeRateLimitKey(key) {
    if (!key) return "";
    const text = String(key).trim();
    if (!text) return "";

    if (text.startsWith("id:")) {
      const channelId = normalizeChannelId(text.slice(3));
      return channelId ? `id:${channelId}` : "";
    }

    if (text.startsWith("handle:")) {
      const handle = normalizeHandle(text.slice(7));
      return handle ? `handle:${handle}` : "";
    }

    return "";
  }

  function normalizeRateLimitMinutes(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;

    const minutes = Math.floor(num);
    if (minutes < 1 || minutes > 1440) return null;
    return minutes;
  }

  function normalizeRateLimitMap(raw) {
    if (!raw || typeof raw !== "object") return {};

    const normalized = {};
    for (const [rawKey, rawValue] of Object.entries(raw)) {
      const key = normalizeRateLimitKey(rawKey);
      const minutes = normalizeRateLimitMinutes(rawValue);
      if (!key || minutes === null) continue;
      normalized[key] = minutes;
    }
    return normalized;
  }

  function getLocalDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function normalizeRateUsage(raw) {
    const today = getLocalDayKey();
    const next = {
      dayKey: typeof raw?.dayKey === "string" ? raw.dayKey : today,
      secondsByKey: {}
    };

    if (raw?.secondsByKey && typeof raw.secondsByKey === "object") {
      for (const [rawKey, rawValue] of Object.entries(raw.secondsByKey)) {
        const key = normalizeRateLimitKey(rawKey);
        if (!key) continue;

        const secondsNum = Number(rawValue);
        if (!Number.isFinite(secondsNum) || secondsNum <= 0) continue;
        next.secondsByKey[key] = Math.floor(secondsNum);
      }
    }

    if (next.dayKey !== today) {
      return { dayKey: today, secondsByKey: {} };
    }

    return next;
  }

  function normalizeSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    merged.version = 3;
    merged.channelIds = [...new Set((merged.channelIds || []).map(normalizeChannelId).filter(Boolean))];
    merged.handles = [...new Set((merged.handles || []).map(normalizeHandle).filter(Boolean))];
    merged.channelRateLimitsMinutesByKey = normalizeRateLimitMap(merged.channelRateLimitsMinutesByKey);
    merged.mode = merged.mode === "lenient" ? "lenient" : "strict";
    merged.whitelistSubscriptionsByDefault = merged.whitelistSubscriptionsByDefault !== false;
    return merged;
  }

  async function loadSettings() {
    const data = await chrome.storage.sync.get([SETTINGS_KEY]);
    settings = normalizeSettings(data[SETTINGS_KEY]);
    return settings;
  }

  async function saveSettings(next) {
    settings = normalizeSettings(next);
    await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  }

  async function loadRateUsage() {
    const data = await chrome.storage.local.get([RATE_USAGE_KEY]);
    rateUsage = normalizeRateUsage(data[RATE_USAGE_KEY]);
    return rateUsage;
  }

  function markRateUsageDirty(secondsDelta = 0) {
    playbackUsageDirty = true;
    if (secondsDelta > 0) {
      playbackPendingPersistSeconds += secondsDelta;
    }
  }

  function ensureRateUsageCurrentDay() {
    const today = getLocalDayKey();
    if (rateUsage.dayKey === today) return;

    rateUsage = { dayKey: today, secondsByKey: {} };
    exemptPlayback = { videoId: "", channelKey: "" };
    markRateUsageDirty(15);
  }

  async function persistRateUsage(force = false) {
    if (!playbackUsageDirty) return;
    if (!force && playbackPendingPersistSeconds < 15) return;

    if (rateUsageFlushInFlight) {
      await rateUsageFlushInFlight;
      if (!playbackUsageDirty) return;
      if (!force && playbackPendingPersistSeconds < 15) return;
    }

    const payload = {
      dayKey: rateUsage.dayKey,
      secondsByKey: { ...(rateUsage.secondsByKey || {}) }
    };

    playbackUsageDirty = false;
    playbackPendingPersistSeconds = 0;

    rateUsageFlushInFlight = chrome.storage.local.set({ [RATE_USAGE_KEY]: payload })
      .catch((err) => {
        playbackUsageDirty = true;
        log("Rate usage persist failed", err);
      })
      .finally(() => {
        rateUsageFlushInFlight = null;
      });

    await rateUsageFlushInFlight;
  }

  function getPathname() {
    return window.location.pathname || "";
  }

  function isWatchPage() {
    return getPathname() === "/watch";
  }

  function isSubscriptionsPage() {
    return getPathname().startsWith("/feed/subscriptions");
  }

  function isSearchPage() {
    return getPathname().startsWith("/results");
  }

  function isHomePage() {
    const path = getPathname();
    return path === "" || path === "/";
  }

  function setWatchGuardHidden(hidden) {
    const existing = document.getElementById(WATCH_GUARD_HIDE_STYLE_ID);
    if (hidden) {
      if (existing) return;
      const style = document.createElement("style");
      style.id = WATCH_GUARD_HIDE_STYLE_ID;
      style.textContent = "html{visibility:hidden !important;}";
      (document.head || document.documentElement).appendChild(style);
      return;
    }

    if (existing) {
      existing.remove();
    }
  }

  function getCurrentVideoIdFromLocation() {
    try {
      return new URL(window.location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function shouldBlockByPath() {
    const path = getPathname();
    const normalizedPath = normalizePathname(path);
    const segments = normalizedPath.split("/").filter(Boolean);

    if (settings.blockShorts) {
      const isShortsPath = normalizedPath === "/shorts" || normalizedPath.startsWith("/shorts/");
      const isSubscriptionsShorts = normalizedPath === "/feed/subscriptions/shorts" || normalizedPath.startsWith("/feed/subscriptions/shorts/");
      if (isShortsPath || isSubscriptionsShorts) {
        return true;
      }
    }

    const isHandleChannelRoot = segments.length === 1 && segments[0]?.startsWith("@");
    const isChannelIdRoot = segments.length === 2 && segments[0] === "channel";
    if (!isHandleChannelRoot && !isChannelIdRoot) {
      return false;
    }

    const identity = extractIdentityFromUrl(normalizedPath);
    if (!identity || (!identity.channelId && !identity.handle)) {
      return true;
    }

    return !isWhitelisted(identity);
  }

  function redirectToSubscriptions() {
    if (window.location.href !== SUBS_URL) {
      window.location.replace(SUBS_URL);
    }
  }

  function parseUrlLike(urlValue) {
    if (!urlValue) return null;
    try {
      return new URL(String(urlValue), window.location.origin);
    } catch {
      return null;
    }
  }

  function hrefTargetsWatchPage(href) {
    const url = parseUrlLike(href);
    return Boolean(url && url.pathname === "/watch" && url.searchParams.get("v"));
  }

  function urlValueTargetsWatchPage(urlValue) {
    const url = parseUrlLike(urlValue);
    return Boolean(url && url.pathname === "/watch");
  }

  function findAnchorFromEvent(event) {
    return event.target instanceof Element ? event.target.closest("a[href]") : null;
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function resolveRateLimitConfig(identity) {
    if (!identity) return null;

    const idKey = identity.channelId ? `id:${normalizeChannelId(identity.channelId)}` : "";
    if (idKey && settings.channelRateLimitsMinutesByKey[idKey]) {
      return { key: idKey, minutes: settings.channelRateLimitsMinutesByKey[idKey] };
    }

    const handleKey = identity.handle ? `handle:${normalizeHandle(identity.handle)}` : "";
    if (handleKey && settings.channelRateLimitsMinutesByKey[handleKey]) {
      return { key: handleKey, minutes: settings.channelRateLimitsMinutesByKey[handleKey] };
    }

    return null;
  }

  function getUsedSecondsForKey(key) {
    ensureRateUsageCurrentDay();
    return Number(rateUsage.secondsByKey?.[key] || 0);
  }

  function isCurrentVideoExemptForKey(key) {
    if (!key) return false;
    if (!exemptPlayback.videoId || !exemptPlayback.channelKey) return false;
    if (exemptPlayback.channelKey !== key) return false;

    const currentVideoId = getCurrentVideoIdFromLocation();
    if (!currentVideoId) return false;
    return currentVideoId === exemptPlayback.videoId;
  }

  function isRateLimited(identity, options = {}) {
    const { allowCurrentVideoExempt = false } = options;
    const config = resolveRateLimitConfig(identity);
    if (!config) return false;

    const usedSeconds = getUsedSecondsForKey(config.key);
    const limitSeconds = config.minutes * 60;
    if (usedSeconds < limitSeconds) return false;

    if (allowCurrentVideoExempt && isCurrentVideoExemptForKey(config.key)) {
      return false;
    }

    return true;
  }

  function isWhitelisted(identity) {
    if (!identity) return false;
    const channelIdAllowed = Boolean(identity.channelId && settings.channelIds.includes(identity.channelId));
    const handleAllowed = Boolean(identity.handle && settings.handles.includes(identity.handle));

    // In strict mode, if channelId is not available yet, allow handle match to avoid false removals.
    if (settings.mode === "strict") {
      return channelIdAllowed || (!identity.channelId && handleAllowed);
    }

    return channelIdAllowed || handleAllowed;
  }

  function isWhitelistedForWatchGuard(identity) {
    if (!identity) return false;

    let allowed = false;
    if (isWhitelisted(identity)) {
      allowed = true;
    } else if (settings.whitelistSubscriptionsByDefault && identity.handle) {
      allowed = settings.handles.includes(identity.handle);
    }

    if (!allowed) return false;
    return !isRateLimited(identity, { allowCurrentVideoExempt: true });
  }

  function isWhitelistedForRecommendations(identity) {
    if (!identity) return false;
    const channelIdAllowed = Boolean(identity.channelId && settings.channelIds.includes(identity.channelId));
    const handleAllowed = Boolean(identity.handle && settings.handles.includes(identity.handle));
    return channelIdAllowed || handleAllowed;
  }

  function isWhitelistedForSearch(identity) {
    if (!identity) return false;
    const channelIdAllowed = Boolean(identity.channelId && settings.channelIds.includes(identity.channelId));
    const handleAllowed = Boolean(identity.handle && settings.handles.includes(identity.handle));
    return channelIdAllowed || handleAllowed;
  }

  function isAllowedForRecommendations(identity) {
    if (!isWhitelistedForRecommendations(identity)) return false;
    return !isRateLimited(identity);
  }

  function extractIdentityFromUrl(urlValue) {
    if (!urlValue) return null;
    let url;
    try {
      url = new URL(urlValue, window.location.origin);
    } catch {
      return null;
    }

    const path = url.pathname || "";
    const segments = path.split("/").filter(Boolean);
    let channelId = "";
    let handle = "";

    if (segments[0] === "channel" && segments[1]) {
      channelId = normalizeChannelId(segments[1]);
    }
    if (segments[0] && segments[0].startsWith("@")) {
      handle = normalizeHandle(segments[0]);
    }

    return { channelId, handle };
  }

  function getChannelLinkFromTile(tile) {
    if (!tile) return null;

    const selectors = [
      "a.yt-simple-endpoint.yt-formatted-string[href*='/channel/']",
      "a.yt-simple-endpoint.yt-formatted-string[href^='/@']",
      "ytd-channel-name a[href*='/channel/']",
      "ytd-channel-name a[href^='/@']",
      "#channel-name a[href*='/channel/']",
      "#channel-name a[href^='/@']",
      "a[href*='/channel/']",
      "a[href^='/@']"
    ];

    for (const sel of selectors) {
      const el = tile.querySelector(sel);
      if (el && el.getAttribute("href")) {
        return el.getAttribute("href");
      }
    }
    return null;
  }

  function extractIdentityFromTileData(tile) {
    const data = tile?.data || tile?.__data?.data || tile?.__dataHost?.data;
    if (!data) return null;

    const runs =
      data?.shortBylineText?.runs ||
      data?.longBylineText?.runs ||
      data?.ownerText?.runs ||
      data?.bylineText?.runs ||
      [];

    const browseEndpoint = runs?.[0]?.navigationEndpoint?.browseEndpoint;
    let browseId = normalizeChannelId(browseEndpoint?.browseId || "");

    let handle = "";
    const canonicalBaseUrl = browseEndpoint?.canonicalBaseUrl || "";
    if (canonicalBaseUrl.startsWith("/@")) {
      handle = normalizeHandle(canonicalBaseUrl.slice(1));
    }

    if (!handle) {
      const webUrl = runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || "";
      if (webUrl.startsWith("/@")) {
        handle = normalizeHandle(webUrl.slice(1));
      }
    }

    if (!browseId || !handle) {
      // Search lockup renderers often store channel identity outside byline runs.
      const seen = new Set();
      const queue = [{ value: data, depth: 0 }];
      let processed = 0;

      while (queue.length && processed < 300 && (!browseId || !handle)) {
        const current = queue.shift();
        const value = current?.value;
        const depth = current?.depth || 0;
        processed += 1;

        if (!value || typeof value !== "object") continue;
        if (seen.has(value)) continue;
        seen.add(value);

        if (!browseId && typeof value.browseId === "string" && value.browseId.startsWith("UC")) {
          browseId = normalizeChannelId(value.browseId);
        }

        if (!handle) {
          const candidates = [value.canonicalBaseUrl, value.url];
          for (const candidate of candidates) {
            if (typeof candidate !== "string") continue;
            if (candidate.startsWith("/@")) {
              handle = normalizeHandle(candidate.slice(1));
              break;
            }
          }
        }

        if (depth >= 6) continue;

        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object") {
              queue.push({ value: item, depth: depth + 1 });
            }
          }
          continue;
        }

        for (const child of Object.values(value)) {
          if (child && typeof child === "object") {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      }
    }

    if (!browseId && !handle) return null;
    return { channelId: browseId, handle };
  }

  function resolveTileIdentity(tile) {
    const href = getChannelLinkFromTile(tile);
    const fromHref = extractIdentityFromUrl(href);
    if (fromHref && (fromHref.channelId || fromHref.handle)) {
      return fromHref;
    }

    return extractIdentityFromTileData(tile);
  }

  function getVideoLinkFromTile(tile) {
    if (!tile) return "";
    const selectors = [
      "a#thumbnail[href*='\/watch']",
      "a.yt-simple-endpoint[href*='\/watch']",
      "a[href*='\/watch?v=']"
    ];

    for (const selector of selectors) {
      const link = tile.querySelector(selector);
      const href = link?.getAttribute("href") || "";
      if (href) return href;
    }
    return "";
  }

  function extractVideoIdFromHref(href) {
    if (!href) return "";
    try {
      const url = new URL(href, window.location.origin);
      return url.searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  async function fetchIdentityForVideoId(videoId) {
    if (!videoId) return null;
    if (recommendationIdentityCache.has(videoId)) {
      return recommendationIdentityCache.get(videoId);
    }

    const watchUrl = `${window.location.origin}/watch?v=${encodeURIComponent(videoId)}`;
    const oembedUrl = `${window.location.origin}/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const response = await fetch(oembedUrl, { credentials: "same-origin" });
    if (!response.ok) return null;

    const payload = await response.json();
    const authorUrl = payload?.author_url || "";
    const identity = extractIdentityFromUrl(authorUrl);
    if (!identity || (!identity.channelId && !identity.handle)) return null;

    recommendationIdentityCache.set(videoId, identity);
    return identity;
  }

  function resolveRecommendationTileIdentity(tile) {
    const href = getVideoLinkFromTile(tile);
    const videoId = extractVideoIdFromHref(href);
    if (!videoId || recommendationResolveInFlight.has(videoId)) return;

    recommendationResolveInFlight.add(videoId);
    fetchIdentityForVideoId(videoId)
      .then((identity) => {
        if (!identity) return;
        if (tile.isConnected && !isAllowedForRecommendations(identity)) {
          removeNode(tile);
        }
      })
      .catch((err) => log("Recommendation resolve failed", err))
      .finally(() => {
        recommendationResolveInFlight.delete(videoId);
      });
  }

  function hideTilePendingResolution(tile) {
    if (!(tile instanceof HTMLElement)) return;
    tile.dataset.bsSearchPending = "1";
    tile.style.display = "none";
  }

  function clearSearchRetryTimer(tile) {
    const timer = searchRetryTimers.get(tile);
    if (timer) {
      clearTimeout(timer);
      searchRetryTimers.delete(tile);
    }
  }

  function scheduleSearchRetry(tile) {
    if (!(tile instanceof HTMLElement)) return;
    if (searchRetryTimers.has(tile)) return;

    const timer = setTimeout(() => {
      searchRetryTimers.delete(tile);
      if (!tile.isConnected) return;
      resolveSearchTileIdentity(tile);
    }, SEARCH_RESOLVE_RETRY_DELAY_MS);

    searchRetryTimers.set(tile, timer);
  }

  function showTileAfterResolution(tile) {
    if (!(tile instanceof HTMLElement)) return;
    clearSearchRetryTimer(tile);
    delete tile.dataset.bsSearchRetryCount;
    if (!tile.dataset.bsSearchPending) return;
    delete tile.dataset.bsSearchPending;
    tile.style.removeProperty("display");
  }

  function resolveSearchPendingState(videoId) {
    let state = searchPendingTilesByVideoId.get(videoId);
    if (state) return state;

    state = { tiles: new Set(), inFlight: false };
    searchPendingTilesByVideoId.set(videoId, state);
    return state;
  }

  function settleSearchTiles(videoId, shouldShow) {
    const state = searchPendingTilesByVideoId.get(videoId);
    if (!state) return;

    searchPendingTilesByVideoId.delete(videoId);
    state.tiles.forEach((tile) => {
      if (!(tile instanceof HTMLElement) || !tile.isConnected) return;
      if (shouldShow) {
        showTileAfterResolution(tile);
      } else {
        clearSearchRetryTimer(tile);
        removeNode(tile);
      }
    });
  }

  function resolveSearchTileIdentity(tile) {
    if (!(tile instanceof HTMLElement)) return;
    if (!settings.blockShorts || !isSearchPage()) return;

    const href = getVideoLinkFromTile(tile);
    const videoId = extractVideoIdFromHref(href);
    if (!videoId) {
      hideTilePendingResolution(tile);
      const retries = Number(tile.dataset.bsSearchRetryCount || 0);
      if (retries >= SEARCH_RESOLVE_MAX_RETRIES) {
        clearSearchRetryTimer(tile);
        removeNode(tile);
        return;
      }
      tile.dataset.bsSearchRetryCount = String(retries + 1);
      scheduleSearchRetry(tile);
      return;
    }

    clearSearchRetryTimer(tile);
    delete tile.dataset.bsSearchRetryCount;
    hideTilePendingResolution(tile);

    const state = resolveSearchPendingState(videoId);
    state.tiles.add(tile);
    if (state.inFlight) return;

    state.inFlight = true;
    fetchIdentityForVideoId(videoId)
      .then((identity) => {
        const shouldShow = Boolean(identity && !isRateLimited(identity) && isWhitelistedForSearch(identity));
        settleSearchTiles(videoId, shouldShow);
      })
      .catch(() => {
        settleSearchTiles(videoId, false);
      });
  }

  function getRemovalTarget(node) {
    if (!(node instanceof HTMLElement)) return null;

    const tag = node.tagName.toLowerCase();
    if (tag === "ytd-lockup-view-model" || tag === "yt-lockup-view-model") {
      const host = node.closest([
        "ytd-rich-item-renderer",
        "ytd-video-renderer",
        "ytd-compact-video-renderer",
        "ytd-grid-video-renderer",
        "ytd-playlist-video-renderer",
        "ytd-compact-radio-renderer",
        "ytd-compact-playlist-renderer",
        "ytd-end-screen-video-renderer"
      ].join(","));

      if (host instanceof HTMLElement) {
        return host;
      }
    }

    return node;
  }

  function removeNode(node) {
    const target = getRemovalTarget(node);
    if (!target || !target.isConnected) return;
    target.remove();
  }
  function normalizePathname(pathname) {
    return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  }

  function isShortsPath(pathname) {
    const path = normalizePathname(pathname || "");
    return path === "/shorts" || path.startsWith("/shorts/");
  }

  function hrefTargetsShorts(href) {
    if (!href) return false;
    try {
      const url = new URL(href, window.location.origin);
      return isShortsPath(url.pathname);
    } catch {
      return false;
    }
  }

  function tileDataHasShortsUrl(tile) {
    const roots = [tile?.data, tile?.__data?.data, tile?.__dataHost?.data].filter(Boolean);
    if (!roots.length) return false;

    for (const root of roots) {
      const seen = new Set();
      const queue = [{ value: root, depth: 0 }];
      let processed = 0;

      while (queue.length && processed < 250) {
        const { value, depth } = queue.shift();
        processed += 1;
        if (!value) continue;

        if (typeof value === "string") {
          if (hrefTargetsShorts(value)) {
            return true;
          }
          continue;
        }

        if (typeof value !== "object") continue;
        if (seen.has(value)) continue;
        seen.add(value);

        if (depth >= 6) continue;

        if (Array.isArray(value)) {
          for (const item of value) {
            queue.push({ value: item, depth: depth + 1 });
          }
          continue;
        }

        for (const [key, child] of Object.entries(value)) {
          if (typeof child === "string") {
            const normalizedKey = key.toLowerCase();
            if ((normalizedKey === "url" || normalizedKey.endsWith("url")) && hrefTargetsShorts(child)) {
              return true;
            }
            if (normalizedKey.includes("shorts") && hrefTargetsShorts(child)) {
              return true;
            }
          } else if (child && typeof child === "object") {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      }
    }

    return false;
  }

  function isShortsTile(tile) {
    if (!settings.blockShorts) return false;

    const tag = tile.tagName.toLowerCase();
    if (tag.includes("reel") || tag.includes("shorts")) return true;

    const links = tile.querySelectorAll("a[href]");
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (hrefTargetsShorts(href)) return true;
    }

    if (tileDataHasShortsUrl(tile)) return true;

    const text = (tile.textContent || "").toLowerCase();
    return text.includes("shorts");
  }

  function removeShortsSections(root = document) {
    if (!settings.blockShorts || !root?.querySelectorAll) return;

    const hardShortsSelectors = [
      "ytd-reel-shelf-renderer",
      "ytd-reel-item-renderer",
      "ytd-shorts-lockup-view-model",
      "yt-shorts-lockup-view-model",
      "ytm-shorts-lockup-view-model"
    ];

    root.querySelectorAll(hardShortsSelectors.join(",")).forEach((node) => removeNode(node));

    root.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (!hrefTargetsShorts(href)) return;

      const shortsHost = anchor.closest(
        [
          "ytd-reel-item-renderer",
          "ytd-reel-shelf-renderer",
          "ytd-shorts-lockup-view-model",
          "yt-shorts-lockup-view-model",
          "ytm-shorts-lockup-view-model",
          "ytd-rich-item-renderer",
          "ytd-video-renderer",
          "ytd-lockup-view-model",
          "yt-lockup-view-model",
          "ytd-shelf-renderer",
          "ytd-rich-shelf-renderer",
          "ytd-item-section-renderer"
        ].join(",")
      );

      if (shortsHost) {
        removeNode(shortsHost);
      }
    });
  }

  function shouldTreatAsVideoTile(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    return TILE_SELECTORS.includes(el.tagName.toLowerCase());
  }

  function maybeBlockWatchNavFromEvent(event) {
    if (!settings.enforceWatchGuard) return;

    const anchor = findAnchorFromEvent(event);
    if (!anchor) return;

    const href = anchor.getAttribute("href") || "";
    if (!hrefTargetsWatchPage(href)) return;

    const tile = anchor.closest(TILE_SELECTORS.join(","));
    if (!(tile instanceof HTMLElement)) return;

    const identity = resolveTileIdentity(tile);
    if (!identity || isWhitelistedForWatchGuard(identity)) return;

    log("Blocking watch navigation before route change", identity);
    stopEvent(event);
    setWatchGuardHidden(true);
    redirectToSubscriptions();
  }

  function onNavigateStart(event) {
    persistRateUsage(true).catch((err) => log("Persist on navigate-start failed", err));

    if (!settings.enforceWatchGuard) return;
    if (urlValueTargetsWatchPage(event?.detail?.url)) {
      setWatchGuardHidden(true);
    }
  }

  function isRecommendationTile(tile) {
    if (!tile || !(tile instanceof HTMLElement)) return false;
    return Boolean(
      tile.closest("#secondary, #related, ytd-watch-next-secondary-results-renderer") ||
      tile.closest("ytd-player ytd-endscreen")
    );
  }

  function tryWhitelistFromTile(tile, next) {
    const identity = resolveTileIdentity(tile);
    if (!identity) return false;

    let changed = false;
    if (identity.channelId && !next.channelIds.includes(identity.channelId)) {
      next.channelIds.push(identity.channelId);
      changed = true;
    }
    if (identity.handle && !next.handles.includes(identity.handle)) {
      next.handles.push(identity.handle);
      changed = true;
    }
    return changed;
  }

  function filterTile(tile, options = {}) {
    if (!tile || !tile.isConnected) return;

    if (isShortsTile(tile)) {
      removeNode(tile);
      return;
    }

    const recommendationMode = Boolean(options.recommendation || isRecommendationTile(tile));
    if (recommendationMode) {
      const identity = resolveTileIdentity(tile);
      if (!identity) {
        resolveRecommendationTileIdentity(tile);
        return;
      }
      if (!isAllowedForRecommendations(identity)) {
        removeNode(tile);
      }
      return;
    }

    const identity = resolveTileIdentity(tile);
    if (!identity) {
      if (options.failClosed) {
        resolveSearchTileIdentity(tile);
      }
      return;
    }

    if (isRateLimited(identity)) {
      removeNode(tile);
      return;
    }

    if (options.skipWhitelist) {
      return;
    }

    if (!isWhitelisted(identity)) {
      removeNode(tile);
    }
  }

  function filterExistingTiles(root = document, options = {}) {
    const nodes = root.querySelectorAll(TILE_SELECTORS.join(","));
    nodes.forEach((tile) => {
      if (options.excludeRecommendations && isRecommendationTile(tile)) {
        return;
      }
      filterTile(tile, options);
    });
  }

  function applyFiltersForCurrentPage() {
    const skipWhitelist = settings.whitelistSubscriptionsByDefault && isSubscriptionsPage();
    const failClosed = isSearchPage();
    filterExistingTiles(document, { skipWhitelist, excludeRecommendations: isWatchPage(), failClosed });
    removeShortsSections(document);
    forceFilterRecommendations();
  }

  function getCurrentPageIdentity() {
    if (isWatchPage()) {
      return extractCurrentWatchIdentity();
    }

    const pathname = getPathname();
    const fromPath = extractIdentityFromUrl(pathname);
    if ((fromPath && fromPath.channelId) || (fromPath && fromPath.handle)) {
      return fromPath;
    }

    return null;
  }

  async function bootstrapSubscriptionsWhitelist() {
    if (!settings.whitelistSubscriptionsByDefault || !isSubscriptionsPage()) return;

    const next = {
      ...settings,
      channelIds: [...settings.channelIds],
      handles: [...settings.handles]
    };

    let changed = false;
    document.querySelectorAll(TILE_SELECTORS.join(",")).forEach((tile) => {
      changed = tryWhitelistFromTile(tile, next) || changed;
    });

    if (changed) {
      await saveSettings(next);
      log("Bootstrapped whitelist from subscriptions feed");
    }
  }

  function scheduleSubscriptionsBootstrap() {
    if (!settings.whitelistSubscriptionsByDefault || !isSubscriptionsPage()) return;
    if (bootstrapTimer) clearTimeout(bootstrapTimer);
    bootstrapTimer = setTimeout(() => {
      bootstrapSubscriptionsWhitelist().catch((err) => {
        console.error("[BrightStream] bootstrap failed", err);
      });
    }, 300);
  }

  function forceFilterRecommendations() {
    if (!isWatchPage()) return;

    const recommendationSelectors = [
      "#secondary ytd-compact-video-renderer",
      "#secondary ytd-compact-radio-renderer",
      "#secondary ytd-compact-playlist-renderer",
      "#secondary ytd-compact-movie-renderer",
      "#secondary ytd-video-renderer",
      "#secondary ytd-rich-item-renderer",
      "#secondary ytd-lockup-view-model",
      "#secondary yt-lockup-view-model",
      "#related ytd-compact-video-renderer",
      "#related ytd-compact-radio-renderer",
      "#related ytd-compact-playlist-renderer",
      "#related ytd-compact-movie-renderer",
      "#related ytd-video-renderer",
      "#related ytd-rich-item-renderer",
      "#related ytd-lockup-view-model",
      "#related yt-lockup-view-model",
      "ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-compact-radio-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-compact-playlist-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-compact-movie-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-video-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-rich-item-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-lockup-view-model",
      "ytd-watch-next-secondary-results-renderer yt-lockup-view-model",
      "ytd-player ytd-endscreen ytd-end-screen-video-renderer"
    ];

    for (const selector of recommendationSelectors) {
      document.querySelectorAll(selector).forEach((tile) => {
        filterTile(tile, { recommendation: true });
      });
    }
    clearStuckRecommendationLoaders();
  }

  function clearStuckRecommendationLoaders() {
    if (!isWatchPage()) return;

    const now = Date.now();
    const loaderSelectors = [
      "#secondary ytd-continuation-item-renderer",
      "#related ytd-continuation-item-renderer",
      "#secondary tp-yt-paper-spinner",
      "#related tp-yt-paper-spinner"
    ];

    for (const selector of loaderSelectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const host = node.closest("ytd-continuation-item-renderer") || node;
        if (!(host instanceof HTMLElement)) return;

        if (!host.dataset.bsSeenAt) {
          host.dataset.bsSeenAt = String(now);
          return;
        }

        const seenAt = Number(host.dataset.bsSeenAt);
        if (Number.isFinite(seenAt) && now - seenAt > 3500) {
          host.remove();
        }
      });
    }
  }

  function getWatchVideoElement() {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement ? video : null;
  }

  function onPlaybackBoundaryEvent() {
    persistRateUsage(true).catch((err) => log("Persist on playback boundary failed", err));
  }

  function syncPlaybackVideoElement() {
    const next = getWatchVideoElement();
    if (next === playbackVideoEl) return;

    if (playbackVideoEl) {
      playbackVideoEl.removeEventListener("pause", onPlaybackBoundaryEvent, true);
      playbackVideoEl.removeEventListener("ended", onPlaybackBoundaryEvent, true);
    }

    playbackVideoEl = next;

    if (playbackVideoEl) {
      playbackVideoEl.addEventListener("pause", onPlaybackBoundaryEvent, true);
      playbackVideoEl.addEventListener("ended", onPlaybackBoundaryEvent, true);
    }
  }

  function startRecommendationsTicker() {
    if (recommendationsTicker) return;
    recommendationsTicker = setInterval(() => {
      if (!isWatchPage()) {
        stopRecommendationsTicker();
        return;
      }
      forceFilterRecommendations();
    }, 500);
  }

  function stopRecommendationsTicker() {
    if (!recommendationsTicker) return;
    clearInterval(recommendationsTicker);
    recommendationsTicker = null;
  }

  function startPlaybackTicker() {
    if (playbackTicker) return;

    playbackLastTickAt = Date.now();
    playbackTicker = setInterval(() => {
      tickPlaybackTracking().catch((err) => log("Playback tick failed", err));
    }, 5000);
  }

  function stopPlaybackTicker() {
    if (!playbackTicker) return;
    clearInterval(playbackTicker);
    playbackTicker = null;
    playbackLastTickAt = 0;
    playbackCarrySeconds = 0;
  }

  function isPlaybackCountable(video) {
    if (!video) return false;
    if (!isWatchPage()) return false;
    if (document.hidden) return false;
    if (video.paused) return false;
    if (video.ended) return false;
    return true;
  }

  function setExemptPlaybackForCurrentVideo(channelKey) {
    const videoId = getCurrentVideoIdFromLocation();
    if (!videoId || !channelKey) return;
    exemptPlayback = { videoId, channelKey };
  }

  function clearExemptPlaybackIfVideoChanged() {
    if (!exemptPlayback.videoId) return;
    const currentVideoId = getCurrentVideoIdFromLocation();
    if (!currentVideoId || currentVideoId !== exemptPlayback.videoId) {
      exemptPlayback = { videoId: "", channelKey: "" };
    }
  }

  function addUsageSecondsForConfig(rateConfig, secondsToAdd) {
    if (!rateConfig || !rateConfig.key || !secondsToAdd) return;
    ensureRateUsageCurrentDay();

    const limitSeconds = rateConfig.minutes * 60;
    const before = getUsedSecondsForKey(rateConfig.key);
    const after = before + secondsToAdd;

    rateUsage.secondsByKey[rateConfig.key] = after;
    markRateUsageDirty(secondsToAdd);

    if (before < limitSeconds && after >= limitSeconds) {
      setExemptPlaybackForCurrentVideo(rateConfig.key);
      applyFiltersForCurrentPage();
    }
  }

  function extractCurrentWatchIdentity() {
    const channelLink = document.querySelector(
      "ytd-watch-metadata ytd-channel-name a[href], #upload-info a[href], #owner a[href]"
    );

    if (!channelLink) return null;
    return extractIdentityFromUrl(channelLink.getAttribute("href"));
  }

  async function resolveCurrentWatchIdentity() {
    const direct = extractCurrentWatchIdentity();
    if (direct && (direct.channelId || direct.handle)) {
      return direct;
    }

    const videoId = getCurrentVideoIdFromLocation();
    if (!videoId) return null;

    try {
      return await fetchIdentityForVideoId(videoId);
    } catch {
      return null;
    }
  }

  async function tickPlaybackTracking() {
    ensureRateUsageCurrentDay();

    if (!isWatchPage()) return;

    syncPlaybackVideoElement();

    const now = Date.now();
    if (!playbackLastTickAt) {
      playbackLastTickAt = now;
      return;
    }

    const elapsedSeconds = (now - playbackLastTickAt) / 1000;
    playbackLastTickAt = now;

    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;

    const clampedSeconds = Math.min(elapsedSeconds, 6);
    const video = playbackVideoEl || getWatchVideoElement();
    if (!isPlaybackCountable(video)) return;

    const identity = await resolveCurrentWatchIdentity();
    if (!identity) return;

    const rateConfig = resolveRateLimitConfig(identity);
    if (!rateConfig) return;

    playbackCarrySeconds += clampedSeconds;
    const wholeSeconds = Math.floor(playbackCarrySeconds);
    if (wholeSeconds <= 0) return;

    playbackCarrySeconds -= wholeSeconds;
    addUsageSecondsForConfig(rateConfig, wholeSeconds);

    if (playbackPendingPersistSeconds >= 15) {
      await persistRateUsage(false);
    }
  }

  async function enforceWatchGuardFast() {
    const probeToken = ++watchGuardProbeToken;
    ensureRateUsageCurrentDay();

    if (!isWatchPage() || !settings.enforceWatchGuard) {
      setWatchGuardHidden(false);
      return;
    }

    setWatchGuardHidden(true);
    const identity = await resolveCurrentWatchIdentity();

    if (probeToken !== watchGuardProbeToken) {
      return;
    }

    if (identity && !isWhitelistedForWatchGuard(identity)) {
      log("Blocking watch page (fast guard) for blocked channel", identity);
      redirectToSubscriptions();
      return;
    }

    setWatchGuardHidden(false);
  }

  function enforceWatchGuard() {
    ensureRateUsageCurrentDay();

    if (!settings.enforceWatchGuard || !isWatchPage()) {
      setWatchGuardHidden(false);
      return;
    }

    const identity = extractCurrentWatchIdentity();
    if (!identity) return;

    if (!isWhitelistedForWatchGuard(identity)) {
      log("Blocking watch page for blocked channel", identity);
      redirectToSubscriptions();
      return;
    }

    setWatchGuardHidden(false);
  }

  function scheduleWatchGuard() {
    enforceWatchGuardFast().catch((err) => log("Fast watch guard failed", err));

    if (watchGuardTimer) {
      clearTimeout(watchGuardTimer);
    }
    watchGuardTimer = setTimeout(() => {
      enforceWatchGuard();
      forceFilterRecommendations();
    }, 50);
  }

  function startObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      const skipWhitelist = settings.whitelistSubscriptionsByDefault && isSubscriptionsPage();
      const failClosed = isSearchPage();
      syncPlaybackVideoElement();

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;

          if (shouldTreatAsVideoTile(node)) {
            filterTile(node, { skipWhitelist, excludeRecommendations: isWatchPage(), failClosed });
          }

          const closestTile = node.closest ? node.closest(TILE_SELECTORS.join(",")) : null;
          if (closestTile instanceof HTMLElement) {
            filterTile(closestTile, { skipWhitelist, excludeRecommendations: isWatchPage(), failClosed });
          }

          filterExistingTiles(node, { skipWhitelist, excludeRecommendations: isWatchPage(), failClosed });
          removeShortsSections(node);
        });
      }

      scheduleSubscriptionsBootstrap();

      if (isWatchPage()) {
        forceFilterRecommendations();
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function onRouteChange() {
    ensureRateUsageCurrentDay();
    persistRateUsage(true).catch((err) => log("Persist on route change failed", err));
    clearExemptPlaybackIfVideoChanged();

    if (isHomePage()) {
      redirectToSubscriptions();
      return;
    }

    if (shouldBlockByPath()) {
      redirectToSubscriptions();
      return;
    }

    if (isWatchPage()) {
      startRecommendationsTicker();
      startPlaybackTicker();
      syncPlaybackVideoElement();
    } else {
      stopRecommendationsTicker();
      stopPlaybackTicker();
      syncPlaybackVideoElement();
    }

    const skipWhitelist = settings.whitelistSubscriptionsByDefault && isSubscriptionsPage();
    const failClosed = isSearchPage();

    scheduleWatchGuard();
    filterExistingTiles(document, { skipWhitelist, excludeRecommendations: isWatchPage(), failClosed });
    removeShortsSections(document);
    scheduleSubscriptionsBootstrap();
    forceFilterRecommendations();
  }

  function toBooleanLike(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
    }
    return null;
  }

  function getSubscribeButtonState(button) {
    try {
      if (!(button instanceof HTMLElement)) return "unknown";

      const host = button.closest("ytd-subscribe-button-renderer, yt-subscribe-button-view-model, ytm-subscribe-button-renderer");

      if (button.matches("[disabled], [aria-disabled='true']") || button.closest("[disabled], [aria-disabled='true']")) {
        return "disabled";
      }

      const pressedRaw =
        button.getAttribute("aria-pressed") ||
        host?.getAttribute("aria-pressed") ||
        button.closest("[aria-pressed]")?.getAttribute("aria-pressed") ||
        "";

      const pressed = toBooleanLike(pressedRaw);
      if (pressed === true) return "already-subscribed";
      if (pressed === false) return "ready-to-subscribe";

      if (host instanceof HTMLElement) {
        const subscribedAttr = host.getAttribute("subscribed");
        const parsedSubscribed = toBooleanLike(subscribedAttr || "");
        if (parsedSubscribed === true) return "already-subscribed";
        if (parsedSubscribed === false) return "ready-to-subscribe";

        if (host.hasAttribute("subscribed") && !(subscribedAttr || "").trim()) {
          return "already-subscribed";
        }

        const isSubscribedAttr = host.getAttribute("is-subscribed");
        const parsedIsSubscribed = toBooleanLike(isSubscribedAttr || "");
        if (parsedIsSubscribed === true) return "already-subscribed";
        if (parsedIsSubscribed === false) return "ready-to-subscribe";
      }

      const text = [
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
        button.textContent || ""
      ].join(" ").toLowerCase();

      if (text.includes("subscribed") || text.includes("unsubscribe")) {
        return "already-subscribed";
      }
      if (text.includes("subscribe")) {
        return "ready-to-subscribe";
      }

      return "unknown";
    } catch {
      return "unknown";
    }
  }

  function getSubscribeActionElement(node) {
    if (!(node instanceof HTMLElement)) return null;

    if (node.matches("button, tp-yt-paper-button, [role='button']")) {
      return node;
    }

    const nested = node.querySelector("button, tp-yt-paper-button, [role='button']");
    return nested instanceof HTMLElement ? nested : node;
  }

  function findBestSubscribeButton() {
    const selectors = [
      "ytd-subscribe-button-renderer button",
      "ytd-subscribe-button-renderer tp-yt-paper-button",
      "yt-subscribe-button-view-model button",
      "ytm-subscribe-button-renderer button",
      "ytd-subscribe-button-renderer",
      "yt-subscribe-button-view-model",
      "ytm-subscribe-button-renderer"
    ];

    const candidates = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const actionEl = getSubscribeActionElement(node);
        if (actionEl instanceof HTMLElement && actionEl.isConnected) {
          candidates.push(actionEl);
        }
      });
    }

    const unique = [...new Set(candidates)];
    let disabledMatch = null;
    let unknownMatch = null;

    for (const button of unique) {
      const state = getSubscribeButtonState(button);

      if (state === "ready-to-subscribe" || state === "already-subscribed") {
        return { button, state };
      }

      if (state === "disabled" && !disabledMatch) {
        disabledMatch = { button, state };
      }

      if (state === "unknown" && !unknownMatch) {
        unknownMatch = { button, state };
      }
    }

    return disabledMatch || unknownMatch || null;
  }

  async function findSubscribeButtonWithRetry(timeoutMs = 1800, intervalMs = 120) {
    const startedAt = Date.now();
    let disabledMatch = null;
    let unknownMatch = null;

    while (Date.now() - startedAt < timeoutMs) {
      const match = findBestSubscribeButton();
      if (match) {
        if (match.state === "ready-to-subscribe" || match.state === "already-subscribed") {
          return match;
        }

        if (match.state === "disabled" && !disabledMatch) {
          disabledMatch = match;
        }

        if (match.state === "unknown" && !unknownMatch) {
          unknownMatch = match;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return disabledMatch || unknownMatch || null;
  }
  async function getCurrentSubscribeState() {
    const identity = getCurrentPageIdentity();
    const hasIdentity = Boolean(identity && (identity.channelId || identity.handle));

    const match = await findSubscribeButtonWithRetry();
    if (!match) {
      return { ok: true, state: hasIdentity ? "button-not-found" : "no-channel" };
    }

    if (match.state === "already-subscribed") {
      return { ok: true, state: "subscribed" };
    }

    if (match.state === "ready-to-subscribe") {
      return { ok: true, state: "not-subscribed" };
    }

    if (match.state === "disabled") {
      return { ok: true, state: "disabled" };
    }

    return { ok: true, state: "button-not-found" };
  }

  async function subscribeCurrentPageChannel() {
    const identity = getCurrentPageIdentity();
    if (!identity || (!identity.channelId && !identity.handle)) {
      return { ok: false, reason: "no-channel" };
    }

    const match = await findSubscribeButtonWithRetry();
    if (!match) {
      return { ok: false, reason: "subscribe-button-not-found" };
    }

    if (match.state === "disabled") {
      return { ok: false, reason: "disabled" };
    }

    if (match.state === "already-subscribed") {
      return { ok: true, alreadySubscribed: true };
    }

    match.button.click();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterState = await getCurrentSubscribeState();
    if (afterState.state === "subscribed") {
      return { ok: true, subscribed: true };
    }

    if (afterState.state === "disabled") {
      return { ok: false, reason: "disabled" };
    }

    if (afterState.state === "not-subscribed") {
      return { ok: false, reason: "subscribe-did-not-stick" };
    }

    return { ok: false, reason: "subscribe-button-not-found" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "BRIGHTSTREAM_GET_CURRENT_CHANNEL") {
      sendResponse({ identity: getCurrentPageIdentity() });
      return true;
    }

    if (message.type === "BRIGHTSTREAM_SETTINGS_UPDATED") {
      loadSettings().then(() => {
        onRouteChange();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === "BRIGHTSTREAM_GET_CURRENT_SUBSCRIBE_STATE") {
      getCurrentSubscribeState()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, state: "button-not-found" }));
      return true;
    }

    if (message.type === "BRIGHTSTREAM_SUBSCRIBE_CURRENT_CHANNEL") {
      subscribeCurrentPageChannel()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, reason: "subscribe-failed" }));
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes[SETTINGS_KEY]) {
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      onRouteChange();
      return;
    }

    if (areaName === "local" && changes[RATE_USAGE_KEY]) {
      rateUsage = normalizeRateUsage(changes[RATE_USAGE_KEY].newValue);
      applyFiltersForCurrentPage();
    }
  });

  async function init() {
    if (isWatchPage()) {
      setWatchGuardHidden(true);
    }


    if (isHomePage()) {
      redirectToSubscriptions();
      return;
    }
    await Promise.all([loadSettings(), loadRateUsage()]);

    if (shouldBlockByPath()) {
      redirectToSubscriptions();
      return;
    }

    startObserver();
    onRouteChange();

    window.addEventListener("yt-navigate-start", onNavigateStart, true);
    window.addEventListener("yt-navigate-finish", onRouteChange, true);
    window.addEventListener("yt-page-data-updated", onRouteChange, true);

    // Intercept watch-link navigation as early as possible.
    document.addEventListener("pointerdown", maybeBlockWatchNavFromEvent, true);
    document.addEventListener("mousedown", maybeBlockWatchNavFromEvent, true);
    document.addEventListener("touchstart", maybeBlockWatchNavFromEvent, true);
    document.addEventListener("click", maybeBlockWatchNavFromEvent, true);
    document.addEventListener("auxclick", maybeBlockWatchNavFromEvent, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      maybeBlockWatchNavFromEvent(event);
    }, true);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        persistRateUsage(true).catch((err) => log("Persist on visibilitychange failed", err));
      }
    }, true);

    window.addEventListener("pagehide", () => {
      persistRateUsage(true).catch((err) => log("Persist on pagehide failed", err));
    }, true);
  }

  init().catch((err) => {
    console.error("[BrightStream] init failed", err);
  });

  window.BrightStreamFilter = {
    loadSettings,
    saveSettings,
    getCurrentPageIdentity
  };
})();
