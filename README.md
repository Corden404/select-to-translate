# 右键查词工具

Windows 11 上的英语阅读 AI 查词浏览器扩展。

当前处于 MVP Phase 2 开发阶段。

## 已确定的核心体验

- Chrome / Microsoft Edge。
- 普通网页 + PDF。
- 选中英文单词或不超过 30 词的句子后自动查询。
- 快捷键控制自动查词总开关。
- 单词查询携带所在句作为语境。
- 句子查询携带前一句和后一句。
- OpenAI-compatible API。
- 流式输出。
- 选区附近悬浮卡片。
- 支持继续追问、重新生成、切换 Prompt、历史记录。
- 英式发音，发音 Provider 目标为有道。
- 速度优先。

详细产品定义见 [PRODUCT.md](./PRODUCT.md)。

技术架构见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 当前状态

当前版本已经从交互 Mock 进入真实 API 阶段：

- 普通网页文本选区监听、英文检测、单词/句子分类、30 词上限。
- 单词所在句与句子前后文提取。
- 中文夜间模式悬浮卡片，支持亮色 / 跟随系统配置。
- 点击卡片外自动关闭；右上角图钉可固定窗口，固定后只有手动点叉号才关闭。
- OpenAI-compatible SSE 流式调用，API Key 只在扩展高权限上下文中使用。
- 扩展工具栏弹出设置页，可配置 API 平台、Base URL、API Key、模型、UI 风格、字体大小和 Prompt。
- 内置 DeepSeek、智谱 GLM、小米 MiMo、阿里云千问预设，并支持自定义 OpenAI-compatible 接口。
- 默认单词 Prompt 的主要解释使用中文，其中“语境英文释义”强制要求英文。
- `Alt+Shift+L` 控制自动查词总开关。

仍待后续实现：继续追问完整会话、历史记录、PDF.js 阅读器、有道英式发音。

## 本地开发

```bash
npm install
npm run check
```

构建产物位于 `dist/`。

Chrome / Edge 手工体验：

1. 执行 `npm run build`。
2. 打开浏览器扩展管理页并启用开发者模式。
3. 选择“加载已解压的扩展”，目录选择本项目的 `dist/`。
4. 打开普通 `http` / `https` 英文网页，选中单词或不超过 30 个英文词的句子。
5. 点击扩展工具栏中的“右键查词工具”，配置 API Key、Base URL 和模型。
6. 打开普通 `http` / `https` 英文网页并选词，验证真实流式响应。
7. 使用 `Alt+Shift+L` 验证自动查词总开关。

各厂商 API 预设与官方资料核对记录见 [docs/API_PROVIDERS.md](./docs/API_PROVIDERS.md)。
