# GPTAudioPlugin / GPTAudioMCP

A small, UI-less ChatGPT plugin plus a self-owned MCP for both music generation and multimodal music listening.

The design deliberately keeps two concerns separate:

```text
ChatGPT plugin
  = conversation context + native attachment workflow

GPTAudioMCP
  = stable music tool contract + provider adapters
```

Replicate is the only provider. Starting in v0.6, generation stays on Replicate but routes different music tasks to different Replicate models.

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

Primary generation/transform tool.

Inputs:

- `provider` — `replicate`
- optional `model` — explicit Replicate model override
- `generationMode` — `auto | generate | cover | reference | continue`
- `conversationSummary`
- `directorPrompt`
- `duration`
- optional `lyrics`
- `instrumental`
- `autoLyrics`
- optional `referenceAudio` from ChatGPT's normal attachment control
- optional `continuation` for backward compatibility

The file input uses ChatGPT's standard `openai/fileParams` contract.

Default Replicate routing:

```text
new instrumental / BGM       -> fishaudio/ace-step-1.5
new vocal song               -> minimax/music-2.6
vocal reference cover/remix  -> minimax/music-cover
melody reference             -> meta/musicgen (stereo-melody-large)
continuation                 -> meta/musicgen (stereo-melody-large)
```

An explicit `model` bypasses automatic model selection.

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

Default new-music model:

```text
fishaudio/ace-step-1.5
```

Reference-cover model:

```text
minimax/music-cover
```

MusicGen remains the reference-melody and continuation fallback.

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
REPLICATE_MODEL=fishaudio/ace-step-1.5
REPLICATE_COVER_MODEL=minimax/music-cover
REPLICATE_VOCAL_MODEL=minimax/music-2.6
REPLICATE_CONTINUATION_MODEL=meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb
REPLICATE_ANALYSIS_MODEL=lucataco/qwen2.5-omni-7b
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

## Deployment and OAuth recovery (v0.6.0)

Use a stable HTTPS endpoint with the current build. The plugin version and MCP
server version must both be `0.6.0`. Updating the installed skills alone does not
update the remote server.

Run `npm run typecheck`, `npm test`, and `npm run package:plugin` before release.
After deploying, run `npm run check:mcp`. This verifies the deployed version,
all four tools, and the unauthenticated OAuth challenge without generating or
analyzing music. Pass another endpoint with `npm run check:mcp -- <mcp-url>`.

OAuth profiles, access tokens, refresh tokens, authorization codes, and the
encryption key must survive restarts. Set `AUTH_DATA_DIR` to an absolute path on
persistent storage, for example `/var/data/gpt-audio`. Preserve both
`auth-store.json` and `auth.key`. Alternatively keep the same 32-byte base64
`AUTH_ENCRYPTION_KEY` across deployments, while still persisting the store.
Writes to the store are atomic; malformed existing stores are preserved for
recovery instead of being silently replaced with an empty store.

The supplied `render.yaml` uses a Free instance for temporary testing.
For an existing standalone Render service, change that service's compute plan,
attach the disk at `/var/data/gpt-audio`, set `AUTH_DATA_DIR` to the same path,
and set `PUBLIC_BASE_URL` to its public HTTPS origin. Do not create a duplicate
service to apply these settings. A paid compute instance and a 1 GB disk are
needed for this persistent setup. Render Free instances cannot attach disks and lose local
files when they spin down, restart, or redeploy; Free is only suitable for a
temporary smoke test of this file-backed OAuth implementation.

If a client reports `invalid_grant`, the old refresh token cannot be recovered
after the server has lost its store. After configuring persistent storage and
deploying, reconnect Replicate through the plugin's authorization page. In
Codex, use:

```powershell
codex plugin marketplace upgrade gpt-audio-local
codex plugin add gpt-audio-plugin@gpt-audio-local
codex mcp logout gpt-audio
codex mcp login gpt-audio
```

Restart the desktop app after the plugin update if the current session retains
the old tool catalog. In ChatGPT, reconnect the plugin's account connection.
Never paste the Replicate API token into chat.

If Render reports a GitHub repository `404` during deploy, reconnect its GitHub
integration and grant access to this private repository. A successful local
Git push does not establish Render's permission to clone the repository.

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
