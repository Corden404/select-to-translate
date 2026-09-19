# 大模型 API 预设

本项目的核心调用协议统一为 OpenAI-compatible `/chat/completions`，并允许用户在弹出设置页修改 Base URL 与模型名。

## DeepSeek

- Base URL: `https://api.deepseek.com`
- 默认模型: `deepseek-flash`
- 官方文档: https://api-docs.deepseek.com/zh-cn/

DeepSeek 官方文档明确提供 OpenAI 兼容格式。当前项目默认选择偏速度的 `deepseek-flash`。

## 智谱 GLM

- Base URL: `https://open.bigmodel.cn/api/paas/v4`
- 默认模型建议: `glm-4.5`
- 官方文档: https://docs.bigmodel.cn/

智谱官方示例使用上述 Base URL 并通过 `client.chat.completions.create(...)` 调用。不同账户可用模型可能不同，因此模型名始终允许手动修改。

## 小米 MiMo

- Base URL: `https://api.xiaomimimo.com/v1`
- 默认模型: `mimo-v2.5`
- 官方文档: https://platform.xiaomimimo.com/docs/

MiMo 官方文档提供 OpenAI-compatible Chat Completions。查词场景默认不附加深度思考参数，优先降低延迟。

### MiMo-V2.5-TTS（默认发音）

- Base URL：`https://api.xiaomimimo.com/v1`
- Endpoint：`POST /chat/completions`
- Model：`mimo-v2.5-tts`
- 官方文档：https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
- 当前价格：官方标注“限时免费”，模型页注明当前不消耗 Token Plan credits；未公布固定结束日期。
- 预置英文音色：`Mia`、`Chloe`、`Milo`、`Dean`
- 非流式：`audio={"format":"wav","voice":"Mia"}`，响应在 `choices[0].message.audio.data` 返回 base64 WAV。
- 流式：基础 `mimo-v2.5-tts` 已支持低延迟实时流式；格式需使用 `pcm16`，返回 24kHz PCM16LE mono 音频块。
- 调用规则：真正要朗读的文本必须放在 `assistant` role；`user` role 可选，用于自然语言控制语速、情绪、口音和表达风格。

本项目查词场景默认使用非流式 WAV，因为单词/短词组很短，能直接交给浏览器 `Audio` 播放，代码复杂度更低。默认 `Mia`，并用 `user` 风格指令要求清晰自然的 British English dictionary-style pronunciation。官方没有声明这四个英文 voice ID 各自是英音还是美音，因此不把 `Mia` 描述成“官方英音音色”。

TTS 只在用户点击发音按钮时调用，不会随每次选词自动请求。若主模型平台为 MiMo，TTS Key 留空可复用主 API Key；否则可单独配置 MiMo TTS Key。

## 阿里云千问

- 默认兼容 Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- 默认模型: `qwen-plus`
- 官方文档: https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope

阿里云目前针对部分地域推荐业务空间专属域名，例如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。因此弹出页中的 Base URL 可直接编辑。

## 有道智云词典（备用发音）

- 词典接口：`https://openapi.youdao.com/v2/dict`
- 官方文档：https://ai.youdao.com/DOCSIRMA/html/dictionary/api/ydcd/index.html
- 鉴权：`signType=v3`，`sign=sha256(appKey + input + salt + curtime + appSecret)`
- 英式音标字段：`ukPhonetic`
- 英式音频字段：`ukSpeech`

有道现在作为备用 Provider。用户在发音设置中主动切换到有道并填写 AppKey / 应用密钥后才会调用该接口。服务权限、计费和数据使用规则以用户自己的有道智云账户与官方条款为准。

## 自定义 OpenAI-compatible

只要服务提供 Bearer API Key，并兼容：

`POST {baseUrl}/chat/completions`

以及标准 SSE 流式 `choices[0].delta.content`，即可直接使用。
