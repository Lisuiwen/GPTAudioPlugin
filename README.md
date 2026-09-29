# GPTAudioPlugin

A local-first ChatGPT audio creation plugin. ChatGPT supplies **two separate text inputs from the current conversation**:

1. a concise conversation summary;
2. a production-ready GPT music-director prompt.

The plugin then lets the user upload or record a reference clip and sends the final request to Replicate. There is no separate OpenAI/text-model API in the MVP.

## MVP architecture

```text
ChatGPT conversation
  ├─ conversationSummary
  └─ directorPrompt
          │
          ▼
open_audio_studio(...)
          │
          ▼
ChatGPT plugin UI
  ├─ review/edit both text fields
  ├─ upload audio
  └─ record microphone
          │
          ▼
generate_music(...)
          │
          ▼
local MCP server
          │
          ▼
Replicate
          │
          ▼
meta/musicgen (default)
          │
          ▼
generated audio URL
```

## Requirements

- Windows 10/11
- Node.js 18+
- ChatGPT desktop/app surface with plugin/MCP Apps support
- A Replicate API token

## Local setup

```powershell
git clone git@github.com:Lisuiwen/GPTAudioPlugin.git
cd GPTAudioPlugin
npm install
Copy-Item .env.example .env
notepad .env
npm run dev
```

Set:

```env
REPLICATE_API_TOKEN=r8_your_token_here
REPLICATE_MODEL=meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb
PORT=8787
```

The local MCP endpoint is:

```text
http://127.0.0.1:8787/mcp
```

Health check:

```text
http://127.0.0.1:8787/
```

## Protocol debugging

```powershell
npm run inspect
```

Choose **Streamable HTTP** and connect to `http://127.0.0.1:8787/mcp`.

## Build a local plugin ZIP

The repository contains both the current portable package files and a compatibility overlay:

- `plugin.json`
- `mcp.json`
- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/audio-creator/SKILL.md`

Create a ZIP for the ChatGPT plugin upload UI:

```powershell
npm run package:plugin
```

Output:

```text
dist/gpt-audio-plugin.zip
```

Start the local MCP server before using the installed package.

> Localhost MCP availability can differ by ChatGPT surface. The current package points at `http://127.0.0.1:8787/mcp`. If a client refuses local HTTP MCP endpoints, that surface will require a reachable HTTPS MCP endpoint.

## Current chat context reuse

The plugin does **not** directly scrape or read the complete ChatGPT transcript.

Instead, the current ChatGPT model supplies both values when it calls `open_audio_studio`:

- `conversationSummary`: compact context from the current chat.
- `directorPrompt`: the GPT-authored music direction.

The widget shows both so the user can edit them before spending Replicate credits.

## Audio input

The widget supports:

- uploading an existing audio file;
- recording with `MediaRecorder`;
- passing the file through ChatGPT's plugin file helpers;
- melody guidance with MusicGen;
- optional continuation mode.

## Replicate

The provider is intentionally fixed to **Replicate** for v0.1.

Default model:

```text
meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb
```

The current implementation uses:

- `stereo-large` for text-only generation;
- `stereo-melody-large` when reference audio is supplied;
- MP3 output;
- up to 30 seconds from the current UI.

Replicate API output files are temporary, so persistent creation history should copy generated files to durable storage in a later version.

### License note

The repository code is MIT licensed. MusicGen model weights have their own license (CC-BY-NC 4.0 at the time of this MVP), so model licensing must be reviewed separately before commercial use.

## Project structure

```text
GPTAudioPlugin/
├─ plugin.json
├─ mcp.json
├─ .codex-plugin/
│  └─ plugin.json
├─ .mcp.json
├─ skills/
│  └─ audio-creator/
│     └─ SKILL.md
├─ public/
│  └─ audio-widget.html
├─ src/
│  ├─ server.ts
│  └─ replicate.ts
├─ scripts/
│  └─ package-plugin.ps1
├─ .github/
│  └─ workflows/
│     └─ ci.yml
└─ package.json
```

## Next

- Validate ZIP upload in ChatGPT Desktop on Windows.
- Validate microphone permission inside the ChatGPT iframe.
- Add persistent Replicate token configuration instead of environment-only configuration.
- Add generation progress/history.
- Compare other Replicate-hosted music models after the end-to-end path works.
