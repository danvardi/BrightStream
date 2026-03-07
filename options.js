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

  const modeEl = document.getElementById("mode");
  const blockShortsEl = document.getElementById("blockShorts");
  const enforceWatchGuardEl = document.getElementById("enforceWatchGuard");
  const whitelistSubscriptionsEl = document.getElementById("whitelistSubscriptionsByDefault");
  const channelIdsEl = document.getElementById("channelIds");
  const handlesEl = document.getElementById("handles");
  const rateLimitsBodyEl = document.getElementById("rateLimitsBody");
  const rateLimitsTableEl = document.getElementById("rateLimitsTable");
  const rateLimitsEmptyEl = document.getElementById("rateLimitsEmpty");
  const statusEl = document.getElementById("status");

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

  function normalizeSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    merged.version = 3;
    merged.channelIds = [...new Set((merged.channelIds || []).map(normalizeChannelId).filter(Boolean))];
    merged.handles = [...new Set((merged.handles || []).map(normalizeHandle).filter(Boolean))];
    merged.channelRateLimitsMinutesByKey = normalizeRateLimitMap(merged.channelRateLimitsMinutesByKey);
    merged.mode = merged.mode === "lenient" ? "lenient" : "strict";
    merged.whitelistSubscriptionsByDefault = merged.whitelistSubscriptionsByDefault !== false;

    const allowedKeys = new Set(getWhitelistRateLimitKeys(merged.channelIds, merged.handles));
    merged.channelRateLimitsMinutesByKey = Object.fromEntries(
      Object.entries(merged.channelRateLimitsMinutesByKey).filter(([key]) => allowedKeys.has(key))
    );

    return merged;
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

  function collectRateLimitDraftValues() {
    const draft = {};
    rateLimitsBodyEl.querySelectorAll("input[data-rate-key]").forEach((input) => {
      const key = normalizeRateLimitKey(input.dataset.rateKey || "");
      const value = (input.value || "").trim();
      if (!key || !value) return;
      draft[key] = value;
    });
    return draft;
  }

  function getWhitelistDraftFromForm() {
    return {
      channelIds: parseLines(channelIdsEl.value, normalizeChannelId),
      handles: parseLines(handlesEl.value, normalizeHandle)
    };
  }

  function renderRateLimitRows(channelIds, handles, valueMap = {}) {
    const keys = getWhitelistRateLimitKeys(channelIds, handles);
    rateLimitsBodyEl.innerHTML = "";

    if (!keys.length) {
      rateLimitsTableEl.hidden = true;
      rateLimitsEmptyEl.hidden = false;
      return;
    }

    rateLimitsTableEl.hidden = false;
    rateLimitsEmptyEl.hidden = true;

    keys.forEach((key) => {
      const tr = document.createElement("tr");

      const labelTd = document.createElement("td");
      labelTd.textContent = labelForRateLimitKey(key);

      const inputTd = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "1440";
      input.step = "1";
      input.placeholder = "Unlimited";
      input.dataset.rateKey = key;
      const rawValue = valueMap[key];
      if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
        input.value = String(rawValue);
      }
      inputTd.appendChild(input);

      tr.appendChild(labelTd);
      tr.appendChild(inputTd);
      rateLimitsBodyEl.appendChild(tr);
    });
  }

  function rerenderRateLimitsFromDraft() {
    const draftValues = collectRateLimitDraftValues();
    const draftWhitelist = getWhitelistDraftFromForm();
    renderRateLimitRows(draftWhitelist.channelIds, draftWhitelist.handles, draftValues);
  }

  function render(settings) {
    modeEl.value = settings.mode;
    blockShortsEl.checked = settings.blockShorts;
    enforceWatchGuardEl.checked = settings.enforceWatchGuard;
    whitelistSubscriptionsEl.checked = settings.whitelistSubscriptionsByDefault;
    channelIdsEl.value = settings.channelIds.join("\n");
    handlesEl.value = settings.handles.join("\n");
    renderRateLimitRows(settings.channelIds, settings.handles, settings.channelRateLimitsMinutesByKey);
  }

  function collectRateLimitsForKeys(allowedKeys) {
    const values = {};

    allowedKeys.forEach((key) => {
      const input = rateLimitsBodyEl.querySelector(`input[data-rate-key="${CSS.escape(key)}"]`);
      if (!input) return;

      const rawValue = (input.value || "").trim();
      if (!rawValue) return;

      const minutes = normalizeRateLimitMinutes(rawValue);
      if (minutes === null) {
        throw new Error(`Invalid daily minutes for ${labelForRateLimitKey(key)}. Use 1-1440.`);
      }
      values[key] = minutes;
    });

    return values;
  }

  function collectForm() {
    const channelIds = parseLines(channelIdsEl.value, normalizeChannelId);
    const handles = parseLines(handlesEl.value, normalizeHandle);
    const allowedKeys = getWhitelistRateLimitKeys(channelIds, handles);

    return normalizeSettings({
      version: 3,
      mode: modeEl.value,
      blockShorts: blockShortsEl.checked,
      enforceWatchGuard: enforceWatchGuardEl.checked,
      whitelistSubscriptionsByDefault: whitelistSubscriptionsEl.checked,
      channelIds,
      handles,
      channelRateLimitsMinutesByKey: collectRateLimitsForKeys(allowedKeys)
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
    const normalized = normalizeSettings(parsed);
    render(normalized);
    await saveSettings(normalized);
    setStatus("Imported and saved.");
  }

  async function init() {
    const settings = await getSettings();
    render(settings);

    document.getElementById("saveBtn").addEventListener("click", () => {
      onSave().catch((err) => setStatus(err.message || "Save failed.", true));
    });

    document.getElementById("exportBtn").addEventListener("click", () => {
      try {
        onExport();
      } catch (err) {
        setStatus(err.message || "Export failed.", true);
      }
    });

    const importBtn = document.getElementById("importBtn");
    const importFile = document.getElementById("importFile");

    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;

      onImportFile(file).catch((err) => setStatus(err.message || "Import failed.", true));
      importFile.value = "";
    });

    channelIdsEl.addEventListener("input", rerenderRateLimitsFromDraft);
    handlesEl.addEventListener("input", rerenderRateLimitsFromDraft);
  }

  init().catch((err) => setStatus(err.message || "Options init failed.", true));
})();