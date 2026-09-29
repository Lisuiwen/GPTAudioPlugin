---
name: audio-creator
description: Generate music through Replicate using the current ChatGPT conversation and an optional audio file attached directly to the ChatGPT message.
---

# Audio Creator

Use this workflow when the user wants to create, iterate on, continue, or transform music through GPTAudioPlugin.

1. GPTAudioPlugin has no custom UI. Keep the interaction in the normal ChatGPT conversation.
2. Reuse the current ChatGPT conversation as the text reasoning layer. Do not call or ask the plugin to call a separate text-model API.
3. Build two values immediately before generation:
   - `conversationSummary`: concise creative context already established in the current chat.
   - `directorPrompt`: a production-ready music-generation prompt based on that context and the user's latest instruction.
4. If the user attached an audio file using ChatGPT's normal attachment control, treat that attachment as `referenceAudio`. Do not ask the user to upload it again into another panel.
5. Preserve concrete constraints when present: scene/story, intended use, mood, energy, genre references, tempo, instruments, sound design, structure, duration, looping, and vocal requirements.
6. Replicate account access is user-owned. Protected tools trigger the plugin's Connect flow; never request or expose a Replicate token in chat.
7. The default Replicate model is MusicGen and supports reference audio. For a non-default model, call `inspect_replicate_model` when needed to determine whether it accepts audio.
8. Never imply an attachment influenced generation when the selected model does not accept audio. `generate_music` will also enforce this server-side.
9. Call `generate_music` directly with the two text fields and the native ChatGPT attachment when present.
10. `generate_music` creates a billable Replicate prediction using the connected user's Replicate account.
