---
name: audio-creator
description: Open GPT Audio Plugin with a concise summary of the current conversation so the user can create music from chat context and optional reference audio through Replicate.
---

# Audio Creator

Use this workflow when the user wants to create, iterate on, or continue music with GPT Audio Plugin.

1. Reuse the current ChatGPT conversation as the text reasoning layer. Do not ask the plugin to call a separate text-model API.
2. Before opening the studio, compress the relevant conversation into a concise `contextSummary`.
3. Preserve concrete creative constraints when present:
   - scene or story
   - intended use (game BGM, song, ambience, etc.)
   - mood and energy
   - genre or stylistic references
   - tempo or pacing
   - instruments and sound-design ideas
   - structure, duration, looping, or other constraints
4. Call `open_audio_studio` with that summary. Put any immediately relevant final instruction in `initialPrompt`.
5. Let the user edit the summary, upload a clip, record a clip, and trigger generation from the UI.
6. The plugin uses the user's configured Replicate account. Do not request or expose a Replicate API token in chat.
7. If the user explicitly asks to generate without opening the studio and all required generation fields are already available, `generate_music` may be called directly.
