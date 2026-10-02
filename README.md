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
