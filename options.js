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

  const SUB_STATUS = {
    UNKNOWN: "Unknown",
    CHECKING: "Checking",
    SUBSCRIBED: "Subscribed",
    NOT_SUBSCRIBED: "Not subscribed",
    UNAVAILABLE: "Unavailable",
    ERROR: "Error"
  };

  const MESSAGE_TIMEOUT_MS = 4200;
  const MESSAGE_RETRY_INTERVAL_MS = 120;
  const TASK_GAP_MS = 180;
  const TAB_START_DELAY_MS = 80;

  const modeEl = document.getElementById("mode");
  const blockShortsEl = document.getElementById("blockShorts");
  const enforceWatchGuardEl = document.getElementById("enforceWatchGuard");
  const whitelistSubscriptionsEl = document.getElementById("whitelistSubscriptionsByDefault");
  const channelIdsEl = document.getElementById("channelIds");
  const handlesEl = document.getElementById("handles");
  const rateLimitsBodyEl = document.getElementById("rateLimitsBody");
  const rateLimitsTableEl = document.getElementById("rateLimitsTable");
  const rateLimitsEmptyEl = document.getElementById("rateLimitsEmpty");
  const rateLimitGroupsBodyEl = document.getElementById("rateLimitGroupsBody");
  const rateLimitGroupsEmptyEl = document.getElementById("rateLimitGroupsEmpty");
  const addRateLimitGroupBtnEl = document.getElementById("addRateLimitGroupBtn");
  const refreshSubscriptionStatusBtnEl = document.getElementById("refreshSubscriptionStatusBtn");
  const subscribeAllBtnEl = document.getElementById("subscribeAllBtn");
  const cancelSubscriptionRunBtnEl = document.getElementById("cancelSubscriptionRunBtn");
  const saveBtnEl = document.getElementById("saveBtn");
  const exportBtnEl = document.getElementById("exportBtn");
  const importBtnEl = document.getElementById("importBtn");
  const importFileEl = document.getElementById("importFile");
  const statusEl = document.getElementById("status");

  let subscriptionStatusByKey = {};
  let subscriptionRunInProgress = false;
  let subscriptionCancelRequested = false;

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

  function isDefaultGroupId(groupId) {
    return RESERVED_GROUP_IDS.has(groupId);
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

  function labelForRateLimitKey(key) {
    if (key.startsWith("id:")) {
      return `ID: ${key.slice(3)}`;
    }
    if (key.startsWith("handle:")) {
      return `Handle: ${key.slice(7)}`;
    }
    return key;
  }

  function labelForGroup(groupId, group) {
    if (!group) return groupId;
    if (group.minutes === null) return `${group.name} (Unlimited)`;
    return `${group.name} (${group.minutes} min)`;
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

  function getOrderedGroupEntries(groupsById) {
    const entries = [];
    ["open", "30min", "60min"].forEach((groupId) => {
      const group = groupsById[groupId];
      if (group) {
        entries.push([groupId, group]);
      }
    });

    const custom = Object.entries(groupsById)
      .filter(([groupId]) => !RESERVED_GROUP_IDS.has(groupId))
      .sort((a, b) => a[0].localeCompare(b[0]));

    return [...entries, ...custom];
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

  function isLegacyImportPayload(raw) {
    if (!raw || typeof raw !== "object") return false;
    const hasLegacy = Boolean(raw.channelRateLimitsMinutesByKey && typeof raw.channelRateLimitsMinutesByKey === "object");
    const hasGroups = Boolean(raw.rateLimitGroupsById || raw.channelRateLimitGroupByKey);
    return hasLegacy && !hasGroups;
  }

  function normalizeLegacyImport(raw, existingSettings) {
    return normalizeSettings({
      ...raw,
      version: 4,
      rateLimitGroupsById: { ...(existingSettings.rateLimitGroupsById || {}) },
      channelRateLimitGroupByKey: {}
    });
  }

  async function getSettings() {
    const data = await chrome.storage.sync.get([SETTINGS_KEY]);
    return normalizeSettings(data[SETTINGS_KEY]);
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
  }

  function parseLines(text, transform = (x) => x) {
    return [...new Set(
      text
        .split(/\r?\n/)
        .map((line) => transform(line.trim()))
        .filter(Boolean)
    )];
  }

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#b00020" : "#1b5e20";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRunActive() {
    return subscriptionRunInProgress;
  }

  function isCancelRequested() {
    return subscriptionCancelRequested;
  }

  function getCurrentTableKeys() {
    return [...rateLimitsBodyEl.querySelectorAll("select[data-channel-key]")]
      .map((select) => normalizeRateLimitKey(select.dataset.channelKey || ""))
      .filter(Boolean);
  }

  function getSubscriptionStatus(key) {
    return subscriptionStatusByKey[key] || SUB_STATUS.UNKNOWN;
  }

  function syncSubscriptionStatusKeys(keys) {
    const next = {};
    keys.forEach((key) => {
      next[key] = subscriptionStatusByKey[key] || SUB_STATUS.UNKNOWN;
    });
    subscriptionStatusByKey = next;
  }

  function setSubscriptionStatus(key, nextStatus) {
    if (!key) return;
    subscriptionStatusByKey[key] = nextStatus;
    renderSubscriptionRowState(key);
  }

  function setRunActive(next) {
    subscriptionRunInProgress = Boolean(next);
    if (!subscriptionRunInProgress) {
      subscriptionCancelRequested = false;
    }
    renderSubscriptionControls();
    getCurrentTableKeys().forEach(renderSubscriptionRowState);
  }

  function requestCancelRun() {
    if (!isRunActive()) return;
    subscriptionCancelRequested = true;
    renderSubscriptionControls();
    setStatus("Stopping after current channel...");
  }

  function collectRateLimitDraftValues() {
    const draft = {};
    rateLimitsBodyEl.querySelectorAll("select[data-channel-key]").forEach((select) => {
      const key = normalizeRateLimitKey(select.dataset.channelKey || "");
      const groupId = normalizeRateLimitGroupId(select.value || DEFAULT_OPEN_GROUP_ID);
      if (!key) return;
      draft[key] = groupId || DEFAULT_OPEN_GROUP_ID;
    });
    return draft;
  }

  function getWhitelistDraftFromForm() {
    return {
      channelIds: parseLines(channelIdsEl.value, normalizeChannelId),
      handles: parseLines(handlesEl.value, normalizeHandle)
    };
  }

  function readRateLimitGroupsFromDom({ strict = false } = {}) {
    const groupsById = getDefaultRateLimitGroups();

    if (!rateLimitGroupsBodyEl) return groupsById;

    rateLimitGroupsBodyEl.querySelectorAll("tr[data-group-id]").forEach((row) => {
      const groupId = normalizeRateLimitGroupId(row.dataset.groupId || "");
      if (!groupId || isDefaultGroupId(groupId)) return;

      const nameInput = row.querySelector(`input[data-group-name-id="${CSS.escape(groupId)}"]`);
      const minutesInput = row.querySelector(`input[data-group-minutes-id="${CSS.escape(groupId)}"]`);

      const rawName = typeof nameInput?.value === "string" ? nameInput.value : "";
      const rawMinutes = (minutesInput?.value || "").trim();
      const minutes = normalizeRateLimitMinutes(rawMinutes);

      if (minutes === null) {
        if (strict) {
          throw new Error(`Invalid minutes for group ${groupId}. Use 1-1440.`);
        }

        const fallback = normalizeRateLimitMinutes(minutesInput?.dataset.lastValidMinutes || "");
        if (fallback === null) return;
        groupsById[groupId] = {
          name: normalizeGroupName(rawName, fallback),
          minutes: fallback
        };
        return;
      }

      if (minutesInput) {
        minutesInput.dataset.lastValidMinutes = String(minutes);
      }

      groupsById[groupId] = {
        name: normalizeGroupName(rawName, minutes),
        minutes
      };
    });

    return groupsById;
  }

  function renderSubscriptionRowState(key) {
    const escapedKey = CSS.escape(key);
    const statusNode = rateLimitsBodyEl.querySelector(`[data-sub-status-key="${escapedKey}"]`);
    const actionButton = rateLimitsBodyEl.querySelector(`[data-sub-action-key="${escapedKey}"]`);
    const status = getSubscriptionStatus(key);

    if (statusNode) {
      statusNode.textContent = status;
      statusNode.dataset.subStatus = status.toLowerCase().replace(/\s+/g, "-");
    }

    if (!actionButton) return;

    let label = "Recheck";
    let disabled = isRunActive();

    if (status === SUB_STATUS.CHECKING) {
      label = "Checking...";
      disabled = true;
    } else if (status === SUB_STATUS.SUBSCRIBED) {
      label = "Subscribed";
      disabled = true;
    } else if (status === SUB_STATUS.NOT_SUBSCRIBED) {
      label = "Subscribe";
      disabled = isRunActive();
    }

    actionButton.textContent = label;
    actionButton.disabled = disabled;
  }

  function renderSubscriptionControls() {
    const hasRows = getCurrentTableKeys().length > 0;
    const disabled = isRunActive();

    refreshSubscriptionStatusBtnEl.disabled = disabled || !hasRows;
    subscribeAllBtnEl.disabled = disabled || !hasRows;

    if (cancelSubscriptionRunBtnEl) {
      cancelSubscriptionRunBtnEl.hidden = !disabled;
      cancelSubscriptionRunBtnEl.disabled = !disabled || isCancelRequested();
    }

    modeEl.disabled = disabled;
    blockShortsEl.disabled = disabled;
    enforceWatchGuardEl.disabled = disabled;
    whitelistSubscriptionsEl.disabled = disabled;
    channelIdsEl.disabled = disabled;
    handlesEl.disabled = disabled;
    saveBtnEl.disabled = disabled;
    exportBtnEl.disabled = disabled;
    importBtnEl.disabled = disabled;

    rateLimitsBodyEl.querySelectorAll("select[data-channel-key]").forEach((select) => {
      select.disabled = disabled;
    });

    if (rateLimitGroupsBodyEl) {
      rateLimitGroupsBodyEl.querySelectorAll("input,button").forEach((node) => {
        node.disabled = disabled;
      });
    }

    if (addRateLimitGroupBtnEl) {
      addRateLimitGroupBtnEl.disabled = disabled;
    }
  }

  function renderRateLimitGroups(groupsById) {
    if (!rateLimitGroupsBodyEl) return;

    const entries = getOrderedGroupEntries(groupsById);
    rateLimitGroupsBodyEl.innerHTML = "";

    entries.forEach(([groupId, group]) => {
      const tr = document.createElement("tr");
      tr.dataset.groupId = groupId;

      const nameTd = document.createElement("td");
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.dataset.groupNameId = groupId;
      nameInput.value = group.name;
      nameInput.disabled = isDefaultGroupId(groupId);
      nameTd.appendChild(nameInput);

      const minutesTd = document.createElement("td");
      if (group.minutes === null) {
        const span = document.createElement("span");
        span.textContent = "Unlimited";
        minutesTd.appendChild(span);
      } else {
        const minutesInput = document.createElement("input");
        minutesInput.type = "number";
        minutesInput.min = "1";
        minutesInput.max = "1440";
        minutesInput.step = "1";
        minutesInput.dataset.groupMinutesId = groupId;
        minutesInput.dataset.lastValidMinutes = String(group.minutes);
        minutesInput.value = String(group.minutes);
        minutesInput.disabled = isDefaultGroupId(groupId);
        minutesTd.appendChild(minutesInput);
      }

      const actionTd = document.createElement("td");
      if (isDefaultGroupId(groupId)) {
        actionTd.textContent = "Default";
      } else {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.dataset.deleteGroupId = groupId;
        deleteBtn.textContent = "Delete";
        actionTd.appendChild(deleteBtn);
      }

      tr.appendChild(nameTd);
      tr.appendChild(minutesTd);
      tr.appendChild(actionTd);
      rateLimitGroupsBodyEl.appendChild(tr);
    });

    if (rateLimitGroupsEmptyEl) {
      const hasCustom = Object.keys(groupsById).some((groupId) => !isDefaultGroupId(groupId));
      rateLimitGroupsEmptyEl.hidden = hasCustom;
    }
  }

  function renderRateLimitRows(channelIds, handles, assignmentMap = {}, groupsById = getDefaultRateLimitGroups()) {
    const keys = getWhitelistRateLimitKeys(channelIds, handles);
    syncSubscriptionStatusKeys(keys);

    rateLimitsBodyEl.innerHTML = "";

    if (!keys.length) {
      rateLimitsTableEl.hidden = true;
      rateLimitsEmptyEl.hidden = false;
      renderSubscriptionControls();
      return;
    }

    rateLimitsTableEl.hidden = false;
    rateLimitsEmptyEl.hidden = true;

    const groupEntries = getOrderedGroupEntries(groupsById);

    keys.forEach((key) => {
      const tr = document.createElement("tr");

      const labelTd = document.createElement("td");
      labelTd.textContent = labelForRateLimitKey(key);

      const groupTd = document.createElement("td");
      const select = document.createElement("select");
      select.dataset.channelKey = key;

      groupEntries.forEach(([groupId, group]) => {
        const option = document.createElement("option");
        option.value = groupId;
        option.textContent = labelForGroup(groupId, group);
        select.appendChild(option);
      });

      const assignedGroup = normalizeRateLimitGroupId(assignmentMap[key]) || DEFAULT_OPEN_GROUP_ID;
      select.value = groupsById[assignedGroup] ? assignedGroup : DEFAULT_OPEN_GROUP_ID;
      groupTd.appendChild(select);

      const statusTd = document.createElement("td");
      const statusNode = document.createElement("span");
      statusNode.dataset.subStatusKey = key;
      statusTd.appendChild(statusNode);

      const actionTd = document.createElement("td");
      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.dataset.subActionKey = key;
      actionTd.appendChild(actionButton);

      tr.appendChild(labelTd);
      tr.appendChild(groupTd);
      tr.appendChild(statusTd);
      tr.appendChild(actionTd);
      rateLimitsBodyEl.appendChild(tr);

      renderSubscriptionRowState(key);
    });

    renderSubscriptionControls();
  }

  function rerenderRateLimitsFromDraft() {
    const draftAssignments = collectRateLimitDraftValues();
    const groupsById = readRateLimitGroupsFromDom({ strict: false });
    const draftWhitelist = getWhitelistDraftFromForm();
    renderRateLimitRows(draftWhitelist.channelIds, draftWhitelist.handles, draftAssignments, groupsById);
  }

  function rerenderAllFromDraft() {
    const draftAssignments = collectRateLimitDraftValues();
    const draftWhitelist = getWhitelistDraftFromForm();
    const groupsById = readRateLimitGroupsFromDom({ strict: false });

    renderRateLimitGroups(groupsById);
    renderRateLimitRows(draftWhitelist.channelIds, draftWhitelist.handles, draftAssignments, groupsById);
  }

  function collectChannelGroupAssignments(allowedKeys, groupsById) {
    const values = {};

    allowedKeys.forEach((key) => {
      const select = rateLimitsBodyEl.querySelector(`select[data-channel-key="${CSS.escape(key)}"]`);
      const selectedGroupId = normalizeRateLimitGroupId(select?.value || "") || DEFAULT_OPEN_GROUP_ID;
      values[key] = groupsById[selectedGroupId] ? selectedGroupId : DEFAULT_OPEN_GROUP_ID;
    });

    return values;
  }

  function collectForm() {
    const channelIds = parseLines(channelIdsEl.value, normalizeChannelId);
    const handles = parseLines(handlesEl.value, normalizeHandle);
    const allowedKeys = getWhitelistRateLimitKeys(channelIds, handles);
    const rateLimitGroupsById = readRateLimitGroupsFromDom({ strict: true });

    return normalizeSettings({
      version: 4,
      mode: modeEl.value,
      blockShorts: blockShortsEl.checked,
      enforceWatchGuard: enforceWatchGuardEl.checked,
      whitelistSubscriptionsByDefault: whitelistSubscriptionsEl.checked,
      channelIds,
      handles,
      rateLimitGroupsById,
      channelRateLimitGroupByKey: collectChannelGroupAssignments(allowedKeys, rateLimitGroupsById)
    });
  }

  function render(settings) {
    modeEl.value = settings.mode;
    blockShortsEl.checked = settings.blockShorts;
    enforceWatchGuardEl.checked = settings.enforceWatchGuard;
    whitelistSubscriptionsEl.checked = settings.whitelistSubscriptionsByDefault;
    channelIdsEl.value = settings.channelIds.join("\n");
    handlesEl.value = settings.handles.join("\n");

    renderRateLimitGroups(settings.rateLimitGroupsById);
    renderRateLimitRows(
      settings.channelIds,
      settings.handles,
      settings.channelRateLimitGroupByKey,
      settings.rateLimitGroupsById
    );
  }

  function addCustomRateLimitGroup() {
    const groupsById = readRateLimitGroupsFromDom({ strict: false });
    const nextId = makeUniqueCustomGroupId("custom", groupsById);
    groupsById[nextId] = {
      name: "Custom",
      minutes: 15
    };

    const draftAssignments = collectRateLimitDraftValues();
    const draftWhitelist = getWhitelistDraftFromForm();

    renderRateLimitGroups(groupsById);
    renderRateLimitRows(draftWhitelist.channelIds, draftWhitelist.handles, draftAssignments, groupsById);
  }

  function deleteRateLimitGroup(groupId) {
    const normalizedGroupId = normalizeRateLimitGroupId(groupId);
    if (!normalizedGroupId || isDefaultGroupId(normalizedGroupId)) return;

    const groupsById = readRateLimitGroupsFromDom({ strict: false });
    if (!groupsById[normalizedGroupId]) return;
    delete groupsById[normalizedGroupId];

    const draftAssignments = collectRateLimitDraftValues();
    Object.keys(draftAssignments).forEach((key) => {
      if (draftAssignments[key] === normalizedGroupId) {
        draftAssignments[key] = DEFAULT_OPEN_GROUP_ID;
      }
    });

    const draftWhitelist = getWhitelistDraftFromForm();
    renderRateLimitGroups(groupsById);
    renderRateLimitRows(draftWhitelist.channelIds, draftWhitelist.handles, draftAssignments, groupsById);
  }

  function keyToChannelUrl(key) {
    if (key.startsWith("id:")) {
      const id = normalizeChannelId(key.slice(3));
      return id ? `https://www.youtube.com/channel/${encodeURIComponent(id)}` : "";
    }

    if (key.startsWith("handle:")) {
      const handle = normalizeHandle(key.slice(7));
      return handle ? `https://www.youtube.com/${encodeURI(handle)}` : "";
    }

    return "";
  }

  async function sendMessageWithRetry(tabId, message, timeoutMs = MESSAGE_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (isCancelRequested()) {
        return { canceled: true, response: null };
      }

      const response = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
      if (response !== null && response !== undefined) {
        return { canceled: false, response };
      }
      await delay(MESSAGE_RETRY_INTERVAL_MS);
    }

    return { canceled: false, response: null };
  }

  function mapSubscribeStateToUiStatus(state) {
    if (state === "subscribed") return SUB_STATUS.SUBSCRIBED;
    if (state === "not-subscribed") return SUB_STATUS.NOT_SUBSCRIBED;
    if (state === "disabled" || state === "no-channel") return SUB_STATUS.UNAVAILABLE;
    if (state === "button-not-found") return SUB_STATUS.UNKNOWN;
    return SUB_STATUS.ERROR;
  }

  function mapSubscribeActionResponseToUiStatus(response) {
    if (response?.subscribed || response?.alreadySubscribed) {
      return SUB_STATUS.SUBSCRIBED;
    }

    if (response?.reason === "disabled" || response?.reason === "no-channel") {
      return SUB_STATUS.UNAVAILABLE;
    }

    if (response?.reason === "subscribe-button-not-found" || response?.reason === "subscribe-did-not-stick") {
      return SUB_STATUS.UNKNOWN;
    }

    return SUB_STATUS.ERROR;
  }

  async function runChannelTask(key, mode) {
    const channelUrl = keyToChannelUrl(key);
    if (!channelUrl) {
      return { ok: false, reason: "invalid-key" };
    }

    let tabId = null;
    let previousActiveTabId = null;

    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      previousActiveTabId = activeTabs?.[0]?.id || null;

      const tab = await chrome.tabs.create({ url: channelUrl, active: true });
      tabId = tab?.id || null;
      if (!tabId) {
        return { ok: false, reason: "tab-create-failed" };
      }

      await delay(TAB_START_DELAY_MS + 260);

      if (mode === "check") {
        const sent = await sendMessageWithRetry(tabId, {
          type: "BRIGHTSTREAM_GET_CURRENT_SUBSCRIBE_STATE"
        });

        if (sent.canceled) {
          return { ok: false, canceled: true, reason: "canceled" };
        }

        if (!sent.response || typeof sent.response.state !== "string") {
          return { ok: false, reason: "check-no-response" };
        }

        let state = sent.response.state;

        if (state === "button-not-found" || state === "no-channel") {
          await delay(320);
          const sentSecondPass = await sendMessageWithRetry(tabId, {
            type: "BRIGHTSTREAM_GET_CURRENT_SUBSCRIBE_STATE"
          }, 2600);

          if (sentSecondPass.canceled) {
            return { ok: false, canceled: true, reason: "canceled" };
          }

          if (sentSecondPass.response && typeof sentSecondPass.response.state === "string") {
            state = sentSecondPass.response.state;
          }
        }

        return { ok: true, mode, state };
      }

      if (mode === "subscribe") {
        const sent = await sendMessageWithRetry(tabId, {
          type: "BRIGHTSTREAM_SUBSCRIBE_CURRENT_CHANNEL"
        });

        if (sent.canceled) {
          return { ok: false, canceled: true, reason: "canceled" };
        }

        if (!sent.response || typeof sent.response !== "object") {
          return { ok: false, reason: "subscribe-no-response" };
        }

        return { ok: true, mode, response: sent.response };
      }

      return { ok: false, reason: "invalid-mode" };
    } catch (err) {
      return { ok: false, reason: err?.message || "task-failed" };
    } finally {
      if (tabId) {
        await chrome.tabs.remove(tabId).catch(() => null);
      }

      if (previousActiveTabId && previousActiveTabId !== tabId) {
        await chrome.tabs.update(previousActiveTabId, { active: true }).catch(() => null);
      }

      await delay(TASK_GAP_MS);
    }
  }

  async function checkSubscriptionForKey(key) {
    const previousStatus = getSubscriptionStatus(key);
    setSubscriptionStatus(key, SUB_STATUS.CHECKING);
    const result = await runChannelTask(key, "check");

    if (result.canceled) {
      setSubscriptionStatus(key, previousStatus === SUB_STATUS.CHECKING ? SUB_STATUS.UNKNOWN : previousStatus);
      return { status: getSubscriptionStatus(key), canceled: true };
    }

    if (!result.ok) {
      setSubscriptionStatus(key, SUB_STATUS.ERROR);
      return { status: SUB_STATUS.ERROR, canceled: false };
    }

    const status = mapSubscribeStateToUiStatus(result.state);
    setSubscriptionStatus(key, status);
    return { status, canceled: false };
  }

  async function subscribeForKey(key) {
    const previousStatus = getSubscriptionStatus(key);
    setSubscriptionStatus(key, SUB_STATUS.CHECKING);
    const result = await runChannelTask(key, "subscribe");

    if (result.canceled) {
      setSubscriptionStatus(key, previousStatus === SUB_STATUS.CHECKING ? SUB_STATUS.UNKNOWN : previousStatus);
      return { status: getSubscriptionStatus(key), canceled: true };
    }

    if (!result.ok) {
      setSubscriptionStatus(key, SUB_STATUS.ERROR);
      return { status: SUB_STATUS.ERROR, canceled: false };
    }

    const status = mapSubscribeActionResponseToUiStatus(result.response);
    setSubscriptionStatus(key, status);
    return { status, canceled: false };
  }

  function summarizeStatuses(keys) {
    const counts = {
      subscribed: 0,
      notSubscribed: 0,
      unavailable: 0,
      errors: 0,
      unknown: 0
    };

    keys.forEach((key) => {
      const status = getSubscriptionStatus(key);
      if (status === SUB_STATUS.SUBSCRIBED) counts.subscribed += 1;
      else if (status === SUB_STATUS.NOT_SUBSCRIBED) counts.notSubscribed += 1;
      else if (status === SUB_STATUS.UNAVAILABLE) counts.unavailable += 1;
      else if (status === SUB_STATUS.ERROR) counts.errors += 1;
      else counts.unknown += 1;
    });

    return counts;
  }

  async function runWithLock(work) {
    if (isRunActive()) {
      setStatus("A subscription task is already running.", true);
      return false;
    }

    subscriptionCancelRequested = false;
    setRunActive(true);
    try {
      await work();
      return true;
    } finally {
      setRunActive(false);
    }
  }

  async function onRefreshSubscriptionStatuses() {
    const keys = getCurrentTableKeys();
    if (!keys.length) {
      setStatus("No whitelisted channels to check.", true);
      return;
    }

    await runWithLock(async () => {
      for (let index = 0; index < keys.length; index += 1) {
        if (isCancelRequested()) {
          setStatus("Run stopped.");
          return;
        }

        const key = keys[index];
        setStatus(`Refreshing statuses ${index + 1}/${keys.length}: ${labelForRateLimitKey(key)}`);
        const result = await checkSubscriptionForKey(key);
        if (result.canceled) {
          setStatus("Run stopped.");
          return;
        }
      }

      const summary = summarizeStatuses(keys);
      setStatus(
        `Refresh complete. Subscribed: ${summary.subscribed}, Not subscribed: ${summary.notSubscribed}, Unavailable: ${summary.unavailable}, Errors: ${summary.errors}.`,
        summary.errors > 0
      );
    });
  }

  async function onSubscribeAllNotSubscribed() {
    const keys = getCurrentTableKeys();
    if (!keys.length) {
      setStatus("No whitelisted channels to subscribe.", true);
      return;
    }

    await runWithLock(async () => {
      const unknownKeys = keys.filter((key) => getSubscriptionStatus(key) === SUB_STATUS.UNKNOWN);

      for (let index = 0; index < unknownKeys.length; index += 1) {
        if (isCancelRequested()) {
          setStatus("Run stopped.");
          return;
        }

        const key = unknownKeys[index];
        setStatus(`Pre-checking ${index + 1}/${unknownKeys.length}: ${labelForRateLimitKey(key)}`);
        const result = await checkSubscriptionForKey(key);
        if (result.canceled) {
          setStatus("Run stopped.");
          return;
        }
      }

      const targets = keys.filter((key) => getSubscriptionStatus(key) === SUB_STATUS.NOT_SUBSCRIBED);

      if (!targets.length) {
        const summary = summarizeStatuses(keys);
        setStatus(
          `No channels need subscription. Subscribed: ${summary.subscribed}, Unavailable: ${summary.unavailable}, Errors: ${summary.errors}.`,
          summary.errors > 0
        );
        return;
      }

      for (let index = 0; index < targets.length; index += 1) {
        if (isCancelRequested()) {
          setStatus("Run stopped.");
          return;
        }

        const key = targets[index];
        setStatus(`Subscribing ${index + 1}/${targets.length}: ${labelForRateLimitKey(key)}`);
        const result = await subscribeForKey(key);
        if (result.canceled) {
          setStatus("Run stopped.");
          return;
        }
      }

      const summary = summarizeStatuses(keys);
      setStatus(
        `Subscribe-all complete. Subscribed: ${summary.subscribed}, Not subscribed: ${summary.notSubscribed}, Unavailable: ${summary.unavailable}, Errors: ${summary.errors}.`,
        summary.errors > 0
      );
    });
  }

  async function onRowActionClick(key) {
    const normalizedKey = normalizeRateLimitKey(key);
    if (!normalizedKey) return;

    const keys = getCurrentTableKeys();
    if (!keys.includes(normalizedKey)) return;

    await runWithLock(async () => {
      if (isCancelRequested()) {
        setStatus("Run stopped.");
        return;
      }

      const status = getSubscriptionStatus(normalizedKey);
      let result;

      if (status === SUB_STATUS.NOT_SUBSCRIBED) {
        setStatus(`Subscribing: ${labelForRateLimitKey(normalizedKey)}`);
        result = await subscribeForKey(normalizedKey);
      } else {
        setStatus(`Checking: ${labelForRateLimitKey(normalizedKey)}`);
        result = await checkSubscriptionForKey(normalizedKey);
      }

      if (result.canceled) {
        setStatus("Run stopped.");
        return;
      }

      const finalStatus = getSubscriptionStatus(normalizedKey);
      const isError = finalStatus === SUB_STATUS.ERROR;
      setStatus(`${labelForRateLimitKey(normalizedKey)} status: ${finalStatus}.`, isError);
    });
  }

  async function onSave() {
    const next = collectForm();
    await saveSettings(next);
    render(next);
    setStatus("Settings saved.");
  }

  function onExport() {
    const payload = JSON.stringify(collectForm(), null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "brightstream-whitelist.json";
    a.click();

    URL.revokeObjectURL(url);
    setStatus("Exported JSON.");
  }

  async function onImportFile(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);

    let normalized;
    if (isLegacyImportPayload(parsed)) {
      const existing = await getSettings();
      normalized = normalizeLegacyImport(parsed, existing);
    } else {
      normalized = normalizeSettings(parsed);
    }

    render(normalized);
    await saveSettings(normalized);
    setStatus("Imported and saved.");
  }

  async function init() {
    const settings = await getSettings();
    render(settings);

    saveBtnEl.addEventListener("click", () => {
      onSave().catch((err) => setStatus(err.message || "Save failed.", true));
    });

    exportBtnEl.addEventListener("click", () => {
      try {
        onExport();
      } catch (err) {
        setStatus(err.message || "Export failed.", true);
      }
    });

    importBtnEl.addEventListener("click", () => importFileEl.click());
    importFileEl.addEventListener("change", () => {
      const file = importFileEl.files && importFileEl.files[0];
      if (!file) return;

      onImportFile(file).catch((err) => setStatus(err.message || "Import failed.", true));
      importFileEl.value = "";
    });

    refreshSubscriptionStatusBtnEl.addEventListener("click", () => {
      onRefreshSubscriptionStatuses().catch((err) => {
        setStatus(err.message || "Failed to refresh statuses.", true);
      });
    });

    subscribeAllBtnEl.addEventListener("click", () => {
      onSubscribeAllNotSubscribed().catch((err) => {
        setStatus(err.message || "Failed to subscribe all.", true);
      });
    });

    if (cancelSubscriptionRunBtnEl) {
      cancelSubscriptionRunBtnEl.addEventListener("click", () => {
        requestCancelRun();
      });
    }

    rateLimitsBodyEl.addEventListener("click", (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest("button[data-sub-action-key]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      onRowActionClick(button.dataset.subActionKey || "").catch((err) => {
        setStatus(err.message || "Subscription action failed.", true);
      });
    });

    if (rateLimitGroupsBodyEl) {
      rateLimitGroupsBodyEl.addEventListener("click", (event) => {
        const button = event.target instanceof HTMLElement ? event.target.closest("button[data-delete-group-id]") : null;
        if (!(button instanceof HTMLButtonElement)) return;
        deleteRateLimitGroup(button.dataset.deleteGroupId || "");
      });

      rateLimitGroupsBodyEl.addEventListener("change", () => {
        rerenderAllFromDraft();
      });
    }

    if (addRateLimitGroupBtnEl) {
      addRateLimitGroupBtnEl.addEventListener("click", () => {
        addCustomRateLimitGroup();
      });
    }

    channelIdsEl.addEventListener("input", rerenderRateLimitsFromDraft);
    handlesEl.addEventListener("input", rerenderRateLimitsFromDraft);
  }

  init().catch((err) => setStatus(err.message || "Options init failed.", true));
})();
