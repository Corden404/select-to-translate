import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_SENTENCE_PROMPT,
  DEFAULT_WORD_PROMPT,
  PROVIDER_PRESETS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  type ProviderId,
  type UiFontSize,
  type UiTheme
} from "../shared/settings";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const autoLookup = byId<HTMLInputElement>("autoLookup");
const provider = byId<HTMLSelectElement>("provider");
const providerNote = byId<HTMLParagraphElement>("providerNote");
const apiKey = byId<HTMLInputElement>("apiKey");
const toggleKey = byId<HTMLButtonElement>("toggleKey");
const baseUrl = byId<HTMLInputElement>("baseUrl");
const model = byId<HTMLInputElement>("model");
const modelSuggestions = byId<HTMLDataListElement>("modelSuggestions");
const theme = byId<HTMLSelectElement>("theme");
const fontSize = byId<HTMLSelectElement>("fontSize");
const wordPrompt = byId<HTMLTextAreaElement>("wordPrompt");
const sentencePrompt = byId<HTMLTextAreaElement>("sentencePrompt");
const resetPrompts = byId<HTMLButtonElement>("resetPrompts");
const save = byId<HTMLButtonElement>("save");
const status = byId<HTMLSpanElement>("status");

function selectedProvider(): ProviderId {
  const value = provider.value as ProviderId;
  return value in PROVIDER_PRESETS ? value : "custom";
}

function renderProviderDetails(): void {
  const preset = PROVIDER_PRESETS[selectedProvider()];
  providerNote.textContent = preset.note;
  modelSuggestions.replaceChildren(
    ...preset.modelSuggestions.map(value => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    })
  );
}

function applyPopupTheme(value: UiTheme): void {
  const resolved = value === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : value;
  document.documentElement.dataset.theme = resolved;
}

async function loadForm(): Promise<void> {
  const [settings, stored] = await Promise.all([
    loadLookupSettings(),
    chrome.storage.local.get({ [AUTO_LOOKUP_STORAGE_KEY]: true })
  ]);

  autoLookup.checked = stored[AUTO_LOOKUP_STORAGE_KEY] !== false;
  provider.value = settings.api.provider;
  apiKey.value = settings.api.apiKey;
  baseUrl.value = settings.api.baseUrl;
  model.value = settings.api.model;
  theme.value = settings.ui.theme;
  fontSize.value = settings.ui.fontSize;
  wordPrompt.value = settings.prompts.word;
  sentencePrompt.value = settings.prompts.sentence;

  renderProviderDetails();
  applyPopupTheme(settings.ui.theme);
}

provider.addEventListener("change", () => {
  const preset = PROVIDER_PRESETS[selectedProvider()];
  baseUrl.value = preset.baseUrl;
  model.value = preset.defaultModel;
  renderProviderDetails();
});

theme.addEventListener("change", () => applyPopupTheme(theme.value as UiTheme));

toggleKey.addEventListener("click", () => {
  const show = apiKey.type === "password";
  apiKey.type = show ? "text" : "password";
  toggleKey.textContent = show ? "隐藏" : "显示";
});

resetPrompts.addEventListener("click", () => {
  wordPrompt.value = DEFAULT_WORD_PROMPT;
  sentencePrompt.value = DEFAULT_SENTENCE_PROMPT;
  status.textContent = "已恢复默认 Prompt，点击“保存设置”后生效。";
});

save.addEventListener("click", () => {
  void (async () => {
    status.textContent = "正在保存…";

    const nextSettings = {
      ui: {
        theme: theme.value as UiTheme,
        fontSize: fontSize.value as UiFontSize
      },
      api: {
        provider: selectedProvider(),
        baseUrl: baseUrl.value.trim(),
        apiKey: apiKey.value.trim(),
        model: model.value.trim()
      },
      prompts: {
        word: wordPrompt.value.trim() || DEFAULT_WORD_PROMPT,
        sentence: sentencePrompt.value.trim() || DEFAULT_SENTENCE_PROMPT
      }
    };

    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: nextSettings,
      [AUTO_LOOKUP_STORAGE_KEY]: autoLookup.checked
    });

    status.textContent = "已保存。打开的网页会立即同步界面设置。";
    window.setTimeout(() => {
      if (status.textContent?.startsWith("已保存")) status.textContent = "";
    }, 2500);
  })().catch(error => {
    status.textContent = error instanceof Error ? error.message : "保存失败";
  });
});

void loadForm();
