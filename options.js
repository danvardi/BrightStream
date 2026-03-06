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

  const modeEl = document.getElementById("mode");
  const blockShortsEl = document.getElementById("blockShorts");
  const enforceWatchGuardEl = document.getElementById("enforceWatchGuard");
  const whitelistSubscriptionsEl = document.getElementById("whitelistSubscriptionsByDefault");
  const channelIdsEl = document.getElementById("channelIds");
  const handlesEl = document.getElementById("handles");
  const statusEl = document.getElementById("status");

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

  function render(settings) {
    modeEl.value = settings.mode;
    blockShortsEl.checked = settings.blockShorts;
    enforceWatchGuardEl.checked = settings.enforceWatchGuard;
    whitelistSubscriptionsEl.checked = settings.whitelistSubscriptionsByDefault;
    channelIdsEl.value = settings.channelIds.join("\n");
    handlesEl.value = settings.handles.join("\n");
  }

  function collectForm() {
    return normalizeSettings({
      version: 2,
      mode: modeEl.value,
      blockShorts: blockShortsEl.checked,
      enforceWatchGuard: enforceWatchGuardEl.checked,
      whitelistSubscriptionsByDefault: whitelistSubscriptionsEl.checked,
      channelIds: parseLines(channelIdsEl.value, (x) => x),
      handles: parseLines(handlesEl.value, normalizeHandle)
    });
  }

  async function onSave() {
    const next = collectForm();
    await saveSettings(next);
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

    document.getElementById("exportBtn").addEventListener("click", onExport);

    const importBtn = document.getElementById("importBtn");
    const importFile = document.getElementById("importFile");

    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;

      onImportFile(file).catch((err) => setStatus(err.message || "Import failed.", true));
      importFile.value = "";
    });
  }

  init().catch((err) => setStatus(err.message || "Options init failed.", true));
})();
