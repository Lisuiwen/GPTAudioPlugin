---
name: audio-creator
description: Generate music through GPTAudioMCP using the current ChatGPT conversation and an optional audio file attached directly to the ChatGPT message.
---

# Audio Creator

Use this workflow when the user wants to create, iterate on, continue, or transform music.

1. Stay in the normal ChatGPT conversation. GPTAudioPlugin has no custom recording or upload UI.
2. Reuse the current ChatGPT conversation as the text reasoning layer. Do not call a separate text-model API.
3. Immediately before generation, build:
   - `conversationSummary`: concise creative context established in the chat.
   - `directorPrompt`: a production-ready music-generation prompt based on that context and the latest request.
4. If the user attached an audio file with ChatGPT's normal attachment control, pass it directly as `referenceAudio`. Never ask them to upload the same file again.
5. Preserve relevant constraints: scene/story, intended use, mood, energy, genre references, tempo, instruments, sound design, structure, duration, looping, vocals, and continuation intent.
6. The MCP currently uses the user's Replicate account. Protected tools trigger the Connect flow; never ask the user to paste a Replicate token into chat.
7. For the default model, call `generate_music` directly. The MCP inspects model capabilities internally.
8. If the user explicitly chooses another model, use `inspect_music_model` when useful before generation.
9. Never imply the audio attachment influenced the result when the selected model cannot accept audio. The server rejects incompatible audio inputs.
10. `generate_music` is billable against the connected provider account.
