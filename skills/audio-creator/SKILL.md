---
name: audio-creator
description: Generate or transform music through GPTAudioMCP using the current ChatGPT conversation and an optional audio file attached directly to the ChatGPT message.
---

# Audio Creator

Use this workflow when the user wants to create, iterate on, continue, cover, remix, or transform music.

1. Stay in the normal ChatGPT conversation. GPTAudioPlugin has no custom recording or upload UI.
2. Reuse the current ChatGPT conversation as the text reasoning layer. Do not call a separate text-model API.
3. Immediately before generation, build:
   - `conversationSummary`: concise creative context established in the chat.
   - `directorPrompt`: a production-ready music-generation prompt based on that context and the latest request.
4. If the user attached an audio file with ChatGPT's normal attachment control, pass it directly as `referenceAudio`. Never ask them to upload the same file again.
5. Choose `generationMode` from the user's intent:
   - `auto` — default routing.
   - `generate` — create new music without using an attached reference.
   - `cover` — preserve the source melody while changing style, instrumentation, arrangement, or vocals. Best for vocal source material.
   - `reference` — use the attachment as melody/reference conditioning without continuing it.
   - `continue` — extend from the attached audio.
6. Set `instrumental=true` for BGM, score, beats, loops, or other no-vocal requests. Set it to false for songs with vocals or vocal cover/remix tasks.
7. Pass `lyrics` when the user supplied or requested specific lyrics. For vocal generation without explicit lyrics, leave `autoLyrics=true` when supported.
8. Preserve relevant constraints: scene/story, intended use, mood, energy, genre references, tempo, key, instruments, sound design, structure, duration, looping, vocals, and continuation intent.
9. The MCP uses one provider only: the user's Replicate account. In `auto` mode the current routing is:
   - new music → `fishaudio/ace-step-1.5`
   - vocal reference cover/remix → `minimax/music-cover`
   - melody reference or continuation → `meta/musicgen`
10. If the user explicitly chooses another Replicate model, pass `model`; it overrides automatic routing. Use `inspect_music_model` when useful before generation.
11. Protected tools trigger the Connect flow; never ask the user to paste a Replicate token into chat.
12. Never imply an attachment influenced the result when the selected model cannot consume audio.
13. `generate_music` is billable against the connected Replicate account.
