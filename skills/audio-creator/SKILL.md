---
name: audio-creator
description: Open GPT Audio Plugin with a concise current-chat summary and a music-director prompt so the user can create music from conversation context and optional reference audio through Replicate.
---

# Audio Creator

Use this workflow when the user wants to create, iterate on, or continue music with GPT Audio Plugin.

1. Reuse the current ChatGPT conversation as the text reasoning layer. Do not call or ask the plugin to call a separate text-model API.
2. Before opening the studio, produce two distinct values:
   - `conversationSummary`: concise factual/creative context already established in the chat.
   - `directorPrompt`: a production-ready music-generation prompt drafted by the current ChatGPT model.
3. Preserve concrete creative constraints when present:
   - scene or story
   - intended use (game BGM, song, ambience, etc.)
   - mood and energy
   - genre or stylistic references
   - tempo or pacing
   - instruments and sound-design ideas
   - structure, duration, looping, or other constraints
4. Call `open_audio_studio` with both values.
5. Let the user inspect/edit them, upload a clip, record a clip, and trigger generation from the UI.
6. The plugin uses the user's configured Replicate account. Do not request or expose a Replicate API token in chat.
7. `generate_music` creates a billable Replicate prediction; keep the user's edited values when calling it.
8. If the user explicitly asks to generate without opening the studio and all required generation fields are available, `generate_music` may be called directly.
