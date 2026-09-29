# GPTAudioPlugin

A UI-less ChatGPT music-generation plugin.

The main plugin deliberately does **not** provide its own recording/upload panel. Users stay in the normal ChatGPT conversation, attach an audio recording with ChatGPT's native attachment control, and ask ChatGPT to generate or continue music from the conversation plus that attachment.

A microphone/recording UI can be developed later as a separate plugin.

## v0.3 flow

```text
normal ChatGPT conversation
        +
native ChatGPT audio attachment (optional)
        │
        ├─ ChatGPT creates conversationSummary
        └─ ChatGPT creates directorPrompt
        │
        ▼
generate_music(...)
        │
        ├─ first use -> Connect Replicate
        ├─ inspect selected model schema
        ├─ reject attachment if model has no audio input
        └─ pass supported attachment to Replicate
        │
        ▼
generated audio URL
```

There is no separate OpenAI/text-model API and no embedded audio widget.

## Why no custom audio UI?

The conversation itself is part of the creative input. A separate recording panel adds an unnecessary interaction boundary when ChatGPT already has native file attachments.

The primary workflow is therefore:

1. discuss the song/BGM/scene normally;
2. attach an MP3/WAV/etc. directly to the ChatGPT message when needed;
3. ask GPTAudioPlugin to generate music;
4. ChatGPT combines the existing conversation context with the attachment in one tool call.

## Replicate connection

Replicate's public API currently uses API tokens rather than a third-party OAuth consent flow.

GPTAudioPlugin acts as the OAuth authorization server seen by ChatGPT:

1. a protected tool triggers ChatGPT's Connect flow;
2. GPTAudioPlugin opens a **Connect Replicate** authorization page;
3. the user opens Replicate's API-token page and creates/copies a token;
4. the token is pasted into the authorization page, never into chat;
5. GPTAudioPlugin validates it against Replicate;
6. the token is encrypted locally under `.data/`;
7. ChatGPT receives opaque OAuth access/refresh tokens.

Protected tools:

- `get_replicate_profile`
- `inspect_replicate_model`
- `generate_music`

## Native audio attachment

`generate_music` exposes an optional `referenceAudio` file parameter. The skill tells ChatGPT to pass the user's normal conversation attachment into this parameter.

The MCP server downloads the temporary ChatGPT file URL and hands a File object to the Replicate SDK.

The user does not need to:

- open another plugin panel;
- click another upload button;
- record inside an iframe;
- repeat the creative context manually.

## Replicate model compatibility

Not every Replicate-hosted model accepts audio.

Before generation, the server inspects the selected model's OpenAPI input schema and detects:

- text prompt field;
- reference/audio field;
- duration field;
- continuation field;
- output-format field;
- required inputs not yet supported by the generic adapter.

Default:

```text
meta/musicgen
```

MusicGen supports reference audio. If a user selects a text-only model and also attaches audio, generation fails explicitly rather than silently ignoring the file.

## Local development

```powershell
git clone git@github.com:Lisuiwen/GPTAudioPlugin.git
cd GPTAudioPlugin
npm install
Copy-Item .env.example .env
npm run dev
```

Default configuration:

```env
REPLICATE_MODEL=meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

No `REPLICATE_API_TOKEN` is stored in `.env`.

MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

OAuth metadata:

```text
http://127.0.0.1:8787/.well-known/oauth-protected-resource
http://127.0.0.1:8787/.well-known/oauth-authorization-server
```

## Tools

### generate_music

Main user-facing tool. Inputs include:

- `conversationSummary`
- `directorPrompt`
- optional `referenceAudio` from the normal ChatGPT attachment
- optional `model`
- `duration`
- optional `continuation`

### inspect_replicate_model

Schema/capability inspection for alternative Replicate models.

### get_replicate_profile

Returns the connected Replicate identity for account UI.

## Package

```powershell
npm run package:plugin
```

Output:

```text
dist/gpt-audio-plugin.zip
```

The portable package contains the manifests and skill only. There is no embedded audio UI.

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
│  ├─ replicate.ts
│  └─ server.ts
├─ scripts/package-plugin.ps1
└─ README.md
```

## Separate future plugin

A dedicated recorder plugin can later provide microphone capture, waveform editing, trimming, and take management. That product should remain separate from this context-first generation plugin.
