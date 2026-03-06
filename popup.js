(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
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

  function normalizeSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    merged.channelIds = [...new Set((merged.channelIds || []).map((x) => (x || "").trim()).filter(Boolean))];
    merged.handles = [...new Set((merged.handles || []).map(normalizeHandle).filter(Boolean))];
    merged.mode = merged.mode === "lenient" ? "lenient" : "strict";
    merged.whitelistSubscriptionsByDefault = merged.whitelistSubscriptionsByDefault !== false;
    return merged;
  }

  async function getSettings() {
    const data = await chrome.storage.sync.get([SETTINGS_KEY]);
    return normalizeSettings(data[SETTINGS_KEY]);
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
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
