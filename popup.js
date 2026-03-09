(() => {
  const SETTINGS_KEY = "ytWhitelistSettings";
  const DEFAULT_OPEN_GROUP_ID = "open";
  const DEFAULT_RATE_LIMIT_GROUPS = Object.freeze({
    open: Object.freeze({ name: "Open", minutes: null }),
    "30min": Object.freeze({ name: "30 min", minutes: 30 }),
    "60min": Object.freeze({ name: "60 min", minutes: 60 })
  });
  const RESERVED_GROUP_IDS = new Set(Object.keys(DEFAULT_RATE_LIMIT_GROUPS));

  const DEFAULTS = {
    version: 4,
    mode: "strict",
    channelIds: [],
    handles: [],
    rateLimitGroupsById: {},
    channelRateLimitGroupByKey: {},
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

  function toRateKeyFromChannelId(channelId) {
    const normalized = normalizeChannelId(channelId);
    return normalized ? `id:${normalized}` : "";
  }

  function toRateKeyFromHandle(handle) {
    const normalized = normalizeHandle(handle);
    return normalized ? `handle:${normalized}` : "";
  }

  function getWhitelistRateLimitKeys(channelIds, handles) {
    const keys = [];

    for (const channelId of channelIds || []) {
      const key = toRateKeyFromChannelId(channelId);
      if (key) keys.push(key);
    }

    for (const handle of handles || []) {
      const key = toRateKeyFromHandle(handle);
      if (key) keys.push(key);
    }

    return [...new Set(keys)];
  }

  function normalizeRateLimitMinutes(value) {
    if (value === null) return null;
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

  function normalizeRateLimitGroupId(value) {
    if (!value) return "";
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "");
  }

  function normalizeGroupName(value, fallbackMinutes = null) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
    if (fallbackMinutes === null) return "Open";
    return `${fallbackMinutes} min`;
  }

  function getDefaultRateLimitGroups() {
    return {
      open: { name: DEFAULT_RATE_LIMIT_GROUPS.open.name, minutes: null },
      "30min": { name: DEFAULT_RATE_LIMIT_GROUPS["30min"].name, minutes: 30 },
      "60min": { name: DEFAULT_RATE_LIMIT_GROUPS["60min"].name, minutes: 60 }
    };
  }

  function normalizeRateLimitGroups(raw) {
    const normalized = getDefaultRateLimitGroups();
    if (!raw || typeof raw !== "object") return normalized;

    for (const [rawGroupId, rawGroup] of Object.entries(raw)) {
      const groupId = normalizeRateLimitGroupId(rawGroupId);
      if (!groupId || RESERVED_GROUP_IDS.has(groupId)) continue;
      if (!rawGroup || typeof rawGroup !== "object") continue;

      const minutes = normalizeRateLimitMinutes(rawGroup.minutes);
      if (minutes === null && rawGroup.minutes !== null) continue;

      normalized[groupId] = {
        name: normalizeGroupName(rawGroup.name, minutes),
        minutes
      };
    }

    return normalized;
  }

  function normalizeChannelRateLimitGroupMap(raw, validGroupIds) {
    if (!raw || typeof raw !== "object") return {};
    const normalized = {};

    for (const [rawKey, rawGroupId] of Object.entries(raw)) {
      const key = normalizeRateLimitKey(rawKey);
      const groupId = normalizeRateLimitGroupId(rawGroupId);
      if (!key || !groupId) continue;
      if (validGroupIds && !validGroupIds.has(groupId)) continue;
      normalized[key] = groupId;
    }

    return normalized;
  }

  function findGroupIdByMinutes(groupsById, minutes) {
    for (const [groupId, group] of Object.entries(groupsById || {})) {
      if (group && group.minutes === minutes) {
        return groupId;
      }
    }
    return "";
  }

  function makeUniqueCustomGroupId(baseId, groupsById) {
    const normalizedBase = normalizeRateLimitGroupId(baseId) || "group";
    if (!groupsById[normalizedBase]) return normalizedBase;

    let suffix = 2;
    while (groupsById[`${normalizedBase}-${suffix}`]) {
      suffix += 1;
    }
    return `${normalizedBase}-${suffix}`;
  }

  function applyLegacyRateLimitGroupAssignments(groupsById, groupByKey, legacyLimitMap, allowedKeys) {
    const nextGroupsById = { ...(groupsById || {}) };
    const nextGroupByKey = { ...(groupByKey || {}) };

    for (const [key, minutes] of Object.entries(legacyLimitMap || {})) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      if (nextGroupByKey[key]) continue;

      let groupId = findGroupIdByMinutes(nextGroupsById, minutes);
      if (!groupId) {
        const baseId = `${minutes}min`;
        groupId = makeUniqueCustomGroupId(baseId, nextGroupsById);
        nextGroupsById[groupId] = {
          name: `${minutes} min`,
          minutes
        };
      }
      nextGroupByKey[key] = groupId;
    }

    return { groupsById: nextGroupsById, groupByKey: nextGroupByKey };
  }

  function normalizeSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    merged.version = 4;
    merged.channelIds = [...new Set((merged.channelIds || []).map(normalizeChannelId).filter(Boolean))];
    merged.handles = [...new Set((merged.handles || []).map(normalizeHandle).filter(Boolean))];
    merged.mode = merged.mode === "lenient" ? "lenient" : "strict";
    merged.whitelistSubscriptionsByDefault = merged.whitelistSubscriptionsByDefault !== false;
    merged.rateLimitGroupsById = normalizeRateLimitGroups(merged.rateLimitGroupsById);

    const validGroupIds = new Set(Object.keys(merged.rateLimitGroupsById));
    merged.channelRateLimitGroupByKey = normalizeChannelRateLimitGroupMap(
      merged.channelRateLimitGroupByKey,
      validGroupIds
    );

    const allowedKeys = new Set(getWhitelistRateLimitKeys(merged.channelIds, merged.handles));
    merged.channelRateLimitGroupByKey = Object.fromEntries(
      Object.entries(merged.channelRateLimitGroupByKey).filter(([key]) => allowedKeys.has(key))
    );

    const legacyMap = normalizeRateLimitMap(merged.channelRateLimitsMinutesByKey);
    if (Object.keys(legacyMap).length > 0) {
      const migrated = applyLegacyRateLimitGroupAssignments(
        merged.rateLimitGroupsById,
        merged.channelRateLimitGroupByKey,
        legacyMap,
        allowedKeys
      );
      merged.rateLimitGroupsById = migrated.groupsById;
      merged.channelRateLimitGroupByKey = migrated.groupByKey;
    }

    for (const key of allowedKeys) {
      if (!merged.channelRateLimitGroupByKey[key]) {
        merged.channelRateLimitGroupByKey[key] = DEFAULT_OPEN_GROUP_ID;
      }
    }

    delete merged.channelRateLimitsMinutesByKey;
    return merged;
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

  async function trySubscribeCurrentChannelOnActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id || !tab.url || !tab.url.includes("youtube.com")) {
      return { ok: false, reason: "tab-not-youtube" };
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "BRIGHTSTREAM_SUBSCRIBE_CURRENT_CHANNEL"
    }).catch(() => null);

    return response || { ok: false, reason: "no-response" };
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
    const subscribeResult = await trySubscribeCurrentChannelOnActiveTab();
    await notifyActiveTabRefresh();

    if (subscribeResult?.subscribed) {
      setMessage("Channel added to whitelist and subscribed on YouTube.");
      return;
    }

    if (subscribeResult?.alreadySubscribed) {
      setMessage("Channel added to whitelist. Already subscribed on YouTube.");
      return;
    }

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

    const nextAssignments = { ...(settings.channelRateLimitGroupByKey || {}) };
    const idKey = toRateKeyFromChannelId(currentIdentity.channelId || "");
    const handleKey = toRateKeyFromHandle(currentIdentity.handle || "");
    if (idKey) delete nextAssignments[idKey];
    if (handleKey) delete nextAssignments[handleKey];
    settings.channelRateLimitGroupByKey = nextAssignments;
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

