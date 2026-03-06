(() => {
  const SUBS_URL = "https://www.youtube.com/feed/subscriptions";

  function normalizePath(pathname) {
    return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  }

  function shouldRedirectToSubs(url) {
    const path = normalizePath(url.pathname);
    const isRoot = path === "" || path === "/";
    const isShorts = path.startsWith("/shorts/");
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
})();
