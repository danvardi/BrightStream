(() => {
  const SUBS_URL = "https://www.youtube.com/feed/subscriptions";
  const HIDE_STYLE_ID = "brightstream-short-block-style";

  function normalizePath(pathname) {
    return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
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

  function shouldRedirectToSubs(url) {
    const path = normalizePath(url.pathname);
    const isRoot = path === "" || path === "/";
    return isRoot || isBlockedShortsPath(path);
  }

  function ensureShortsHidden() {
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

  function enforce() {
    const current = new URL(window.location.href);
    if (isBlockedShortsPath(current.pathname)) {
      ensureShortsHidden();
    }

    if (shouldRedirectToSubs(current) && current.href !== SUBS_URL) {
      window.location.replace(SUBS_URL);
      return;
    }

    clearHidden();
  }

  function wrapHistory(methodName) {
    const original = history[methodName];
    history[methodName] = function wrappedState(...args) {
      const result = original.apply(this, args);
      enforce();
      return result;
    };
  }

  function hrefTargetsBlockedShorts(href) {
    if (!href) return false;
    try {
      const url = new URL(href, window.location.origin);
      return isBlockedShortsPath(url.pathname);
    } catch {
      return false;
    }
  }

  function findAnchorFromEvent(event) {
    return event.target instanceof Element ? event.target.closest("a[href]") : null;
  }

  function blockShortsNavFromEvent(event) {
    const anchor = findAnchorFromEvent(event);
    if (!anchor) return;

    const href = anchor.getAttribute("href") || "";
    if (!hrefTargetsBlockedShorts(href)) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    ensureShortsHidden();
    window.location.replace(SUBS_URL);
  }

  enforce();
  wrapHistory("pushState");
  wrapHistory("replaceState");

  window.addEventListener("yt-navigate-start", (event) => {
    const url = event?.detail?.url || "";
    if (hrefTargetsBlockedShorts(url)) {
      event.preventDefault?.();
      ensureShortsHidden();
      window.location.replace(SUBS_URL);
      return;
    }
    enforce();
  }, true);

  window.addEventListener("popstate", enforce, true);
  window.addEventListener("hashchange", enforce, true);

  // Intercept as early as possible to avoid Shorts first frame.
  document.addEventListener("pointerdown", blockShortsNavFromEvent, true);
  document.addEventListener("mousedown", blockShortsNavFromEvent, true);
  document.addEventListener("touchstart", blockShortsNavFromEvent, true);
  document.addEventListener("click", blockShortsNavFromEvent, true);
  document.addEventListener("auxclick", blockShortsNavFromEvent, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    blockShortsNavFromEvent(event);
  }, true);
})();
