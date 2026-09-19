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

## 阿里云千问

- 默认兼容 Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- 默认模型: `qwen-plus`
- 官方文档: https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope

阿里云目前针对部分地域推荐业务空间专属域名，例如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。因此弹出页中的 Base URL 可直接编辑。

## 自定义 OpenAI-compatible

只要服务提供 Bearer API Key，并兼容：

`POST {baseUrl}/chat/completions`

以及标准 SSE 流式 `choices[0].delta.content`，即可直接使用。
