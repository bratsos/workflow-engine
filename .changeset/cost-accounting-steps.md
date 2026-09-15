---
"@bratsos/workflow-engine": patch
---

Provider-reported cost is now summed across the steps of a tool-calling call. `generateText`, `generateObject` and the stream's `getUsage()` previously read the reported cost from the final step's provider metadata while the token usage was the total across steps, so every multi-step call under-reported. The per-step figures are now summed (each with the BYOK upstream rule) when every step that consumed tokens reported one; otherwise the whole call falls back to the registry estimate and is marked `costSource: "estimated"`.

OpenRouter batch rows now carry the provider's per-request cost. The transport asks for usage accounting on every request body and, when a result's `usage.cost` is present, records it as the row's `reportedCost` with `costSource: "reported"` instead of pricing the row from the catalogue's batch rates; rows without it keep the batch estimate. The vendor batch transports (google/anthropic/openai) return tokens only, so their rows remain estimated.
