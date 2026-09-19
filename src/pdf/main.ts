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
let sourceUrl="";
let sourceTitle="PDF";

function setSource(url:string,title:string):void{
  sourceUrl=url;
  sourceTitle=title;
  document.documentElement.dataset.lookupSourceType="pdf";
  document.documentElement.dataset.lookupSourceUrl=url;
  document.documentElement.dataset.lookupSourceTitle=title;
  document.title=title+" - PDF 查词阅读器";
}

async function renderPdf(pdf:PDFDocumentProxy):Promise<void>{
  pages.replaceChildren();
  status.textContent="正在渲染 "+pdf.numPages+" 页…";
  let textCharacters=0;
  for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number);
    const viewport=page.getViewport({scale});
    const container=document.createElement("section");
    container.className="page";
    container.style.width=viewport.width+"px";
    container.style.height=viewport.height+"px";
    container.style.setProperty("--total-scale-factor",String(viewport.scale));

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

    container.append(canvas,textLayer);
    pages.append(container);

    await page.render({
      canvas,
      canvasContext:ctx,
      viewport,
      transform:outputScale===1?undefined:[outputScale,0,0,outputScale,0,0]
    }).promise;

    const textContent=await page.getTextContent();
    textCharacters+=textContent.items.reduce((sum,item)=>sum+("str" in item?item.str.length:0),0);
    const layer=new TextLayer({
      textContentSource:textContent,
      container:textLayer,
      viewport
    });
    await layer.render();

    status.textContent="正在渲染 "+number+" / "+pdf.numPages+" 页…";
  }
  status.textContent=textCharacters<10
    ?"PDF 已渲染，但没有检测到可选择的文本层。扫描型 PDF 暂不支持 OCR。"
    :"已加载 "+pdf.numPages+" 页。选中英文单词或句子即可查词。";
}

async function openRemote(url:string):Promise<void>{
  const normalized=url.trim();
  if(!/^https?:\/\//i.test(normalized)) throw new Error("请输入 http 或 https PDF 地址。");
  status.textContent="正在下载 PDF…";
  documentProxy=await getDocument({url:normalized}).promise;
  setSource(normalized,decodeURIComponent(normalized.split("/").pop()?.split("?")[0]||"远程 PDF"));
  await renderPdf(documentProxy);
}

async function openLocal(file:File):Promise<void>{
  status.textContent="正在读取本地 PDF…";
  const data=new Uint8Array(await file.arrayBuffer());
  documentProxy=await getDocument({data}).promise;
  setSource("local-pdf://"+encodeURIComponent(file.name),file.name);
  await renderPdf(documentProxy);
}

async function rerender():Promise<void>{
  if(documentProxy) await renderPdf(documentProxy);
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
