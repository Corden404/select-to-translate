import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import "../content/main";

GlobalWorkerOptions.workerSrc=chrome.runtime.getURL("pdf.worker.mjs");

const urlInput=document.getElementById("url") as HTMLInputElement;
const loadButton=document.getElementById("load") as HTMLButtonElement;
const chooseButton=document.getElementById("choose") as HTMLButtonElement;
const fileInput=document.getElementById("file") as HTMLInputElement;
const pages=document.getElementById("pages") as HTMLDivElement;
const status=document.getElementById("status") as HTMLDivElement;
const zoomButton=document.getElementById("zoom") as HTMLButtonElement;

let documentProxy:PDFDocumentProxy|null=null;
let scale=1.25;
let renderGeneration=0;
let pageObserver:IntersectionObserver|null=null;

interface PageSlot{
  number:number;
  container:HTMLElement;
  visible:boolean;
  rendered:boolean;
  rendering:boolean;
}

const pageSlots=new Map<number,PageSlot>();

function setSource(url:string,title:string):void{
  document.documentElement.dataset.lookupSourceType="pdf";
  document.documentElement.dataset.lookupSourceUrl=url;
  document.documentElement.dataset.lookupSourceTitle=title;
  document.title=title+" - PDF 查词阅读器";
}

function clearPage(slot:PageSlot):void{
  if(slot.rendering) return;
  slot.container.replaceChildren();
  slot.rendered=false;
}

async function renderPage(pdf:PDFDocumentProxy,slot:PageSlot,generation:number):Promise<void>{
  if(slot.rendered||slot.rendering||generation!==renderGeneration) return;
  slot.rendering=true;
  try{
    const page=await pdf.getPage(slot.number);
    if(generation!==renderGeneration) return;
    const viewport=page.getViewport({scale});
    const canvas=document.createElement("canvas");
    const outputScale=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.floor(viewport.width*outputScale);
    canvas.height=Math.floor(viewport.height*outputScale);
    canvas.style.width=viewport.width+"px";
    canvas.style.height=viewport.height+"px";
    const ctx=canvas.getContext("2d");
    if(!ctx) throw new Error("无法创建 PDF Canvas。");

    const textLayer=document.createElement("div");
    textLayer.className="pdf-text-layer";
    textLayer.style.width=viewport.width+"px";
    textLayer.style.height=viewport.height+"px";
    slot.container.replaceChildren(canvas,textLayer);

    await page.render({
      canvas,
      canvasContext:ctx,
      viewport,
      transform:outputScale===1?undefined:[outputScale,0,0,outputScale,0,0]
    }).promise;
    if(generation!==renderGeneration) return;
    const textContent=await page.getTextContent();
    const layer=new TextLayer({textContentSource:textContent,container:textLayer,viewport});
    await layer.render();
    if(generation!==renderGeneration) return;
    slot.rendered=true;
  }finally{
    slot.rendering=false;
    if(generation===renderGeneration&&!slot.visible) clearPage(slot);
  }
}

async function sampleTextCharacters(pdf:PDFDocumentProxy):Promise<number>{
  const count=Math.min(pdf.numPages,5);
  let characters=0;
  for(let number=1;number<=count;number++){
    const page=await pdf.getPage(number);
    const textContent=await page.getTextContent();
    characters+=textContent.items.reduce((sum,item)=>sum+("str" in item?item.str.length:0),0);
    if(characters>=10) break;
  }
  return characters;
}

async function preparePdf(pdf:PDFDocumentProxy):Promise<void>{
  const generation=++renderGeneration;
  pageObserver?.disconnect();
  pageObserver=null;
  pageSlots.clear();
  pages.replaceChildren();
  status.textContent="正在准备 "+pdf.numPages+" 页…";

  for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number);
    if(generation!==renderGeneration) return;
    const viewport=page.getViewport({scale});
    const container=document.createElement("section");
    container.className="page";
    container.dataset.pageNumber=String(number);
    container.style.width=viewport.width+"px";
    container.style.height=viewport.height+"px";
    container.style.setProperty("--total-scale-factor",String(viewport.scale));
    const slot:PageSlot={number,container,visible:false,rendered:false,rendering:false};
    pageSlots.set(number,slot);
    pages.append(container);
  }

  pageObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      const number=Number((entry.target as HTMLElement).dataset.pageNumber);
      const slot=pageSlots.get(number);
      if(!slot) continue;
      slot.visible=entry.isIntersecting;
      if(slot.visible){
        void renderPage(pdf,slot,generation).catch(showError);
      }else{
        clearPage(slot);
      }
    }
  },{rootMargin:"1200px 0px"});
  for(const slot of pageSlots.values()) pageObserver.observe(slot.container);

  const first=pageSlots.get(1);
  if(first){
    first.visible=true;
    await renderPage(pdf,first,generation);
  }
  if(generation!==renderGeneration) return;
  const textCharacters=await sampleTextCharacters(pdf);
  status.textContent=textCharacters<10
    ?"PDF 已加载，但采样页面没有检测到可选择的文本层。扫描型 PDF 暂不支持 OCR。"
    :"已加载 "+pdf.numPages+" 页（按需渲染）。选中英文单词或句子即可查词。";
}

async function replaceDocument(next:PDFDocumentProxy):Promise<void>{
  const previous=documentProxy;
  documentProxy=next;
  if(previous&&previous!==next) await previous.cleanup();
  await preparePdf(next);
}

async function openRemote(url:string):Promise<void>{
  const normalized=url.trim();
  if(!/^https?:\/\//i.test(normalized)) throw new Error("请输入 http 或 https PDF 地址。");
  status.textContent="正在下载 PDF…";
  const next=await getDocument({url:normalized}).promise;
  setSource(normalized,decodeURIComponent(normalized.split("/").pop()?.split("?")[0]||"远程 PDF"));
  await replaceDocument(next);
}

async function openLocal(file:File):Promise<void>{
  status.textContent="正在读取本地 PDF…";
  const data=new Uint8Array(await file.arrayBuffer());
  const next=await getDocument({data}).promise;
  setSource("local-pdf://"+encodeURIComponent(file.name),file.name);
  await replaceDocument(next);
}

async function rerender():Promise<void>{
  if(documentProxy) await preparePdf(documentProxy);
}

loadButton.addEventListener("click",()=>void openRemote(urlInput.value).catch(showError));
urlInput.addEventListener("keydown",event=>{if(event.key==="Enter")void openRemote(urlInput.value).catch(showError)});
chooseButton.addEventListener("click",()=>fileInput.click());
fileInput.addEventListener("change",()=>{const file=fileInput.files?.[0];if(file)void openLocal(file).catch(showError)});
zoomButton.addEventListener("click",()=>{
  scale=scale===1?1.25:scale===1.25?1.5:scale===1.5?2:1;
  zoomButton.textContent="缩放 "+Math.round(scale*100)+"%";
  void rerender().catch(showError);
});

function showError(error:unknown):void{
  status.textContent=error instanceof Error?error.message:"PDF 加载失败。";
}

const initial=new URLSearchParams(location.search).get("src");
if(initial){
  urlInput.value=initial;
  void openRemote(initial).catch(showError);
}
