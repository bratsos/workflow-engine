---
"@bratsos/workflow-engine": minor
---

Speech to text: `ai.transcribe` and `ctx.step.ai.transcribe`.

- **`ai.transcribe(modelKey, audio, options?)`** transcribes audio through the AI SDK's `transcribe`: a `Uint8Array`, `ArrayBuffer`, base64 string, or a `URL` the AI SDK downloads first. It returns `text`, timed `segments`, and the `language` and `durationInSeconds` when the provider reports them. Built-in providers are `"openai"` (`openai.transcription`, from the optional `@ai-sdk/openai` peer, loaded only when asked for) and `"google"` (`google.transcription`); `registerTranscriptionProvider(provider, factory)` plugs in any other AI SDK transcription model, as `registerEmbeddingProvider` does for embeddings.
- **`ctx.step.ai.transcribe(id, modelKey, audio, options?, stepOptions?)`** is the durable form: the transcript is memoised in the step ledger, so a replay after a suspension neither re-sends the audio nor pays for it again. Only the result is stored, never the audio.
- **Registry:** `isTranscriptionModel` on `ModelConfig` marks a speech-to-text model; only such a model can answer `transcribe`, and any other throws before a request is made. `transcriptionCostPerMinute` prices providers that bill per minute of audio. Transcription models are not in OpenRouter's catalogue, so they are registered by hand; `listModels({ isTranscriptionModel })` filters on the flag.
- **Cost** follows how the provider bills: per minute of audio where it reports a duration and the registry has a rate (OpenAI), and per token where it reports usage in its metadata, priced at the model's `inputCostPerMillion` / `outputCostPerMillion` (Google reports `total_input_tokens` / `total_output_tokens`). The call is logged with `callType: "transcribe"`, the reported tokens, and a description of the audio (its URL or byte size) in place of the audio itself.
- **Testing:** `MockAIHelper.transcribe` returns "mock transcript" by default, and `setTranscribeResponse(response)` (also on `harness.mockAi`) scripts what it returns.
- **Breaking for custom `AIHelper` implementations:** the interface gained `transcribe`, and `AICallType` gained `"transcribe"`. Code that consumes a helper is unaffected.
