(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
  const SUBS_URL = "https://www.youtube.com/feed/subscriptions";
  const TILE_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-compact-radio-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-reel-shelf-renderer",
    "ytd-reel-item-renderer"
  ];

  const DEFAULTS = {
    version: 2,
    mode: "strict",
    channelIds: [],
    handles: [],
    blockShorts: true,
    enforceWatchGuard: true,
    whitelistSubscriptionsByDefault: true,
    parentLockEnabled: false,
    pinHash: "",
    debug: false
  };

  let settings = { ...DEFAULTS };
  let observer = null;
  let watchGuardTimer = null;
  let bootstrapTimer = null;
  let recommendationsTicker = null;

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

  function normalizeSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    merged.channelIds = [...new Set((merged.channelIds || []).map(normalizeChannelId).filter(Boolean))];
    merged.handles = [...new Set((merged.handles || []).map(normalizeHandle).filter(Boolean))];
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

  function getPathname() {
    return window.location.pathname || "";
  }

  function isWatchPage() {
    return getPathname() === "/watch";
  }

  function isSubscriptionsPage() {
    return getPathname().startsWith("/feed/subscriptions");
  }

  function shouldBlockByPath() {
    const path = getPathname();
    if (!settings.blockShorts) return false;
    const isShortsPath = path === "/shorts" || path.startsWith("/shorts/");
    const isSubscriptionsShorts = path === "/feed/subscriptions/shorts" || path.startsWith("/feed/subscriptions/shorts/");
    return isShortsPath || isSubscriptionsShorts;
  }

  function redirectToSubscriptions() {
    if (window.location.href !== SUBS_URL) {
      window.location.replace(SUBS_URL);
    }
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
    if (isWhitelisted(identity)) return true;

    if (settings.whitelistSubscriptionsByDefault && identity.handle) {
      return settings.handles.includes(identity.handle);
    }

    return false;
  }

  function isWhitelistedForRecommendations(identity) {
    if (!identity) return false;
    const channelIdAllowed = Boolean(identity.channelId && settings.channelIds.includes(identity.channelId));
    const handleAllowed = Boolean(identity.handle && settings.handles.includes(identity.handle));
    return channelIdAllowed || handleAllowed;
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
    const browseId = normalizeChannelId(browseEndpoint?.browseId || "");

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

  function removeNode(node) {
    if (!node || !node.isConnected) return;
    node.remove();
  }

  function isShortsTile(tile) {
    if (!settings.blockShorts) return false;

    const links = tile.querySelectorAll("a[href]");
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (href.includes("/shorts/") || href === "/shorts") return true;
    }

    const text = (tile.textContent || "").toLowerCase();
    return text.includes("shorts");
  }

  function shouldTreatAsVideoTile(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    return TILE_SELECTORS.includes(el.tagName.toLowerCase());
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

    if (options.skipWhitelist) {
      return;
    }

    const recommendationMode = Boolean(options.recommendation || isRecommendationTile(tile));
    if (recommendationMode) {
      const identity = resolveTileIdentity(tile);
      if (!identity) {
        return;
      }
      if (!isWhitelistedForRecommendations(identity)) {
        removeNode(tile);
      }
      return;
    }

    const identity = resolveTileIdentity(tile);
    if (!identity) {
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

  function extractCurrentWatchIdentity() {
    const channelLink = document.querySelector(
      "ytd-watch-metadata ytd-channel-name a[href], #upload-info a[href], #owner a[href]"
    );

    if (!channelLink) return null;
    return extractIdentityFromUrl(channelLink.getAttribute("href"));
  }

  function enforceWatchGuard() {
    if (!settings.enforceWatchGuard || !isWatchPage()) return;
    const identity = extractCurrentWatchIdentity();

    if (!identity) return;
    if (!isWhitelistedForWatchGuard(identity)) {
      log("Blocking watch page for non-whitelisted channel", identity);
      redirectToSubscriptions();
    }
  }

  function scheduleWatchGuard() {
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

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;

          if (shouldTreatAsVideoTile(node)) {
            filterTile(node, { skipWhitelist, excludeRecommendations: isWatchPage() });
          }

          const closestTile = node.closest ? node.closest(TILE_SELECTORS.join(",")) : null;
          if (closestTile instanceof HTMLElement) {
            filterTile(closestTile, { skipWhitelist, excludeRecommendations: isWatchPage() });
          }

          filterExistingTiles(node, { skipWhitelist, excludeRecommendations: isWatchPage() });
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
    if (shouldBlockByPath()) {
      redirectToSubscriptions();
      return;
    }

    if (isWatchPage()) {
      startRecommendationsTicker();
    } else {
      stopRecommendationsTicker();
    }

    const skipWhitelist = settings.whitelistSubscriptionsByDefault && isSubscriptionsPage();

    scheduleWatchGuard();
    filterExistingTiles(document, { skipWhitelist, excludeRecommendations: isWatchPage() });
    scheduleSubscriptionsBootstrap();
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
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!changes[SETTINGS_KEY]) return;

    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    onRouteChange();
  });

  async function init() {
    await loadSettings();

    if (shouldBlockByPath()) {
      redirectToSubscriptions();
      return;
    }

    startObserver();
    onRouteChange();

    window.addEventListener("yt-navigate-finish", onRouteChange, true);
    window.addEventListener("yt-page-data-updated", onRouteChange, true);
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

