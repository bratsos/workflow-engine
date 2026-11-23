---
"@bratsos/workflow-engine": minor
---

Set `AIHelperOptions.routing.provider` to configure an upstream allowlist, provider order, fallback behaviour and data collection for a helper and its children. OpenRouter receives the policy on synchronous calls. The helper rejects direct providers outside the allowlist and refuses calls that cannot honour the policy, including OpenRouter batch submissions. Custom model factories and resolvers receive the policy as their second argument.

Multi-step call rows store the distinct serving providers in `servedBy` and the ordered provider for each step in `metadata.servedBySteps`.

Rolling-safe. The policy is opt-in and provider attribution uses the existing call-log fields.
