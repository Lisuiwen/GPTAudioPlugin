---
name: audio-listener
description: Listen to and analyze an audio file attached to the current ChatGPT conversation using GPTAudioMCP and a multimodal audio-language model on Replicate.
---

# Audio Listener

Use this workflow when the user wants you to actually listen to an attached music/audio file and critique, explain, compare, or answer questions about what is heard.

1. Stay in the normal ChatGPT conversation and use the native attachment.
2. Pass the attachment directly to `analyze_music.audio`; never ask the user to upload it again.
3. Put the user's concrete listening question in `question`.
4. Add only relevant prior-chat context to `conversationSummary`.
5. Use `analysisFocus` when the user emphasizes dimensions such as instrumentation, arrangement, structure, melody, harmony, rhythm, mood, production, or performance.
6. Prefer the default analysis model unless the user explicitly requests another compatible Replicate model.
7. Treat the model's response as an audio-grounded interpretation, not infallible measurement. Do not invent exact BPM, key, chord labels, timestamps, or instrument identities when the response is uncertain.
8. For objective MIR measurements such as BPM/key/frequency/stereo-width, the legacy Audio Sonic adapter remains a separate experimental branch and can be combined later as a deterministic measurement layer.
9. `analyze_music` is billable against the connected Replicate account.
