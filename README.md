# 右键查词工具

Windows 11 上的英语阅读 AI 查词浏览器扩展。

当前处于 MVP Phase 1 开发阶段。

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

Phase 1 已完成首个可构建版本：

- 普通网页文本选区监听。
- 英文检测、单词/句子分类、30 词上限。
- 单词所在句与句子前后文提取。
- Shadow DOM 悬浮卡片。
- 假流式输出，用于先验证交互体验。
- 新选区取消旧流式结果。
- `Alt+Shift+L` 自动查词总开关，也可点击扩展工具栏图标切换。

真实 LLM、Prompt 管理、历史记录、追问、PDF.js 和有道发音将在后续 Phase 中接入。

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
5. 使用 `Alt+Shift+L` 验证自动查词总开关。

当前卡片内容是 Mock 数据；Phase 1 只验证选区、上下文、定位、流式显示和总开关。
