(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
  const SUBS_URL = "https://www.youtube.com/feed/subscriptions";
  const HIDE_STYLE_ID = "brightstream-short-block-style";

  const DEFAULTS = {
    mode: "strict",
    channelIds: [],
    handles: []
  };

  let settingsCache = null;
  let settingsPromise = null;
  let enforceToken = 0;

  function normalizePath(pathname) {
    return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
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

  function parseUrlLike(urlValue) {
    if (!urlValue) return null;
    try {
      return new URL(String(urlValue), window.location.origin);
    } catch {
      return null;
    }
  }

  function isBlockedShortsPath(pathname) {
    const path = normalizePath(pathname || "");
    return (
      path === "/shorts" ||
      path.startsWith("/shorts/") ||
      path === "/feed/subscriptions/shorts" ||
      path.startsWith("/feed/subscriptions/shorts/")
    );
  }

  function isRootPath(pathname) {
    const path = normalizePath(pathname || "");
    return path === "" || path === "/";
  }

  function isSubscriptionsPath(pathname) {
    return normalizePath(pathname || "") === "/feed/subscriptions";
  }

  function isChannelRootPath(pathname) {
    const path = normalizePath(pathname || "");
    const segments = path.split("/").filter(Boolean);
    const isHandleRoot = segments.length === 1 && segments[0].startsWith("@");
    const isChannelIdRoot = segments.length === 2 && segments[0] === "channel";
    return isHandleRoot || isChannelIdRoot;
  }

  function extractIdentityFromPath(pathname) {
    const path = normalizePath(pathname || "");
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

  function isWhitelisted(identity, settings) {
    if (!identity || !settings) return false;

    const channelIdAllowed = Boolean(identity.channelId && settings.channelIds.includes(identity.channelId));
    const handleAllowed = Boolean(identity.handle && settings.handles.includes(identity.handle));

    if (settings.mode === "strict") {
      return channelIdAllowed || (!identity.channelId && handleAllowed);
    }

    return channelIdAllowed || handleAllowed;
  }

  function shouldRedirectBlockedChannelUrl(url, settings) {
    if (!url || !isChannelRootPath(url.pathname)) return false;

    const identity = extractIdentityFromPath(url.pathname);
    if (!identity || (!identity.channelId && !identity.handle)) {
      return true;
    }

    return !isWhitelisted(identity, settings);
  }

  function loadSettingsCached() {
    if (settingsCache) {
      return Promise.resolve(settingsCache);
    }

    if (settingsPromise) {
      return settingsPromise;
    }

    settingsPromise = chrome.storage.sync.get([SETTINGS_KEY])
      .then((data) => {
        settingsCache = normalizeSettings(data?.[SETTINGS_KEY]);
        return settingsCache;
      })
      .catch(() => {
        settingsCache = normalizeSettings(null);
        return settingsCache;
      })
      .finally(() => {
        settingsPromise = null;
      });

    return settingsPromise;
  }

  function getCachedChannelRedirectDecision(url) {
    if (!settingsCache) return null;
    return shouldRedirectBlockedChannelUrl(url, settingsCache);
  }

  async function shouldRedirectBlockedChannelAsync(url) {
    const settings = await loadSettingsCached();
    return shouldRedirectBlockedChannelUrl(url, settings);
  }

  function shouldRedirectToSubsImmediate(url) {
    return isRootPath(url.pathname) || isBlockedShortsPath(url.pathname);
  }

  function ensureHidden() {
    if (document.getElementById(HIDE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HIDE_STYLE_ID;
    style.textContent = "html{visibility:hidden !important;}";
    (document.head || document.documentElement).appendChild(style);
  }

  function clearHidden() {
    const style = document.getElementById(HIDE_STYLE_ID);
    if (style) style.remove();
  }

  async function enforce() {
    const token = ++enforceToken;
    const current = new URL(window.location.href);

    if (isBlockedShortsPath(current.pathname) || isChannelRootPath(current.pathname)) {
      ensureHidden();
    }

    if (shouldRedirectToSubsImmediate(current) && !isSubscriptionsPath(current.pathname)) {
      window.location.replace(SUBS_URL);
      return;
    }

    const shouldRedirectChannel = await shouldRedirectBlockedChannelAsync(current);
    if (token !== enforceToken) return;

    if (shouldRedirectChannel && !isSubscriptionsPath(current.pathname)) {
      window.location.replace(SUBS_URL);
      return;
    }

    clearHidden();
  }

  function runEnforce() {
    enforce().catch(() => {
      // Fail closed when decision cannot be made on a channel root.
      const current = new URL(window.location.href);
      if (isChannelRootPath(current.pathname) && !isSubscriptionsPath(current.pathname)) {
        ensureHidden();
        window.location.replace(SUBS_URL);
      }
    });
  }

  function wrapHistory(methodName) {
    const original = history[methodName];
    history[methodName] = function wrappedState(...args) {
      const result = original.apply(this, args);
      runEnforce();
      return result;
    };
  }

  function hrefTargetsBlockedShorts(href) {
    const url = parseUrlLike(href);
    return Boolean(url && isBlockedShortsPath(url.pathname));
  }

  function findAnchorFromEvent(event) {
    return event.target instanceof Element ? event.target.closest("a[href]") : null;
  }

  function blockGuardedNavFromEvent(event) {
    const anchor = findAnchorFromEvent(event);
    if (!anchor) return;

    const href = anchor.getAttribute("href") || "";
    if (hrefTargetsBlockedShorts(href)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      ensureHidden();
      window.location.replace(SUBS_URL);
      return;
    }

    const targetUrl = parseUrlLike(href);
    if (!targetUrl || !isChannelRootPath(targetUrl.pathname)) return;

    const cachedDecision = getCachedChannelRedirectDecision(targetUrl);
    if (cachedDecision !== true) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    ensureHidden();
    window.location.replace(SUBS_URL);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!changes[SETTINGS_KEY]) return;
    settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
  });

  // Prime whitelist cache as early as possible.
  loadSettingsCached().catch(() => null);

  runEnforce();
  wrapHistory("pushState");
  wrapHistory("replaceState");

  window.addEventListener("yt-navigate-start", (event) => {
    const targetUrl = parseUrlLike(event?.detail?.url || "");

    if (targetUrl && isBlockedShortsPath(targetUrl.pathname)) {
      event.preventDefault?.();
      ensureHidden();
      window.location.replace(SUBS_URL);
      return;
    }

    if (targetUrl && isChannelRootPath(targetUrl.pathname)) {
      ensureHidden();

      const cachedDecision = getCachedChannelRedirectDecision(targetUrl);
      if (cachedDecision === true) {
        event.preventDefault?.();
        window.location.replace(SUBS_URL);
        return;
      }

      if (cachedDecision === false) {
        runEnforce();
        return;
      }

      shouldRedirectBlockedChannelAsync(targetUrl)
        .then((blocked) => {
          if (blocked) {
            window.location.replace(SUBS_URL);
            return;
          }
          runEnforce();
        })
        .catch(() => {
          window.location.replace(SUBS_URL);
        });
      return;
    }

    runEnforce();
  }, true);

  window.addEventListener("yt-navigate-finish", runEnforce, true);
  window.addEventListener("yt-page-data-updated", runEnforce, true);
  window.addEventListener("popstate", runEnforce, true);
  window.addEventListener("hashchange", runEnforce, true);

  // Intercept as early as possible to avoid blocked first frame.
  document.addEventListener("pointerdown", blockGuardedNavFromEvent, true);
  document.addEventListener("mousedown", blockGuardedNavFromEvent, true);
  document.addEventListener("touchstart", blockGuardedNavFromEvent, true);
  document.addEventListener("click", blockGuardedNavFromEvent, true);
  document.addEventListener("auxclick", blockGuardedNavFromEvent, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    blockGuardedNavFromEvent(event);
  }, true);

  // Fallback for rare SPA transitions where YouTube mutates URL without expected events.
  setInterval(runEnforce, 400);
})();
