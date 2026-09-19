import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_PROMPTS,
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  normalizeSettings,
  type LookupSettings,
  type MimoVoiceId,
  type PronunciationProviderId,
  type PromptApplicableType,
  type PromptDefinition,
  type ProviderId,
  type UiFontSize,
  type UiTheme
} from "../shared/settings";

function byId<T extends HTMLElement>(id:string):T{
  const el=document.getElementById(id);
  if(!el) throw new Error("Missing #"+id);
  return el as T;
}

const autoLookup=byId<HTMLInputElement>("autoLookup");
const provider=byId<HTMLSelectElement>("provider");
const providerNote=byId<HTMLParagraphElement>("providerNote");
const apiKey=byId<HTMLInputElement>("apiKey");
const toggleKey=byId<HTMLButtonElement>("toggleKey");
const baseUrl=byId<HTMLInputElement>("baseUrl");
const model=byId<HTMLInputElement>("model");
const modelSuggestions=byId<HTMLDataListElement>("modelSuggestions");
const timeout=byId<HTMLInputElement>("timeout");
const theme=byId<HTMLSelectElement>("theme");
const fontSize=byId<HTMLSelectElement>("fontSize");
const promptSelect=byId<HTMLSelectElement>("promptSelect");
const promptName=byId<HTMLInputElement>("promptName");
const promptDescription=byId<HTMLInputElement>("promptDescription");
const promptType=byId<HTMLSelectElement>("promptType");
const promptEnabled=byId<HTMLInputElement>("promptEnabled");
const promptSystem=byId<HTMLTextAreaElement>("promptSystem");
const promptTemplate=byId<HTMLTextAreaElement>("promptTemplate");
const defaultWordPrompt=byId<HTMLSelectElement>("defaultWordPrompt");
const defaultSentencePrompt=byId<HTMLSelectElement>("defaultSentencePrompt");
const addPrompt=byId<HTMLButtonElement>("addPrompt");
const deletePrompt=byId<HTMLButtonElement>("deletePrompt");
const resetPrompts=byId<HTMLButtonElement>("resetPrompts");
const exportPrompts=byId<HTMLButtonElement>("exportPrompts");
const importPrompts=byId<HTMLButtonElement>("importPrompts");
const importFile=byId<HTMLInputElement>("importFile");
const pronunciationProvider=byId<HTMLSelectElement>("pronunciationProvider");
const pronunciationNote=byId<HTMLParagraphElement>("pronunciationNote");
const mimoTtsSettings=byId<HTMLDivElement>("mimoTtsSettings");
const mimoTtsKey=byId<HTMLInputElement>("mimoTtsKey");
const mimoTtsBaseUrl=byId<HTMLInputElement>("mimoTtsBaseUrl");
const mimoVoice=byId<HTMLSelectElement>("mimoVoice");
const mimoTtsStyle=byId<HTMLTextAreaElement>("mimoTtsStyle");
const youdaoSettings=byId<HTMLDivElement>("youdaoSettings");
const youdaoKey=byId<HTMLInputElement>("youdaoKey");
const youdaoSecret=byId<HTMLInputElement>("youdaoSecret");
const save=byId<HTMLButtonElement>("save");
const status=byId<HTMLSpanElement>("status");
const openHistory=byId<HTMLButtonElement>("openHistory");
const openPdf=byId<HTMLButtonElement>("openPdf");

let working:LookupSettings=structuredClone(DEFAULT_SETTINGS);
let editingPromptId="";

function selectedProvider():ProviderId{
  const value=provider.value as ProviderId;
  return value in PROVIDER_PRESETS?value:"custom";
}

function renderProviderDetails():void{
  const preset=PROVIDER_PRESETS[selectedProvider()];
  providerNote.textContent=preset.note;
  modelSuggestions.replaceChildren(...preset.modelSuggestions.map(value=>{
    const option=document.createElement("option");
    option.value=value;
    return option;
  }));
}

function applyPopupTheme(value:UiTheme):void{
  const resolved=value==="system"
    ?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")
    :value;
  document.documentElement.dataset.theme=resolved;
}

function renderPronunciationSettings():void{
  const selected=pronunciationProvider.value as PronunciationProviderId;
  mimoTtsSettings.classList.toggle("hidden",selected!=="mimo");
  youdaoSettings.classList.toggle("hidden",selected!=="youdao");
  pronunciationNote.textContent=selected==="mimo"
    ?"默认使用 MiMo-V2.5-TTS。当前官方标注为限时免费；只有点击发音按钮时才会生成音频。"
    :selected==="youdao"
      ?"使用有道智云词典的英式音标与英音，作为备用发音服务。"
      :"发音按钮将隐藏，不会向第三方语音服务发送文本。";
}

function currentPrompt():PromptDefinition|undefined{
  return working.prompts.items.find(prompt=>prompt.id===editingPromptId);
}

function savePromptEditor():void{
  const prompt=currentPrompt();
  if(!prompt) return;
  const changed=
    prompt.name!==promptName.value.trim()||
    prompt.description!==promptDescription.value.trim()||
    prompt.applicableType!==promptType.value||
    prompt.enabled!==promptEnabled.checked||
    prompt.systemPrompt!==promptSystem.value.trim()||
    prompt.userTemplate!==promptTemplate.value.trim();

  prompt.name=promptName.value.trim()||"未命名 Prompt";
  prompt.description=promptDescription.value.trim();
  prompt.applicableType=promptType.value as PromptApplicableType;
  prompt.enabled=promptEnabled.checked;
  prompt.systemPrompt=promptSystem.value.trim()||prompt.systemPrompt;
  prompt.userTemplate=promptTemplate.value.trim()||prompt.userTemplate;
  if(changed) prompt.version=Math.max(1,prompt.version+1);
}

function renderPromptOptions():void{
  promptSelect.replaceChildren(...working.prompts.items.map(prompt=>{
    const option=document.createElement("option");
    option.value=prompt.id;
    option.textContent=prompt.name+(prompt.enabled?"":"（停用）");
    return option;
  }));

  if(!working.prompts.items.some(prompt=>prompt.id===editingPromptId)){
    editingPromptId=working.prompts.items[0]?.id??"";
  }
  promptSelect.value=editingPromptId;

  const word=working.prompts.items.filter(prompt=>prompt.enabled&&(prompt.applicableType==="word"||prompt.applicableType==="both"));
  const sentence=working.prompts.items.filter(prompt=>prompt.enabled&&(prompt.applicableType==="sentence"||prompt.applicableType==="both"));

  defaultWordPrompt.replaceChildren(...word.map(prompt=>{
    const option=document.createElement("option");
    option.value=prompt.id;
    option.textContent=prompt.name;
    return option;
  }));
  defaultSentencePrompt.replaceChildren(...sentence.map(prompt=>{
    const option=document.createElement("option");
    option.value=prompt.id;
    option.textContent=prompt.name;
    return option;
  }));

  if(word.some(prompt=>prompt.id===working.prompts.defaultWordPromptId)){
    defaultWordPrompt.value=working.prompts.defaultWordPromptId;
  }else if(word[0]){
    working.prompts.defaultWordPromptId=word[0].id;
    defaultWordPrompt.value=word[0].id;
  }

  if(sentence.some(prompt=>prompt.id===working.prompts.defaultSentencePromptId)){
    defaultSentencePrompt.value=working.prompts.defaultSentencePromptId;
  }else if(sentence[0]){
    working.prompts.defaultSentencePromptId=sentence[0].id;
    defaultSentencePrompt.value=sentence[0].id;
  }
}

function renderPromptEditor():void{
  renderPromptOptions();
  const prompt=currentPrompt();
  if(!prompt) return;
  promptName.value=prompt.name;
  promptDescription.value=prompt.description;
  promptType.value=prompt.applicableType;
  promptEnabled.checked=prompt.enabled;
  promptSystem.value=prompt.systemPrompt;
  promptTemplate.value=prompt.userTemplate;
  deletePrompt.disabled=working.prompts.items.length<=1;
}

function newPrompt():PromptDefinition{
  return {
    id:crypto.randomUUID(),
    name:"新 Prompt",
    description:"",
    applicableType:"both",
    systemPrompt:"请根据用户选择的文本和上下文提供简洁、准确的解释。",
    userTemplate:DEFAULT_PROMPTS[0].userTemplate,
    enabled:true,
    version:1
  };
}

async function loadForm():Promise<void>{
  const [loaded,stored]=await Promise.all([
    loadLookupSettings(),
    chrome.storage.local.get({[AUTO_LOOKUP_STORAGE_KEY]:true})
  ]);
  working=loaded;
  autoLookup.checked=stored[AUTO_LOOKUP_STORAGE_KEY]!==false;
  provider.value=working.api.provider;
  apiKey.value=working.api.apiKey;
  baseUrl.value=working.api.baseUrl;
  model.value=working.api.model;
  timeout.value=String(Math.round(working.api.timeoutMs/1000));
  theme.value=working.ui.theme;
  fontSize.value=working.ui.fontSize;
  pronunciationProvider.value=working.pronunciation.provider;
  mimoTtsKey.value=working.pronunciation.mimo.apiKey;
  mimoTtsBaseUrl.value=working.pronunciation.mimo.baseUrl;
  mimoVoice.value=working.pronunciation.mimo.voice;
  mimoTtsStyle.value=working.pronunciation.mimo.style;
  youdaoKey.value=working.pronunciation.youdao.appKey;
  youdaoSecret.value=working.pronunciation.youdao.appSecret;
  editingPromptId=working.prompts.items[0]?.id??"";
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  if(tabs[0]?.url&&/\\.pdf(?:$|[?#])/i.test(tabs[0].url)){
    openPdf.textContent="用查词阅读器打开当前 PDF";
  }
  renderPronunciationSettings();
  renderProviderDetails();
  renderPromptEditor();
  applyPopupTheme(working.ui.theme);
}

provider.addEventListener("change",()=>{
  const preset=PROVIDER_PRESETS[selectedProvider()];
  baseUrl.value=preset.baseUrl;
  model.value=preset.defaultModel;
  renderProviderDetails();
});
theme.addEventListener("change",()=>applyPopupTheme(theme.value as UiTheme));
pronunciationProvider.addEventListener("change",renderPronunciationSettings);
toggleKey.addEventListener("click",()=>{
  const show=apiKey.type==="password";
  apiKey.type=show?"text":"password";
  toggleKey.textContent=show?"隐藏":"显示";
});
promptSelect.addEventListener("change",()=>{
  savePromptEditor();
  editingPromptId=promptSelect.value;
  renderPromptEditor();
});
addPrompt.addEventListener("click",()=>{
  savePromptEditor();
  const prompt=newPrompt();
  working.prompts.items.push(prompt);
  editingPromptId=prompt.id;
  renderPromptEditor();
});
deletePrompt.addEventListener("click",()=>{
  if(working.prompts.items.length<=1) return;
  const id=editingPromptId;
  working.prompts.items=working.prompts.items.filter(prompt=>prompt.id!==id);
  if(working.prompts.defaultWordPromptId===id){
    working.prompts.defaultWordPromptId=working.prompts.items.find(prompt=>prompt.enabled&&(prompt.applicableType==="word"||prompt.applicableType==="both"))?.id??working.prompts.items[0].id;
  }
  if(working.prompts.defaultSentencePromptId===id){
    working.prompts.defaultSentencePromptId=working.prompts.items.find(prompt=>prompt.enabled&&(prompt.applicableType==="sentence"||prompt.applicableType==="both"))?.id??working.prompts.items[0].id;
  }
  editingPromptId=working.prompts.items[0].id;
  renderPromptEditor();
});
defaultWordPrompt.addEventListener("change",()=>working.prompts.defaultWordPromptId=defaultWordPrompt.value);
defaultSentencePrompt.addEventListener("change",()=>working.prompts.defaultSentencePromptId=defaultSentencePrompt.value);
resetPrompts.addEventListener("click",()=>{
  working.prompts={
    items:DEFAULT_PROMPTS.map(prompt=>({...prompt})),
    defaultWordPromptId:DEFAULT_PROMPTS[0].id,
    defaultSentencePromptId:DEFAULT_PROMPTS[1].id
  };
  editingPromptId=working.prompts.items[0].id;
  renderPromptEditor();
  status.textContent="已恢复默认 Prompt，保存后生效。";
});
exportPrompts.addEventListener("click",()=>{
  savePromptEditor();
  const blob=new Blob([JSON.stringify(working.prompts,null,2)],{type:"application/json"});
  const anchor=document.createElement("a");
  const url=URL.createObjectURL(blob);
  anchor.href=url;
  anchor.download="selection-lookup-prompts.json";
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
importPrompts.addEventListener("click",()=>importFile.click());
importFile.addEventListener("change",()=>{
  void (async()=>{
    const file=importFile.files?.[0];
    if(!file) return;
    const parsed=JSON.parse(await file.text());
    const migrated=normalizeSettings({...working,prompts:parsed});
    working.prompts=migrated.prompts;
    editingPromptId=working.prompts.items[0]?.id??"";
    renderPromptEditor();
    status.textContent="Prompt 已导入，保存后生效。";
    importFile.value="";
  })().catch(error=>{
    status.textContent=error instanceof Error?error.message:"导入失败";
  });
});
openHistory.addEventListener("click",()=>{
  void chrome.tabs.create({url:chrome.runtime.getURL("history.html")});
});
openPdf.addEventListener("click",()=>{
  void (async()=>{
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});
    const current=tabs[0]?.url;
    const source=current&&/^https?:/i.test(current)&&/\\.pdf(?:$|[?#])/i.test(current)?current:"";
    const url=chrome.runtime.getURL("pdf.html")+(source?"?src="+encodeURIComponent(source):"");
    await chrome.tabs.create({url});
  })();
});
save.addEventListener("click",()=>{
  void (async()=>{
    savePromptEditor();
    working.ui={theme:theme.value as UiTheme,fontSize:fontSize.value as UiFontSize};
    working.api={
      provider:selectedProvider(),
      baseUrl:baseUrl.value.trim(),
      apiKey:apiKey.value.trim(),
      model:model.value.trim(),
      timeoutMs:Math.min(120000,Math.max(5000,Number(timeout.value||45)*1000))
    };
    working.pronunciation={
      provider:pronunciationProvider.value as PronunciationProviderId,
      mimo:{
        apiKey:mimoTtsKey.value.trim(),
        baseUrl:mimoTtsBaseUrl.value.trim()||DEFAULT_SETTINGS.pronunciation.mimo.baseUrl,
        model:"mimo-v2.5-tts",
        voice:mimoVoice.value as MimoVoiceId,
        style:mimoTtsStyle.value.trim()||DEFAULT_SETTINGS.pronunciation.mimo.style
      },
      youdao:{
        enabled:pronunciationProvider.value==="youdao",
        appKey:youdaoKey.value.trim(),
        appSecret:youdaoSecret.value.trim()
      }
    };
    working.prompts.defaultWordPromptId=defaultWordPrompt.value||working.prompts.defaultWordPromptId;
    working.prompts.defaultSentencePromptId=defaultSentencePrompt.value||working.prompts.defaultSentencePromptId;
    working=normalizeSettings(working);
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]:working,
      [AUTO_LOOKUP_STORAGE_KEY]:autoLookup.checked
    });
    status.textContent="已保存。";
    setTimeout(()=>{if(status.textContent==="已保存。")status.textContent="";},2200);
  })().catch(error=>{
    status.textContent=error instanceof Error?error.message:"保存失败";
  });
});

void loadForm();
