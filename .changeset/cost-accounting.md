---
"@bratsos/workflow-engine": minor
---

Cost accounting: every `ai_calls` row keeps the registry estimate beside the provider's figure, names which one `cost` is and which endpoint served the call, and records cached-input and reasoning tokens; the estimate prices cached input at the catalogue's cache-read rate.

**What changed and why:**

- **Both figures on the row.** Before this, `resolveCost` chose between the provider's reported cost and the registry estimate and the Prisma logger persisted only the winner as `cost`, so a consumer could not tell a reported figure from an estimate after the fact, nor compare the two. `CreateAICallInput` / `AICallRecord` now carry `estimatedCost` (the registry figure, always computed), `reportedCost` (the provider's figure, when any), `costSource` (`"reported"` | `"estimated"`) and `servedBy` (OpenRouter's `provider` metadata — the endpoint that served the request). `cost` is unchanged: reported when available, else estimated, and still what `getStats` sums and `WorkflowRun.totalCost` rolls up. `resolveCost` returns `estimatedCostUsd` and `servedBy` alongside its existing fields; `AIHelper.recordCall` writes `estimatedCost === cost` with `costSource: "estimated"`.
- **Cached and reasoning tokens.** `cachedInputTokens` (AI SDK 7 `usage.inputTokenDetails.cacheReadTokens`, falling back to OpenRouter's `promptTokensDetails.cachedTokens` and the raw `prompt_tokens_details.cached_tokens`) and `reasoningTokens` (`usage.outputTokenDetails.reasoningTokens`, then `completionTokensDetails.reasoningTokens`) are extracted, carried on the record and persisted. Both are breakdowns of `inputTokens` / `outputTokens`, not additions — every source counts them inside the totals — so neither total changes and reasoning is billed as output without a separate charge.
- **Cached input priced at the cache-read rate.** `ModelConfig.cachedInputCostPerMillion` (and the same field on `longContextTier`) is new; `calculateCost(modelKey, inputTokens, outputTokens, cachedInputTokens?)` bills the cached part of the prompt at that rate and the rest at the full rate, and bills everything at the full rate when the registry has no cached rate. `workflow-engine-sync` emits it from OpenRouter's `pricing.input_cache_read` (and an override's `input_cache_read` into the tier) when the catalogue publishes one, and omits it otherwise — absence means "full rate", never zero. The batch estimate is unchanged: batch prices are absolute per-row figures with no published cache tier.
- **Reading the rows back.** `AICallLogger.listCalls?(topicPrefix)` returns the rows under a prefix, oldest first, with every figure as recorded. Optional on the port so an adapter written before 1.0 keeps compiling; `PrismaAICallLogger` and `InMemoryAICallLogger` implement it, and the AI-logger conformance suite gains two cases (a reported call and an estimated call written through the batch path) that read back both figures, the source, the endpoint and the token breakdowns through it.
- **Migration:** six nullable columns on `ai_calls`, all idempotent to add. Rows written before this read back with the new fields absent and `cost` unchanged.

  ```sql
  ALTER TABLE "ai_calls"
    ADD COLUMN IF NOT EXISTS "estimatedCost"     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "reportedCost"      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "costSource"        TEXT,
    ADD COLUMN IF NOT EXISTS "servedBy"          TEXT,
    ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER,
    ADD COLUMN IF NOT EXISTS "reasoningTokens"   INTEGER;
  ```

- The 0.13 → 1.0 migration guide gains the block above; `04-ai-integration.md` documents what each row field means and that OpenRouter's `max_price` guard is the same registry price times `routing.priceHeadroom`, so a `reportedCost` above `estimatedCost × priceHeadroom` points at a charge the per-token ceiling does not cover; `05-persistence-setup.md` and the docs-site custom-adapter page list `listCalls`.
