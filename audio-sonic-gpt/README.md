# Audio Sonic Listener — ChatGPT adapter

This directory wraps the vendored [Audio Sonic MCP](../vendor/audio-sonic-mcp/) for ChatGPT without changing its analysis algorithms.

## Architecture

```text
ChatGPT conversation
  + native audio attachment
        |
        v
audio-sonic-gpt/server.ts
  - receives openai/fileParams
  - downloads the temporary attachment
  - optionally trims startSec/endSec with FFmpeg
  - starts a background analysis job
        |
        v
vendor/audio-sonic-mcp/analyze_file.py
        |
        +-- Demucs (optional, local)
        +-- LAION CLAP (optional, local)
        +-- librosa / soundfile / numpy
        |
        v
sonic signature JSON
        |
        v
ChatGPT explains the result in the current conversation
```

No external music-model API is required.

## What is preserved

The upstream Audio Sonic source is copied under `vendor/audio-sonic-mcp/`.
The adapter does not edit the vendored pipeline files. See
`vendor/audio-sonic-mcp/UPSTREAM.md` for provenance.

## Tools exposed to ChatGPT

### `submit_music_analysis`

Accepts a native ChatGPT audio attachment and immediately returns a job ID.

Optional:

- `startSec`
- `endSec`

When a segment is requested, the adapter creates a temporary WAV with FFmpeg
and analyzes that clip.

### `get_music_analysis`

Polls a submitted job. On success it returns the Audio Sonic signature,
including tempo, key/key map, vibe tags when CLAP is installed, vocal presence,
transient punch, stereo width and frequency information.

The 512-float CLAP vector is intentionally omitted from the ChatGPT response to
avoid wasting context tokens.

### `check_audio_sonic_health`

Checks the local Python runtime, FFmpeg and vendored analyzer path.

## Windows local setup

Run these commands from the repository root.

```powershell
npm install

cd vendor/audio-sonic-mcp
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[clap]"
cd ..\..
```

Install FFmpeg if it is not already available:

```powershell
winget install Gyan.FFmpeg
```

The full optional stack downloads local model weights on first use. Audio Sonic
currently documents roughly 400 MB for Demucs and roughly 200 MB for CLAP.

## Start the ChatGPT-facing MCP

From the repository root:

```powershell
npx tsx audio-sonic-gpt/server.ts
```

Default endpoint:

```text
http://127.0.0.1:8790/mcp
```

Health metadata:

```text
http://127.0.0.1:8790/
```

For ChatGPT local development, expose this local Streamable HTTP MCP using the
ChatGPT developer-mode secure local tunnel. For deployment, publish the same
endpoint over HTTPS.

## Environment variables

Copy `.env.example` if needed.

- `AUDIO_SONIC_PORT` — default `8790`
- `AUDIO_SONIC_PYTHON` — explicit Python executable
- `AUDIO_SONIC_FFMPEG` — explicit FFmpeg executable
- `AUDIO_SONIC_MAX_UPLOAD_MB` — default `100`
- `AUDIO_SONIC_VENDOR_DIR` — override vendored source path

If `AUDIO_SONIC_PYTHON` is omitted, the adapter first looks for the Python
inside `vendor/audio-sonic-mcp/.venv`, then falls back to `python`.

## Important capability boundary

Audio Sonic is primarily a music-information-retrieval pipeline plus CLAP
semantic tagging. It **does** analyze the real waveform locally. It is useful
for objective and semi-semantic evidence such as BPM, key, structure, production
profile and vibe tags.

It is **not** yet a general audio-language model that can freely reason about
questions such as "why does the flute feel too dominant at 0:42?" from raw audio.
A later adapter can add a local audio LLM (for example a quantized Qwen Omni
family model) while keeping Audio Sonic as the deterministic measurement layer.
