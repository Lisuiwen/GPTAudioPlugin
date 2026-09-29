---
name: audio-creator
description: Open GPT Audio Plugin with a concise current-chat summary and a music-director prompt so the user can create music through their connected Replicate account.
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
5. Replicate account access is user-owned. Protected tools trigger the plugin's OAuth connection flow; never request a Replicate token in chat.
6. Before accepting reference audio for a selected model, use `inspect_replicate_model`. Replicate models have different input schemas and not all of them accept audio.
7. If the selected model does not expose an audio input, keep the workflow text-only and do not imply that uploaded audio affects generation.
8. Let the user inspect/edit the text fields, select/check a model, optionally upload or record audio when supported, and trigger generation from the UI.
9. `generate_music` creates a billable Replicate prediction using the connected user's Replicate account.
10. If the user explicitly asks to generate without opening the studio and all required fields are available, `generate_music` may be called directly.
