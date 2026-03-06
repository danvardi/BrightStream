(() => {
  const SUBS_URL = "https://www.youtube.com/feed/subscriptions";

  function normalizePath(pathname) {
    return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  }

  function shouldRedirectToSubs(url) {
    const path = normalizePath(url.pathname);
    const isRoot = path === "" || path === "/";
    const isShorts = path === "/shorts" || path.startsWith("/shorts/");
    return isRoot || isShorts;
  }

  function enforce() {
    const current = new URL(window.location.href);
    if (shouldRedirectToSubs(current) && current.href !== SUBS_URL) {
      window.location.replace(SUBS_URL);
    }
  }

  enforce();
  window.addEventListener("yt-navigate-start", enforce, true);

  // Prevent in-page Shorts navigation so playback never starts.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target) return;

    const href = target.getAttribute("href") || "";
    if (href === "/shorts" || href.startsWith("/shorts/")) {
      event.preventDefault();
      event.stopPropagation();
      window.location.replace(SUBS_URL);
    }
  }, true);
})();
