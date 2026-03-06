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

  enforce();
  wrapHistory("pushState");
  wrapHistory("replaceState");

  window.addEventListener("yt-navigate-start", enforce, true);
  window.addEventListener("popstate", enforce, true);
  window.addEventListener("hashchange", enforce, true);

  // Prevent in-page Shorts navigation so playback never starts.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target) return;

    const href = target.getAttribute("href") || "";
    if (hrefTargetsBlockedShorts(href)) {
      event.preventDefault();
      event.stopPropagation();
      ensureShortsHidden();
      window.location.replace(SUBS_URL);
    }
  }, true);
})();
