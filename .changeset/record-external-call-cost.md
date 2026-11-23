---
"@bratsos/workflow-engine": minor
---

Record calls made outside the helper with their supplied USD cost and accounting fields through `recordCall`, including sessions recorded as `realtime`. Providing the cost bypasses catalogue lookup.

**Rolling-safe** because the existing accounting columns support supplied costs and call types.
