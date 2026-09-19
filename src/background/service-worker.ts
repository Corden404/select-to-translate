const STORAGE_KEY = "autoLookupEnabled";

async function getEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEY]: true });
  return stored[STORAGE_KEY] !== false;
}

async function updateBadge(enabled: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  await chrome.action.setTitle({
    title: enabled ? "Automatic lookup is on" : "Automatic lookup is off"
  });
}

async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  await updateBadge(enabled);
}

async function toggleEnabled(): Promise<void> {
  await setEnabled(!(await getEnabled()));
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (typeof stored[STORAGE_KEY] !== "boolean") {
    await chrome.storage.local.set({ [STORAGE_KEY]: true });
  }
  await updateBadge(await getEnabled());
});

chrome.runtime.onStartup.addListener(async () => {
  await updateBadge(await getEnabled());
});

chrome.commands.onCommand.addListener(command => {
  if (command === "toggle-auto-lookup") {
    void toggleEnabled();
  }
});

chrome.action.onClicked.addListener(() => {
  void toggleEnabled();
});
