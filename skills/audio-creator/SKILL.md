---
name: audio-creator
description: Generate, reference, cover, repaint or continue music through hosted Runware ACE-Step 1.5; reuse audioIds and recover jobs without duplicate paid submissions.
---

# Audio Creator

Stay in the current conversation. The Site manages the Runware credential; users do not enter personal provider tokens.

Check get_service_status when the deployed build or tool catalog is uncertain. Read model limits through inspect_music_model. Generation and source-audio editing are billable. Never trigger them merely to check configuration.

Compile the user's creative context into directorPrompt, preserving instrumentation, mood, scene, structure, vocal preference and loop requirements. Keep conversationSummary as explanatory context. The hosted prompt limit is 3000 characters; rewrite overlong prompts deliberately instead of silently dropping constraints. Do not truncate supplied lyrics.

Select generationMode from the user's intent:

- generate: new music with no source audio; duration must be 30–300 seconds.
- reference or cover: use the supplied audio as creative material.
- repaint: replace a bounded segment using repaintingStart and repaintingEnd.
- continue: extend the source using repaintingStart and repaintingEnd.

Source-audio requests do not accept duration. Use sourceAudioId for an existing service asset or referenceAudio for a native ChatGPT attachment. Never invent file_id, audioId or jobId.

XL Turbo is the default. Choose XL Base only when the user values higher quality over speed and cost. Set instrumental, lyrics, autoLyrics, seed and audioFormat according to the request and model support.

Use one stable requestKey per creative operation. Reuse it after a transport failure. A new creative version gets a new key. Poll get_music_job with the returned jobId. A queued or processing task is unfinished; storage_pending means retry importing the same output. submission_unknown requires task UUID reconciliation and must not cause another generation request.

On completion, keep audioId, audioIds, model, effective prompt and warnings. Temporary audio storage can expire; report the storage warning. Runware has no server-side cancellation for an in-flight inference, so do not claim that stopping a wait stops billing. Delete user-owned audio only on an explicit deletion request.
