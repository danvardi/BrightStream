(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
  const DEFAULTS = {
    version: 2,
    mode: "strict",
    channelIds: [],
    handles: [],
    blockShorts: true,
    enforceWatchGuard: true,
    parentLockEnabled: false,
    pinHash: "",
    debug: false
  };

  let settings = { ...DEFAULTS };
  let observer = null;
  let watchGuardTimer = null;

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

  function shouldBlockByPath() {
    const path = getPathname();
    return settings.blockShorts && path.startsWith("/shorts/");
  }

  function redirectToSubscriptions() {
    const target = "https://www.youtube.com/feed/subscriptions";
    if (window.location.href !== target) {
      window.location.replace(target);
    }
  }

  function isWhitelisted(identity) {
    if (!identity) return false;
    const channelIdAllowed = Boolean(identity.channelId && settings.channelIds.includes(identity.channelId));
    const handleAllowed = Boolean(identity.handle && settings.handles.includes(identity.handle));
    return settings.mode === "strict" ? channelIdAllowed : (channelIdAllowed || handleAllowed);
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

    return {
      channelId,
      handle
    };
  }

  function getChannelLinkFromTile(tile) {
    if (!tile) return null;

    const selectors = [
      "a.yt-simple-endpoint.yt-formatted-string[href*='/channel/']",
      "a.yt-simple-endpoint.yt-formatted-string[href^='/@']",
      "ytd-channel-name a[href*='/channel/']",
      "ytd-channel-name a[href^='/@']",
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

  function removeNode(node) {
    if (!node || !node.isConnected) return;
    node.remove();
  }

  function isShortsTile(tile) {
    if (!settings.blockShorts) return false;
    const links = tile.querySelectorAll("a[href]");
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (href.includes("/shorts/")) return true;
    }

    const text = (tile.textContent || "").toLowerCase();
    return text.includes("shorts");
  }

  function shouldTreatAsVideoTile(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    return [
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-playlist-video-renderer",
      "ytd-reel-shelf-renderer",
      "ytd-reel-item-renderer",
      "ytd-rich-shelf-renderer",
      "ytd-compact-radio-renderer",
      "ytd-compact-playlist-renderer"
    ].includes(tag);
  }

  function filterTile(tile) {
    if (!tile || !tile.isConnected) return;

    if (isShortsTile(tile)) {
      removeNode(tile);
      return;
    }

    const channelHref = getChannelLinkFromTile(tile);
    const identity = extractIdentityFromUrl(channelHref);

    if (!isWhitelisted(identity)) {
      removeNode(tile);
    }
  }

  function filterExistingTiles(root = document) {
    const selectors = [
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

    const nodes = root.querySelectorAll(selectors.join(","));
    nodes.forEach(filterTile);
  }

  function forceFilterRecommendations() {
    if (!isWatchPage()) return;

    const recommendationSelectors = [
      "#secondary ytd-compact-video-renderer",
      "#related ytd-compact-video-renderer",
      "#items ytd-compact-video-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer",
      "ytd-player ytd-endscreen ytd-end-screen-video-renderer"
    ];

    for (const selector of recommendationSelectors) {
      document.querySelectorAll(selector).forEach(filterTile);
    }
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
    if (!isWhitelisted(identity)) {
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
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;

          if (shouldTreatAsVideoTile(node)) {
            filterTile(node);
          }

          filterExistingTiles(node);
        });
      }

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

    scheduleWatchGuard();
    filterExistingTiles(document);
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
