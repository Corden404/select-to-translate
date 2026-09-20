import { clearHistory, deleteHistoryRecord, listHistory } from "../history/db";
import type { LookupHistoryRecord } from "../history/types";
import { loadLookupSettings } from "../shared/settings";

const search=document.getElementById("search") as HTMLInputElement;
const list=document.getElementById("list") as HTMLDivElement;
const refresh=document.getElementById("refresh") as HTMLButtonElement;
const clear=document.getElementById("clear") as HTMLButtonElement;
const loadMore=document.getElementById("loadMore") as HTMLButtonElement;
const count=document.getElementById("count") as HTMLSpanElement;
let records:LookupHistoryRecord[]=[];
let visibleCount=100;
const PAGE_SIZE=100;

function text(tag:string,className:string,value:string):HTMLElement{
  const el=document.createElement(tag);
  el.className=className;
  el.textContent=value;
  return el;
}

function formatDate(value:number):string{
  return new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(value);
}

function sourceLabel(record:LookupHistoryRecord):string{
  try{return new URL(record.pageUrl).hostname||record.pageUrl;}catch{return record.pageUrl;}
}

function renderDetail(record:LookupHistoryRecord):HTMLDivElement{
  const detail=document.createElement("div");detail.className="detail";
  detail.append(text("div","label","网页"),text("div","value",record.pageTitle||record.pageUrl));
  const link=document.createElement("a");link.href=record.pageUrl;link.target="_blank";link.rel="noreferrer";link.textContent=record.pageUrl;detail.append(link);
  detail.append(text("div","label","上下文"),text("div","value",[record.context.previousSentence,record.context.currentSentence,record.context.nextSentence].filter(Boolean).join(" ")));
  detail.append(text("div","label","Prompt / 模型"),text("div","value",record.prompt.name+" · "+record.provider+" / "+record.model));
  detail.append(text("div","label","Prompt 快照"),text("div","value",record.prompt.snapshot));
  if(record.initialResponse){detail.append(text("div","label","首次回答"),text("div","value",record.initialResponse));}
  const dialogue=record.messages.filter(message=>message.role!=="system").slice(2);
  if(dialogue.length){
    detail.append(text("div","label","后续对话"));
    const messages=document.createElement("div");messages.className="messages";
    for(const message of dialogue){messages.append(text("div","bubble "+message.role,message.content));}
    detail.append(messages);
  }
  if(record.errorMessage){detail.append(text("div","label","错误"),text("div","value",record.errorMessage));}
  const actions=document.createElement("div");actions.className="actions";
  const remove=document.createElement("button");remove.className="danger";remove.textContent="删除这条记录";
  remove.addEventListener("click",event=>{event.stopPropagation();void deleteHistoryRecord(record.id).then(load);});
  actions.append(remove);detail.append(actions);
  return detail;
}

function render():void{
  const q=search.value.trim().toLowerCase();
  const filtered=!q?records:records.filter(record=>[
    record.selectedText,record.pageTitle,record.pageUrl,record.initialResponse,record.prompt.name,record.model,
    ...record.messages.map(message=>message.content)
  ].join(" ").toLowerCase().includes(q));
  list.replaceChildren();
  const visible=filtered.slice(0,visibleCount);
  count.textContent=`已加载 ${records.length} 条 · 当前显示 ${visible.length} 条`;
  loadMore.hidden=visible.length>=filtered.length;
  if(filtered.length===0){list.append(text("div","empty",q?"没有匹配的历史记录。":"还没有查词历史。"));return;}
  for(const record of visible){
    const item=document.createElement("article");item.className="item";
    const summary=document.createElement("div");summary.className="summary";
    summary.append(text("div","word",record.selectedText),text("div","meta",(record.sourceType==="pdf"?"PDF · ":"")+sourceLabel(record)+" · "+record.prompt.name),text("div","time",formatDate(record.createdAt)));
    summary.addEventListener("click",()=>item.classList.toggle("open"));
    item.append(summary,renderDetail(record));list.append(item);
  }
}

async function load():Promise<void>{
  const settings=await loadLookupSettings();
  records=await listHistory(settings.history.maxEntries);
  visibleCount=PAGE_SIZE;
  render();
}
search.addEventListener("input",()=>{visibleCount=PAGE_SIZE;render();});
refresh.addEventListener("click",()=>void load());
loadMore.addEventListener("click",()=>{visibleCount+=PAGE_SIZE;render();});
clear.addEventListener("click",()=>{if(confirm("确定清空全部查词历史吗？"))void clearHistory().then(load);});
void load();
