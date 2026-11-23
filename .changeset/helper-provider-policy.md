---
"@bratsos/workflow-engine": minor
---

Set `AIHelperOptions.routing.provider` to configure an upstream allowlist, provider order, fallback behaviour and data collection for a helper and its children. OpenRouter realtime calls combine the policy with per-call restrictions. The helper intersects allowlists and preserves the stricter privacy and fallback settings. OpenRouter text batch submissions send supported allowlists and fallback settings at the top level, including submissions that fall back from a native transport. The helper refuses calls that cannot honour the policy. Custom model factories and resolvers receive the policy as their second argument.

Multi-step call rows store the distinct serving providers in `servedBy` and the ordered provider for each step in `metadata.servedBySteps`, including steps the SDK reported before a call failed.

Rolling-safe. The policy is opt-in and provider attribution uses the existing call-log fields.
