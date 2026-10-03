# GPTAudioPlugin / GPTAudioMCP

A small, UI-less ChatGPT plugin plus a self-owned MCP for both music generation and multimodal music listening.

The design deliberately keeps two concerns separate:

```text
ChatGPT plugin
  = conversation context + native attachment workflow

GPTAudioMCP
  = stable music tool contract + provider adapters
```

Replicate is the only provider enabled in v0.4, but the MCP no longer hard-wires provider logic into the tool layer.

## User flow

```text
normal ChatGPT conversation
        +
native ChatGPT audio attachment (optional)
        │
        ├─ ChatGPT creates conversationSummary
        └─ ChatGPT creates directorPrompt
        │
        ▼
GPTAudioMCP.generate_music
        │
        ├─ first use -> Connect Replicate
        ├─ select provider adapter
        ├─ inspect model schema
        ├─ map native attachment when supported
        └─ run generation
        │
        ▼
generated audio URL
```

There is no embedded widget and no separate OpenAI text-model API.

## Why own the MCP?

Existing music MCPs are useful references, but owning the MCP keeps the ChatGPT-facing contract stable:

- native ChatGPT file parameter shape stays under our control;
- conversation-to-music fields stay consistent;
- provider changes do not require changing the plugin workflow;
- authentication stays aligned with the provider we support;
- incompatible audio models fail explicitly rather than silently discarding the attachment.

## MCP tools

### `analyze_music`

Listens to a native ChatGPT audio attachment with a multimodal audio-language model on Replicate and returns text analysis grounded in the actual audio.

Inputs:

- `audio` — required native ChatGPT audio attachment
- `question` — what the user wants to know about the audio
- optional `conversationSummary`
- optional `analysisFocus` list
- optional `model`

Default analysis model:

```text
lucataco/qwen2.5-omni-7b
```

The provider disables audio output when the selected model exposes `generate_audio`, because ChatGPT only needs the textual listening result.


### `generate_music`

Primary tool.

Inputs:

- `provider` — currently only `replicate`
- optional `model`
- `conversationSummary`
- `directorPrompt`
- `duration`
- optional `referenceAudio` from ChatGPT's normal attachment control
- optional `continuation`

The file input uses ChatGPT's standard `openai/fileParams` contract.

### `inspect_music_model`

Reads the provider model schema and reports whether it accepts a text prompt, reference audio, duration, continuation, output format, and any unsupported required inputs.

### `get_music_provider_profile`

Returns the connected provider identity. v0.4 maps this to the connected Replicate account.

## Provider layer

```text
src/providers/
├─ types.ts
├─ index.ts
└─ replicate.ts
```

`MusicProvider` defines the internal contract:

```ts
interface MusicProvider {
  id
  defaultModel
  inspectModel(credential, model)
  generate(credential, request)
}
```

Adding another backend later should be a provider implementation instead of a rewrite of the ChatGPT tool contract.

## Replicate behavior

The Replicate adapter:

1. fetches the selected model's OpenAPI input schema;
2. detects common prompt/audio/duration/continuation fields;
3. downloads the temporary ChatGPT attachment;
4. converts it to a `File` for the Replicate SDK;
5. rejects audio when the selected model has no recognizable audio input;
6. runs the prediction and extracts the returned audio URL.

Default model:

```text
meta/musicgen
```

## Account connection

Replicate's public API uses API tokens rather than a third-party OAuth consent flow.

GPTAudioMCP therefore exposes MCP OAuth to ChatGPT while using an encrypted Replicate token behind that connection:

1. ChatGPT triggers Connect.
2. The authorization page links to Replicate's API-token page.
3. The user pastes the token into the authorization page, not chat.
4. The MCP validates it against Replicate.
5. The credential is encrypted under `.data/`.
6. ChatGPT receives opaque OAuth access/refresh tokens.

## Local development

```powershell
git clone git@github.com:Lisuiwen/GPTAudioPlugin.git
cd GPTAudioPlugin
npm install
Copy-Item .env.example .env
npm run dev
```

Defaults:

```env
REPLICATE_MODEL=meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb
REPLICATE_ANALYSIS_MODEL=lucataco/qwen2.5-omni-7b
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

## GPT 桌面端：Sites 托管 MCP（v0.6.0）

服务部署到 Sites，提供无会话的 HTTP `POST /mcp`。Sites 负责桌面端连接的 OAuth、登录和访问控制；服务只使用平台提供的用户身份，不再在托管端运行自己的 OAuth 授权服务器。

1. 在桌面端的「Plugins → Personal → Created by you」中安装或连接 Sites 自动创建的 GPT Audio MCP 插件。
2. 打开部署后的站点，登录并连接 Replicate。API 令牌只在连接页面输入，不能发送到对话中。
3. 回到桌面端，先调用 `get_music_provider_profile` 验证账号，再调试音乐生成或音频分析。

每位用户的 Replicate 连接独立保存到 D1，令牌使用 AES-GCM 加密，并绑定该用户身份。更新服务不会丢失连接。部署前通过 Sites 环境变量设置固定的 32 字节 base64 `AUTH_ENCRYPTION_KEY`，后续部署保留同一个密钥。D1 的逻辑绑定为 `DB`；表结构迁移位于 `drizzle/`，由 Sites 在发布时执行。

`.openai/hosting.json` 保存此项目的 Sites 标识、D1 绑定和 MCP 能力。`src/worker.ts` 为托管入口，构建产物为 `dist/server/index.js`。音乐工具与本机入口共用 `src/music-server.ts` 和 provider 适配器。

发布前运行：

```powershell
npm run typecheck
npm test
```

修改数据库结构时运行 `npm run db:generate` 并检查生成的 SQL。已经发布的迁移不能重写，应追加新迁移。之后使用桌面端的 Sites 托管工具保存和发布当前构建；复用现有项目标识，不重复创建站点。Sites 会自动创建并维护对应插件。

### 本机开发入口

`mcp.json` 和 `.mcp.json` 只用于本机开发，默认地址为 `http://127.0.0.1:8787/mcp`；Sites 插件使用平台提供的连接入口。项目已关闭旧的本机插件自动启用，避免调试时调用旧的服务。

本机 Node 服务保留原有 OAuth 流程，授权数据保存在 `AUTH_DATA_DIR` 或 `.data/`。本机服务运行后，执行 `npm run check:mcp`，验证版本、四个工具和未授权时的 OAuth 提示；也可通过参数或 `MCP_URL` 指定其他支持此本机授权流程的 MCP 地址。该脚本不会调用计费的音乐工具。Sites 托管连接应通过已连接的 Sites 插件验证。

如需打包本机插件，执行 `npm run package:plugin`。此包用于本机入口；桌面端的 Sites 托管调试使用 Sites 自动生成的插件。

## Project structure

```text
GPTAudioPlugin/
├─ plugin.json
├─ mcp.json
├─ .mcp.json
├─ .codex-plugin/plugin.json
├─ skills/audio-creator/SKILL.md
├─ src/
│  ├─ auth.ts
│  ├─ providers/
│  │  ├─ types.ts
│  │  ├─ index.ts
│  │  └─ replicate.ts
│  └─ server.ts
├─ scripts/package-plugin.ps1
└─ README.md
```

## Future providers

The intended extension point is now explicit. Possible future providers include Suno gateways, fal.ai, or other hosted/open models, while ChatGPT continues calling the same `generate_music` tool.
