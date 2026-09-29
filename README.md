# GPTAudioPlugin

A local-first ChatGPT audio creation plugin. ChatGPT supplies a concise summary of the current conversation, the plugin lets the user upload or record a reference clip, and a local MCP server sends the final music-generation request to Replicate.

## MVP architecture

```text
ChatGPT conversation
  -> open_audio_studio(contextSummary)
  -> ChatGPT plugin UI
     - edit context summary
     - optional extra prompt
     - upload audio
     - record microphone
  -> generate_music(...)
  -> local MCP server
  -> Replicate
  -> meta/musicgen (default)
  -> generated audio URL
```

No OpenAI API key is required for text analysis in this MVP. ChatGPT summarizes the current conversation and passes that summary into the plugin.

## Requirements

- Windows 10/11
- Node.js 18+
- ChatGPT desktop app with plugin/developer support
- A Replicate API token

## Local setup

```powershell
git clone git@github.com:Lisuiwen/GPTAudioPlugin.git
cd GPTAudioPlugin
npm install
Copy-Item .env.example .env
```

Set `REPLICATE_API_TOKEN` in `.env`, then run:

```powershell
npm run dev
```

The local MCP endpoint is:

```text
http://127.0.0.1:8787/mcp
```

For protocol debugging:

```powershell
npx @modelcontextprotocol/inspector@latest
```

Choose **Streamable HTTP** and connect to `http://127.0.0.1:8787/mcp`.

## Plugin package

The repository root is a portable plugin package:

- `plugin.json` — portable plugin manifest
- `mcp.json` — local MCP connection
- `.codex-plugin/plugin.json` — compatibility manifest
- `skills/audio-creator/SKILL.md` — conversation-to-audio workflow
- `public/audio-widget.html` — embedded ChatGPT UI

The local MCP server must be running before generation works.

## Replicate

The provider is intentionally fixed to Replicate for the MVP. The default model is `meta/musicgen`, which accepts both text and optional reference audio.

```env
REPLICATE_API_TOKEN=
REPLICATE_MODEL=meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb
PORT=8787
```

The Replicate integration is isolated in `src/replicate.ts`, so later we can add model-specific adapters without changing the ChatGPT/MCP contract.

## MVP flow

1. In ChatGPT, discuss the scene, story, emotion, or game context.
2. Ask GPTAudioPlugin to open the audio studio.
3. ChatGPT summarizes the current conversation into `contextSummary`.
4. Optionally upload an audio file or record a melody/idea.
5. Press **Generate with Replicate**.
6. The local MCP server calls Replicate and returns the generated audio URL.

## Current scope

- portable plugin packaging
- local Streamable HTTP MCP server
- current-conversation summary handoff
- audio upload using ChatGPT file APIs
- microphone recording in the widget
- Replicate MusicGen generation
- generated audio playback in the widget

Next:

- Replicate model picker
- creation history
- structured music-director controls (tempo, instrumentation, form)
- additional Replicate music-model adapters
