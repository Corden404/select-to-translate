# 右键查词工具

Windows 11 上的英语阅读 AI 查词浏览器扩展，支持 Chrome / Microsoft Edge。

当前版本：`0.4.0`。MVP 产品定义中的核心功能已经实现，当前进入实际使用与兼容性打磨阶段。

## 已实现

- 普通网页英文划词自动查询。
- 扩展自带 PDF.js 阅读器，支持远程 PDF 与本地 PDF。
- 单词 / 短词组 / 句子识别，超过 30 个英文词不触发。
- 单词携带所在完整句子；句子携带前一句、当前句和后一句。
- OpenAI-compatible SSE 流式调用。
- DeepSeek、智谱 GLM、小米 MiMo、阿里云千问预设，以及自定义 OpenAI-compatible 接口。
- 中文悬浮卡片，默认黑夜模式，可切换亮色 / 跟随系统与字体大小。
- 点击卡片外自动关闭；图钉固定后仅手动关闭或全局停用时关闭。
- 多 Prompt 管理：新增、删除、启停、单词/句子/通用类型、默认路由、卡片内即时切换。
- Prompt JSON 导入 / 导出。
- 重新生成。
- 继续追问，并在当前卡片中扩展聊天。
- 新选区中止旧请求并结束旧会话。
- IndexedDB 本地历史：URL、标题、上下文、Prompt 快照/版本、Provider、模型、首次回答与后续对话。
- 历史记录搜索、删除和清空。
- 默认发音 Provider 为 MiMo-V2.5-TTS，使用 `Mia` 英文女声并通过自然语言风格指令要求清晰、自然的英式英语词典发音；有道词典保留为备用。
- 请求超时、认证/配额/限流/模型不存在/网络/协议错误分类。
- content script 到 service worker 的长度、30 词、来源 URL、上下文字段校验。
- iframe content script 支持。
- 设置页明确展示第三方数据发送与本地历史存储说明。

## 默认 Prompt

单词 Prompt 的主要说明使用中文，但“语境英文释义”明确要求英文。Prompt 可以在扩展 Popup 中完全自定义，也可以新增多个模板后在悬浮卡片里切换。

## 本地开发

```bash
npm install
npm run check
npm run e2e
```

- `npm run check`：TypeScript 类型检查 + Vitest 单元测试 + 构建。
- `npm run e2e`：构建后启动本机 Microsoft Edge，加载真实 Manifest V3 扩展并验证网页选词、流式对话、历史记录和 PDF.js 文本层选词。
- 构建产物位于 `dist/`。

Chrome / Edge 手工体验：

1. 执行 `npm run build`。
2. 打开浏览器扩展管理页并启用开发者模式。
3. 选择“加载已解压的扩展”，目录指向 `dist/`。
4. 点击工具栏中的“右键查词工具”，配置大模型 API。
5. 打开英文网页选词，或从 Popup 打开 PDF 查词阅读器。
6. `Alt + Shift + L` 可随时切换自动查词总开关。

## PDF

文本型 PDF 使用 PDF.js 文本层复用与网页相同的选词链路。纯扫描 PDF 如果没有文本层会明确提示“暂不支持 OCR”。

## 发音

默认使用 `mimo-v2.5-tts`。MiMo 官方当前将 TTS 系列标注为限时免费；预置英文音色包括 `Mia`、`Chloe`、`Milo`、`Dean`。默认选择 `Mia`，并通过 user message 的自然语言风格指令要求清晰、自然、偏英式英语的词典式发音。官方并未把上述 voice ID 标注为英音或美音，因此口音要求来自风格控制，而不是硬编码的“英音音色”。

MiMo TTS API Key 可以单独填写；若主模型平台就是小米 MiMo，TTS Key 留空时会复用主 API Key。音频只在用户点击发音按钮时生成，不会因为选词自动消耗 TTS 请求。

有道智云词典仍保留为备用 Provider，可继续使用其 `ukPhonetic` / `ukSpeech` 英式音标和音频。

## 隐私

默认只把选中文字与必要上下文发送到用户配置的大模型 API。使用 MiMo TTS 时，只有点击发音按钮后，当前单词或短词组才会发送到小米 MiMo；切换到有道时则发送到有道智云。查询历史只写入当前浏览器的 IndexedDB。API Key 与发音服务密钥不会发送给网页 content script。

详细产品定义见 [PRODUCT.md](./PRODUCT.md)。

技术架构见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

API 资料见 [docs/API_PROVIDERS.md](./docs/API_PROVIDERS.md)。
