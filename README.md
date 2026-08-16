# Volcengine Pi Extensions

用于开发和安装火山引擎 Pi Provider 的 pnpm monorepo。仓库包含三个互不冲突、可独立安装的扩展：

| 包 | Provider ID | 用途 |
| --- | --- | --- |
| `packages/volcengine-ark` | `volcengine` | 普通方舟推理接入点 |
| `packages/volcengine-coding-plan` | `volcengine-coding-plan` | Coding Plan 个人版 |
| `packages/volcengine-agent-plan` | `volcengine-agent-plan` | Agent Plan 个人版 |

## 环境要求

- Node.js >= 22.19
- pnpm 11
- Pi `@earendil-works/pi-coding-agent` 0.84.2 或兼容版本

## 开发

```bash
pnpm install
pnpm check
pnpm test

pnpm dev:ark
pnpm dev:coding-plan
pnpm dev:agent-plan
```

三个包都使用 Pi 原生动态 Provider。Pi 会持久化最后一次成功拉取的动态目录；刷新失败不会清除已缓存模型。

## 安装

按需安装一个或多个包：

```bash
pi install -l ./packages/volcengine-ark
pi install -l ./packages/volcengine-coding-plan
pi install -l ./packages/volcengine-agent-plan
```

安装后重启 Pi，或在 Pi 中执行 `/reload`。

## 普通方舟

普通方舟需要两组凭据：

- API Key：调用推理数据面。
- Access Key / Secret Key：签名调用北京地域 `ListEndpoints`，自动分页拉取接入点。

推荐在 Pi 中执行 `/login`，选择 `volcengine` 并依次输入三项凭据。也支持环境变量：

```bash
export VOLCENGINE_API_KEY="..."
export VOLCENGINE_ACCESS_KEY_ID="..."
export VOLCENGINE_SECRET_ACCESS_KEY="..."
```

只有处于可调用状态的文本/Chat 接入点会注册为聊天模型。图片和视频模型保留在同一
Extension 的媒体目录中，并通过原生工具调用，不会被注册成 `openai-completions`。
Pi 中显示纯聊天模型名称，例如
`deepseek-v4-pro`；Endpoint ID 会保存在内部，并在实际推理时自动使用。若存在同名接入点，后出现的模型会添加短后缀以保持 ID 唯一。
模型目录缺少能力元数据时，扩展使用保守默认值：128K context、16K output，并根据基础模型名称谨慎推断视觉与推理能力。

首次启动时若没有 AK/SK，普通方舟目录为空，刷新结果会提示运行 `/login`。推理 API Key 与 AK/SK 可来自环境变量或 Pi 凭据存储，但不会写入日志或错误消息。

普通方舟 Extension 同时注册以下媒体工具：

- `generate_image`：生成或编辑图片，下载结果并以内联图片返回。
- `generate_video`：创建视频任务、轮询进度并下载完成的视频。
- `get_video_task`：恢复查询超时或中断的视频任务。

使用 `/media-models` 查看媒体模型，使用 `/media-refresh` 强制刷新目录。多个同类模型并存时，
通过工具的 `model` 参数指定，或设置默认模型：

```bash
export VOLCENGINE_IMAGE_MODEL="doubao-seedream-..."
export VOLCENGINE_VIDEO_MODEL="doubao-seedance-..."
# 默认保存到当前项目的 .pi/media
export VOLCENGINE_MEDIA_DIR="./artifacts/media"
```

生成产物会立即下载，并附带 JSON 元数据。图片支持本地路径、HTTP(S)、TOS 和 data URL 参考图；
视频支持首帧、尾帧、比例、分辨率、时长、随机种子、水印和音频生成参数。

## Coding Plan

在 Pi 中执行 `/login` 并选择 `volcengine-coding-plan`，或设置：

```bash
export VOLCENGINE_CODING_PLAN_API_KEY="..."
# 兼容旧变量名：
export VOLCENGINE_PLAN_API_KEY="..."
export VOLCENGINE_ACCESS_KEY_ID="..."
export VOLCENGINE_SECRET_ACCESS_KEY="..."
```

Coding Plan API Key 用于推理；AK/SK 用于签名调用官方模型目录：

```text
POST https://ark.cn-beijing.volcengineapi.com/?Action=ListArkCodingPlanModel&Version=2024-01-01
```

扩展只注册该接口实时返回的 `ModelID`，不包含硬编码模型列表。接口不可用、鉴权失败或响应格式变化时，Pi 保留最近一次成功目录；首次启动没有 AK/SK 或拉取失败时目录为空。

## Agent Plan

在 Pi 中执行 `/login` 并选择 `volcengine-agent-plan`，或设置：

```bash
export VOLCENGINE_AGENT_PLAN_API_KEY="..."
# 兼容变量：
export ARK_API_KEY="..."
export VOLCENGINE_ACCESS_KEY_ID="..."
export VOLCENGINE_SECRET_ACCESS_KEY="..."
```

Agent Plan API Key 用于推理；AK/SK 用于签名调用官方模型目录：

```text
POST https://ark.cn-beijing.volcengineapi.com/?Action=ListArkAgentPlanModel&Version=2024-01-01
```

扩展只注册接口实时返回的 `ModelID`，不包含硬编码模型列表。Agent Plan 模型保留以下兼容配置：

- 使用 `max_tokens`。
- 不发送 `developer` role。
- 使用 DeepSeek 风格 thinking。
- DeepSeek 模型支持 `xhigh -> max` reasoning level 映射。

## 模型刷新与故障行为

- 所有目录请求都有 15 秒超时，并合并 Pi 提供的 `AbortSignal`。
- 401/403 会提示重新登录。
- 网络错误、5xx、超时、取消、畸形 JSON 不会发布新目录，因此不会清空缓存。
- 空数组是有效远端结果；两个 Plan 包都不提供静态模型基线。
- Plan 订阅及无法确定价格的普通方舟模型，Pi `cost` 暂使用零值。该值不代表免费。
- 当前仅支持中国北京地域与个人版 Coding/Agent Plan。

## 手动真实凭据验收

真实凭据测试不会由 `pnpm test` 自动执行。分别安装并配置三个 Provider 后：

1. 使用 `/login` 配置对应凭据。
2. 使用 `/model` 检查动态模型。
3. 在终端执行 `pi --list-models`，确认 Provider ID、模型 ID 和能力元数据。
4. 分别发送一次纯文本请求；视觉模型再发送一次图片请求。
5. 临时撤销网络或使用无效凭据，确认刷新报错但之前缓存的目录仍然存在。

不要把真实 API Key、Access Key 或 Secret Key 放进仓库、测试 fixture、命令输出或 issue。

## npm 发布

仓库包含自动 CI 和手动 npm 发布工作流。授权准备、dry-run 和版本 bump 操作见
[`docs/npm-release.md`](./docs/npm-release.md)。
