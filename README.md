# GPTAudioPlugin

A local-first ChatGPT audio creation plugin.

ChatGPT remains the text reasoning layer: it turns the current conversation into a concise creative summary and a production-ready music-director prompt. GPTAudioPlugin handles Replicate account connection, model capability detection, optional reference audio, and generation.

## v0.2 flow

```text
ChatGPT conversation
  ├─ conversationSummary
  └─ directorPrompt
          │
          ▼
open_audio_studio (no auth)
          │
          ▼
ChatGPT plugin UI
  ├─ Connect / Check Replicate model
  ├─ upload or record audio when the model supports it
  └─ review generation settings
          │
          ▼
OAuth-protected MCP tools
          │
          ▼
user's own Replicate account
          │
          ▼
selected Replicate model
```

There is no separate OpenAI/text-model API in this architecture.

## Replicate connection

Replicate currently authenticates its public API with API tokens rather than a third-party OAuth consent flow.

GPTAudioPlugin therefore acts as the OAuth authorization server seen by ChatGPT:

1. ChatGPT starts OAuth 2.1 Authorization Code + PKCE.
2. GPTAudioPlugin opens a **Connect Replicate** page.
3. The page links the user to Replicate's API-token page.
4. The user pastes their Replicate token into the authorization page, not into chat.
5. GPTAudioPlugin validates it with `GET https://api.replicate.com/v1/account`.
6. The Replicate token is encrypted at rest under `.data/`.
7. GPTAudioPlugin issues ChatGPT an opaque OAuth access/refresh token.
8. Protected MCP tools resolve the OAuth session back to that user's Replicate credential.

The Replicate token is never returned to the model or widget.

### OAuth endpoints

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/authorize
/token
/mcp
```

Protected tools:

- `get_replicate_profile`
- `inspect_replicate_model`
- `generate_music`

`open_audio_studio` remains public so the UI can open before account linking.

## Replicate model compatibility

Replicate is a general model-hosting platform, so **not every model accepts audio** and input field names are not standardized.

GPTAudioPlugin does not assume a fixed schema. For the selected model it fetches the Replicate OpenAPI input schema and detects:

- text prompt field;
- audio/reference field;
- duration field;
- continuation field;
- output format field;
- required inputs that the plugin does not yet know how to provide.

The UI enables **Upload audio** and **Record** only when the selected model exposes a recognizable audio input.

Examples of possible model shapes:

```text
text-only:
  prompt

audio-conditioned:
  prompt + input_audio

another audio model:
  text + reference_audio

unsupported for this plugin:
  prompt + required custom_parameter
```

If reference audio is supplied to a model with no audio input, generation fails explicitly instead of silently ignoring the audio.

The default adapter still contains MusicGen-specific defaults where its schema exposes them, while unknown Replicate models use schema-based generic mapping.

## Requirements

- Windows 10/11
- Node.js 18+ (Node 22 recommended)
- ChatGPT desktop/app surface with plugin/MCP Apps support
- A Replicate account

## Local setup

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

No `REPLICATE_API_TOKEN` is required in `.env`.

Health check:

```text
http://127.0.0.1:8787/
```

MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

OAuth metadata:

```text
http://127.0.0.1:8787/.well-known/oauth-protected-resource
http://127.0.0.1:8787/.well-known/oauth-authorization-server
```

## Local OAuth testing

Run:

```powershell
npm run inspect
```

Use the MCP Inspector Auth flow to test OAuth discovery, PKCE, linking, model inspection, and generation.

For a published ChatGPT plugin, the MCP and OAuth endpoints need a stable public HTTPS origin. Set:

```env
PUBLIC_BASE_URL=https://your-plugin.example.com
```

The local `http://127.0.0.1:8787` configuration is for Windows development. Whether ChatGPT Desktop itself accepts the full OAuth connection flow against loopback HTTP depends on the current developer surface; production should use HTTPS.

## Reference audio transport

ChatGPT supplies a temporary download URL for an uploaded or recorded clip.

GPTAudioPlugin downloads the clip server-side and passes it to the Replicate JavaScript client as a file. This is more robust than asking the Replicate worker to fetch ChatGPT's temporary URL directly.

Replicate supports file inputs up to 100 MB through its client upload path.

## Build plugin ZIP

```powershell
npm run package:plugin
```

Output:

```text
dist/gpt-audio-plugin.zip
```

The ZIP contains the portable plugin manifests and skill. The local MCP server is still a separately running process during Windows development.

## Project structure

```text
GPTAudioPlugin/
├─ plugin.json
├─ mcp.json
├─ .mcp.json
├─ .codex-plugin/
│  └─ plugin.json
├─ skills/audio-creator/SKILL.md
├─ public/audio-widget.html
├─ src/
│  ├─ auth.ts
│  ├─ replicate.ts
│  └─ server.ts
├─ scripts/package-plugin.ps1
└─ README.md
```

## Next

- Validate ChatGPT Desktop's loopback OAuth behavior on Windows.
- If loopback OAuth is rejected, deploy only the MCP/Auth edge to HTTPS while keeping development local.
- Add a Replicate model browser filtered to audio/music generation models.
- Add explicit adapters for popular Replicate music models whose schemas use non-standard fields.
- Add generation history and durable output storage.
