---
"@bratsos/workflow-engine": minor
---

Set `AIHelperOptions.routing.provider` to configure an upstream allowlist, provider order, fallback behaviour and data collection for a helper and its children. OpenRouter realtime calls combine the policy with per-call restrictions. The helper intersects allowlists and preserves the stricter privacy and fallback settings. A no-fallback request restricted to one endpoint retains that limit when combined with an order. OpenRouter text batch submissions send supported allowlists and fallback settings at the top level, including submissions that fall back from a native transport. The helper refuses calls that cannot honour the policy. Custom model factories and resolvers receive the policy as their second argument.

Regional endpoints remain in the merged ranking when a matching variant is allowed. OpenRouter batches can pin a single eligible regional endpoint with fallbacks disabled.

New batch submissions enforce the policy on the transport that builds each request. A concurrent poll of a saved batch follows that batch's stored refs, and new handles identify the transport that submitted them.

Batch credentials and base URLs apply to the configured provider. Automatic fallback to OpenRouter requires provider defaults. Use an explicit OpenRouter client when supplying its URL or key. A saved batch on another provider uses that provider's default URL and environment credential.

Multi-step call rows store the distinct serving providers in `servedBy` and the ordered provider for each step in `metadata.servedBySteps`, including steps the SDK reported before a call failed. Calls keep their billable usage and cost if reading structured output fails or a stream callback throws.

Rolling-safe. The policy is opt-in and provider attribution uses the existing call-log fields.
