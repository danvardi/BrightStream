(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
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

  const messageEl = document.getElementById("message");
  const statusEl = document.getElementById("channelStatus");
  const addBtn = document.getElementById("addBtn");
  const removeBtn = document.getElementById("removeBtn");
  const optionsBtn = document.getElementById("optionsBtn");

  let currentIdentity = null;

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

  function toRateKeyFromChannelId(channelId) {
    const normalized = normalizeChannelId(channelId);
    return normalized ? `id:${normalized}` : "";
  }

  function toRateKeyFromHandle(handle) {
    const normalized = normalizeHandle(handle);
    return normalized ? `handle:${normalized}` : "";
  }

  async function getSettings() {
    const data = await chrome.storage.sync.get([SETTINGS_KEY]);
    return normalizeSettings(data[SETTINGS_KEY]);
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
  }

  function setMessage(text, isError = false) {
    messageEl.textContent = text;
    messageEl.style.color = isError ? "#b00020" : "#1b5e20";
  }

  function describeIdentity(identity) {
    if (!identity) return "Channel: unavailable";
    const parts = [];
    if (identity.channelId) parts.push(identity.channelId);
    if (identity.handle) parts.push(identity.handle);
    return `Channel: ${parts.join(" | ") || "unavailable"}`;
  }

  async function getCurrentTabIdentity() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id || !tab.url || !tab.url.includes("youtube.com")) {
      return null;
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "BRIGHTSTREAM_GET_CURRENT_CHANNEL"
    }).catch(() => null);

    return response?.identity || null;
  }

  async function notifyActiveTabRefresh() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id || !tab.url || !tab.url.includes("youtube.com")) return;

    await chrome.tabs.sendMessage(tab.id, { type: "BRIGHTSTREAM_SETTINGS_UPDATED" }).catch(() => null);
  }

  async function addCurrentChannel() {
    if (!currentIdentity || (!currentIdentity.channelId && !currentIdentity.handle)) {
      setMessage("No channel found on this page.", true);
      return;
    }

    const settings = await getSettings();
    if (currentIdentity.channelId) {
      settings.channelIds = [...new Set([...settings.channelIds, currentIdentity.channelId])];
    }
    if (currentIdentity.handle) {
      settings.handles = [...new Set([...settings.handles, normalizeHandle(currentIdentity.handle)])];
    }

    await saveSettings(settings);
    await notifyActiveTabRefresh();
    setMessage("Channel added to whitelist.");
  }

  async function removeCurrentChannel() {
    if (!currentIdentity || (!currentIdentity.channelId && !currentIdentity.handle)) {
      setMessage("No channel found on this page.", true);
      return;
    }

    const settings = await getSettings();
    if (currentIdentity.channelId) {
      settings.channelIds = settings.channelIds.filter((id) => id !== currentIdentity.channelId);
    }
    if (currentIdentity.handle) {
      const handle = normalizeHandle(currentIdentity.handle);
      settings.handles = settings.handles.filter((h) => h !== handle);
    }

    const nextRateLimits = { ...(settings.channelRateLimitsMinutesByKey || {}) };
    const idKey = toRateKeyFromChannelId(currentIdentity.channelId || "");
    const handleKey = toRateKeyFromHandle(currentIdentity.handle || "");
    if (idKey) delete nextRateLimits[idKey];
    if (handleKey) delete nextRateLimits[handleKey];
    settings.channelRateLimitsMinutesByKey = nextRateLimits;

    await saveSettings(settings);
    await notifyActiveTabRefresh();
    setMessage("Channel removed from whitelist.");
  }

  async function init() {
    currentIdentity = await getCurrentTabIdentity();
    statusEl.textContent = describeIdentity(currentIdentity);

    addBtn.addEventListener("click", () => {
      addCurrentChannel().catch((err) => setMessage(err.message || "Failed to add channel.", true));
    });

    removeBtn.addEventListener("click", () => {
      removeCurrentChannel().catch((err) => setMessage(err.message || "Failed to remove channel.", true));
    });

    optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }

  init().catch((err) => setMessage(err.message || "Popup init failed.", true));
})();