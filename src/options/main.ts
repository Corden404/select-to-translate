import type { ConnectionTestResponse } from "../shared/messages";
import { OPTIONS_SOURCE_STORAGE_KEY, isOptionsSourceTab, isRemotePdfUrl } from "../shared/options-source";
import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_PROMPTS,
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  normalizeSettings,
  type LookupSettings,
  type LookupTriggerMode,
  type MimoVoiceId,
  type PronunciationProviderId,
  type PromptApplicableType,
  type PromptDefinition,
  type ProviderId,
  type SpeechModelProviderId,
  type UiFontSize,
  type UiTheme
} from "../shared/settings";

function byId<T extends HTMLElement>(id:string):T{
  const el=document.getElementById(id);
  if(!el) throw new Error("Missing #"+id);
  return el as T;
}

const autoLookup=byId<HTMLInputElement>("autoLookup");
const lookupMode=byId<HTMLSelectElement>("lookupMode");
const skipEditable=byId<HTMLInputElement>("skipEditable");
const manualLookupNow=byId<HTMLButtonElement>("manualLookupNow");
const siteToggle=byId<HTMLButtonElement>("siteToggle");
const siteStatus=byId<HTMLParagraphElement>("siteStatus");
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
const historyEnabled=byId<HTMLInputElement>("historyEnabled");
const historyRetentionDays=byId<HTMLSelectElement>("historyRetentionDays");
const historyMaxEntries=byId<HTMLSelectElement>("historyMaxEntries");
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
const testApi=byId<HTMLButtonElement>("testApi");
const apiTestStatus=byId<HTMLSpanElement>("apiTestStatus");
const testPronunciation=byId<HTMLButtonElement>("testPronunciation");
const pronunciationTestStatus=byId<HTMLSpanElement>("pronunciationTestStatus");
const autoSpeechExplanation=byId<HTMLInputElement>("autoSpeechExplanation");
const speechExplanationDetails=byId<HTMLDivElement>("speechExplanationDetails");
const stopAudioOnCardClose=byId<HTMLInputElement>("stopAudioOnCardClose");
const speechPlaybackRate=byId<HTMLSelectElement>("speechPlaybackRate");
const speechModelProvider=byId<HTMLSelectElement>("speechModelProvider");
const speechModel=byId<HTMLInputElement>("speechModel");
const speechModelSuggestions=byId<HTMLDataListElement>("speechModelSuggestions");
const speechExplanationPrompt=byId<HTMLTextAreaElement>("speechExplanationPrompt");
const speechTtsStyle=byId<HTMLTextAreaElement>("speechTtsStyle");

let working:LookupSettings=structuredClone(DEFAULT_SETTINGS);
let editingPromptId="";
let activeProvider:ProviderId=DEFAULT_SETTINGS.api.provider;
let sourceTabId:number|null=null;
let sourceTabUrl="";
let sourceTabTitle="";
let currentSiteHost="";
const SOURCE_MAX_AGE_MS=10*60*1000;

function selectedProvider():ProviderId{
  const value=provider.value as ProviderId;
  return value in PROVIDER_PRESETS?value:"custom";
}

function siteHost(url:string|undefined):string{
  if(!url) return "";
  try{
    const parsed=new URL(url);
    return parsed.protocol==="http:"||parsed.protocol==="https:"?parsed.hostname.toLowerCase():"";
  }catch{return "";}
}

function renderSiteControls():void{
  manualLookupNow.disabled=sourceTabId===null;
  if(sourceTabId===null){
    siteToggle.hidden=true;
    siteStatus.textContent="从网页点击扩展图标打开此设置页后，可在这里手动查询来源页面选区或暂停该网站。快捷键：Alt + Shift + D。";
    return;
  }
  if(!currentSiteHost){
    siteToggle.hidden=true;
    siteStatus.textContent=`来源页面：${sourceTabTitle||sourceTabUrl||"当前标签页"}。该页面不支持网站级自动查词控制。`;
    return;
  }
  siteToggle.hidden=false;
  const paused=working.behavior.disabledHosts.includes(currentSiteHost);
  siteToggle.textContent=paused?"恢复来源网站自动查词":"暂停来源网站自动查词";
  siteStatus.textContent=`来源网站 ${currentSiteHost} · ${paused?"自动查词已暂停":"自动查词可用"}。站点暂停不影响手动查询。`;
}

async function applyOptionsSource(value:unknown):Promise<void>{
  sourceTabId=null;
  sourceTabUrl="";
  sourceTabTitle="";
  if(isOptionsSourceTab(value)&&Date.now()-value.capturedAt<=SOURCE_MAX_AGE_MS){
    try{
      const tab=await chrome.tabs.get(value.tabId);
      if(typeof tab.id==="number"){
        sourceTabId=tab.id;
        sourceTabUrl=tab.url??value.url;
        sourceTabTitle=tab.title??value.title;
      }
    }catch{
      // The source tab may have been closed while the settings page stayed open.
    }
  }
  currentSiteHost=siteHost(sourceTabUrl);
  openPdf.textContent=isRemotePdfUrl(sourceTabUrl)
    ?"用查词阅读器打开来源 PDF"
    :"打开 PDF 阅读器";
  renderSiteControls();
}

async function loadOptionsSource():Promise<void>{
  const stored=await chrome.storage.session.get(OPTIONS_SOURCE_STORAGE_KEY);
  await applyOptionsSource(stored[OPTIONS_SOURCE_STORAGE_KEY]);
}

function providerFormConfig(id:ProviderId){
  const preset=PROVIDER_PRESETS[id];
  return working.api.providerConfigs?.[id]??{
    apiKey:working.api.providerApiKeys?.[id]??(id===working.api.provider?working.api.apiKey:""),
    baseUrl:id===working.api.provider?working.api.baseUrl:preset.baseUrl,
    model:id===working.api.provider?working.api.model:preset.defaultModel
  };
}

function stashProviderForm(id:ProviderId):void{
  const config={apiKey:apiKey.value.trim(),baseUrl:baseUrl.value.trim(),model:model.value.trim()};
  working.api.providerConfigs={...(working.api.providerConfigs??{}),[id]:config};
  working.api.providerApiKeys={...(working.api.providerApiKeys??{}),[id]:config.apiKey};
}

function loadProviderForm(id:ProviderId):void{
  const config=providerFormConfig(id);
  apiKey.value=config.apiKey;
  baseUrl.value=config.baseUrl;
  model.value=config.model;
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
  mimoTtsSettings.classList.toggle("hidden",selected!=="mimo"&&!autoSpeechExplanation.checked);
  youdaoSettings.classList.toggle("hidden",selected!=="youdao");
  pronunciationNote.textContent=selected==="mimo"
    ?(autoSpeechExplanation.checked
      ?"MiMo TTS 同时用于手动单词发音和自动语音解释。"
      :"默认使用 MiMo-V2.5-TTS；只有点击发音按钮时才会生成单词音频。")
    :selected==="youdao"
      ?(autoSpeechExplanation.checked
        ?"单词查询使用有道英式音标；自动语音解释仍使用 MiMo TTS，因此 MiMo 配置会继续显示。"
        :"使用有道智云词典查询英式音标；不下载或播放有道音频。")
      :(autoSpeechExplanation.checked
        ?"手动单词发音已关闭；自动语音解释仍使用 MiMo TTS。"
        :"发音按钮将隐藏，不会向第三方语音服务发送文本。");
}

function renderSpeechExplanationSettings():void{
  speechExplanationDetails.classList.toggle("hidden",!autoSpeechExplanation.checked);
  renderPronunciationSettings();
}

function renderSpeechModelSettings(resetModel=false):void{
  const selected=speechModelProvider.value as SpeechModelProviderId;
  if(selected==="main"){
    speechModel.disabled=true;
    speechModelSuggestions.replaceChildren();
    speechModel.value=model.value.trim()||working.api.model;
    return;
  }
  speechModel.disabled=false;
  const preset=PROVIDER_PRESETS[selected];
  speechModelSuggestions.replaceChildren(...preset.modelSuggestions.map(value=>{
    const option=document.createElement("option");option.value=value;return option;
  }));
  if(resetModel||!speechModel.value.trim()) speechModel.value=providerFormConfig(selected).model||preset.defaultModel;
}

function setTestStatus(element:HTMLSpanElement,state:"idle"|"testing"|"success"|"error",message:string):void{
  element.className="test-status"+(state==="idle"?"":" "+state);
  element.textContent=message;
}

function formatTestResult(response:ConnectionTestResponse):string{
  const timing=response.latencyMs>=0?`${response.latencyMs} ms`:"";
  const preview=response.preview?.trim();
  return [response.message,timing,preview].filter(Boolean).join(" · ");
}

function currentTimeoutMs():number{
  return Math.min(120000,Math.max(5000,Number(timeout.value||45)*1000));
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
  lookupMode.value=working.behavior.mode;
  skipEditable.checked=working.behavior.skipEditable;
  provider.value=working.api.provider;
  activeProvider=working.api.provider;
  loadProviderForm(activeProvider);
  timeout.value=String(Math.round(working.api.timeoutMs/1000));
  theme.value=working.ui.theme;
  fontSize.value=working.ui.fontSize;
  historyEnabled.checked=working.history.enabled;
  historyRetentionDays.value=String(working.history.retentionDays);
  historyMaxEntries.value=String(working.history.maxEntries);
  pronunciationProvider.value=working.pronunciation.provider;
  mimoTtsKey.value=working.pronunciation.mimo.apiKey;
  mimoTtsBaseUrl.value=working.pronunciation.mimo.baseUrl;
  mimoVoice.value=working.pronunciation.mimo.voice;
  mimoTtsStyle.value=working.pronunciation.mimo.style;
  youdaoKey.value=working.pronunciation.youdao.appKey;
  youdaoSecret.value=working.pronunciation.youdao.appSecret;
  autoSpeechExplanation.checked=working.speechExplanation.enabled;
  stopAudioOnCardClose.checked=working.speechExplanation.stopOnCardClose;
  speechPlaybackRate.value=String(working.speechExplanation.playbackRate);
  speechModelProvider.value=working.speechExplanation.modelProvider;
  speechModel.value=working.speechExplanation.model;
  speechExplanationPrompt.value=working.speechExplanation.prompt;
  speechTtsStyle.value=working.speechExplanation.ttsStyle;
  editingPromptId=working.prompts.items[0]?.id??"";
  await loadOptionsSource();
  renderSpeechExplanationSettings();
  renderSpeechModelSettings();
  renderProviderDetails();
  renderPromptEditor();
  applyPopupTheme(working.ui.theme);
}

provider.addEventListener("change",()=>{
  stashProviderForm(activeProvider);
  activeProvider=selectedProvider();
  loadProviderForm(activeProvider);
  renderProviderDetails();
  if(speechModelProvider.value==="main") renderSpeechModelSettings();
});
theme.addEventListener("change",()=>applyPopupTheme(theme.value as UiTheme));
pronunciationProvider.addEventListener("change",renderPronunciationSettings);
autoSpeechExplanation.addEventListener("change",renderSpeechExplanationSettings);
speechModelProvider.addEventListener("change",()=>renderSpeechModelSettings(true));
manualLookupNow.addEventListener("click",()=>{
  void (async()=>{
    if(sourceTabId===null) throw new Error("没有可用的来源页面，请回到网页后点击扩展图标重新打开设置。");
    await chrome.tabs.sendMessage(sourceTabId,{type:"MANUAL_LOOKUP_TRIGGER"});
    status.textContent="已向来源页面发送手动查词指令。";
  })().catch(error=>{status.textContent=error instanceof Error?error.message:"手动查词失败。";});
});
siteToggle.addEventListener("click",()=>{
  void (async()=>{
    if(!currentSiteHost) return;
    const persisted=await loadLookupSettings();
    const paused=persisted.behavior.disabledHosts.includes(currentSiteHost);
    persisted.behavior.disabledHosts=paused
      ?persisted.behavior.disabledHosts.filter(host=>host!==currentSiteHost)
      :[...persisted.behavior.disabledHosts,currentSiteHost];
    const normalized=normalizeSettings(persisted);
    await chrome.storage.local.set({[SETTINGS_STORAGE_KEY]:normalized});
    working.behavior.disabledHosts=[...normalized.behavior.disabledHosts];
    renderSiteControls();
    status.textContent=paused?"已恢复当前网站自动查词。":"已暂停当前网站自动查词。";
  })().catch(error=>{status.textContent=error instanceof Error?error.message:"更新网站设置失败。";});
});

testApi.addEventListener("click",()=>{
  void (async()=>{
    testApi.disabled=true;
    setTestStatus(apiTestStatus,"testing","正在测试模型 API…");
    const response=await chrome.runtime.sendMessage({
      type:"TEST_LLM_CONNECTION",
      config:{
        baseUrl:baseUrl.value.trim(),
        apiKey:apiKey.value.trim(),
        model:model.value.trim(),
        timeoutMs:currentTimeoutMs()
      }
    }) as ConnectionTestResponse;
    setTestStatus(apiTestStatus,response.ok?"success":"error",formatTestResult(response));
  })().catch(error=>{
    setTestStatus(apiTestStatus,"error",error instanceof Error?error.message:"模型 API 测试失败。");
  }).finally(()=>{testApi.disabled=false;});
});

testPronunciation.addEventListener("click",()=>{
  void (async()=>{
    const selected=pronunciationProvider.value as PronunciationProviderId;
    if(selected==="off"){
      setTestStatus(pronunciationTestStatus,"error","发音功能当前已关闭。");
      return;
    }

    testPronunciation.disabled=true;
    setTestStatus(pronunciationTestStatus,"testing",selected==="mimo"?"正在测试 MiMo TTS…":"正在测试有道词典…");

    const response=await chrome.runtime.sendMessage(selected==="mimo"?{
      type:"TEST_PRONUNCIATION_CONNECTION",
      provider:"mimo",
      mimo:{
        apiKey:mimoTtsKey.value.trim()||(selectedProvider()==="mimo"?apiKey.value.trim():""),
        baseUrl:mimoTtsBaseUrl.value.trim()||DEFAULT_SETTINGS.pronunciation.mimo.baseUrl,
        model:"mimo-v2.5-tts",
        voice:mimoVoice.value as MimoVoiceId,
        style:mimoTtsStyle.value.trim()||DEFAULT_SETTINGS.pronunciation.mimo.style
      }
    }:{
      type:"TEST_PRONUNCIATION_CONNECTION",
      provider:"youdao",
      youdao:{
        appKey:youdaoKey.value.trim(),
        appSecret:youdaoSecret.value.trim()
      }
    }) as ConnectionTestResponse;

    setTestStatus(pronunciationTestStatus,response.ok?"success":"error",formatTestResult(response));
  })().catch(error=>{
    setTestStatus(pronunciationTestStatus,"error",error instanceof Error?error.message:"发音 API 测试失败。");
  }).finally(()=>{testPronunciation.disabled=false;});
});
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
    const source=isRemotePdfUrl(sourceTabUrl)?sourceTabUrl:"";
    const url=chrome.runtime.getURL("pdf.html")+(source?"?src="+encodeURIComponent(source):"");
    await chrome.tabs.create({url});
  })();
});
save.addEventListener("click",()=>{
  void (async()=>{
    savePromptEditor();
    working.ui={theme:theme.value as UiTheme,fontSize:fontSize.value as UiFontSize};
    working.behavior={mode:lookupMode.value as LookupTriggerMode,disabledHosts:[...working.behavior.disabledHosts],skipEditable:skipEditable.checked};
    const selectedApiProvider=selectedProvider();
    stashProviderForm(selectedApiProvider);
    const providerConfigs=working.api.providerConfigs??{};
    const selectedConfig=providerConfigs[selectedApiProvider]??{
      apiKey:"",baseUrl:baseUrl.value.trim(),model:model.value.trim()
    };
    const providerApiKeys=Object.fromEntries(
      Object.entries(providerConfigs).map(([id,config])=>[id,config?.apiKey??""])
    ) as LookupSettings["api"]["providerApiKeys"];
    activeProvider=selectedApiProvider;
    working.api={
      provider:selectedApiProvider,
      baseUrl:selectedConfig.baseUrl,
      apiKey:selectedConfig.apiKey,
      providerConfigs,
      providerApiKeys,
      model:selectedConfig.model,
      timeoutMs:currentTimeoutMs()
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
    working.speechExplanation={
      enabled:autoSpeechExplanation.checked,
      stopOnCardClose:stopAudioOnCardClose.checked,
      playbackRate:Number(speechPlaybackRate.value)||DEFAULT_SETTINGS.speechExplanation.playbackRate,
      modelProvider:speechModelProvider.value as SpeechModelProviderId,
      model:speechModelProvider.value==="main"?"":speechModel.value.trim(),
      prompt:speechExplanationPrompt.value.trim()||DEFAULT_SETTINGS.speechExplanation.prompt,
      ttsStyle:speechTtsStyle.value.trim()||DEFAULT_SETTINGS.speechExplanation.ttsStyle
    };
    working.history={
      enabled:historyEnabled.checked,
      retentionDays:Number(historyRetentionDays.value),
      maxEntries:Number(historyMaxEntries.value)
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

chrome.storage.onChanged.addListener((changes,areaName)=>{
  if(areaName!=="session"||!changes[OPTIONS_SOURCE_STORAGE_KEY]) return;
  void applyOptionsSource(changes[OPTIONS_SOURCE_STORAGE_KEY].newValue);
});

void loadForm();
