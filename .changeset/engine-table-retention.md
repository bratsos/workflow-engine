---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
"@bratsos/workflow-engine-host-serverless": minor
---

Use `engine.prune` to remove old AI calls, published events of terminal runs, and completed idempotency keys. Clear expired AI call text and metadata instructions independently. Each configured clause returns a count and applies its own batch limit. Both hosts accept an optional `prune` configuration so maintenance ticks can run these policies.

The additive indexes are **rolling-safe**. Apply them before enabling retention. Existing hosts can continue processing jobs while the indexes are added.
