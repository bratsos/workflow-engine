---
"@bratsos/workflow-engine": patch
---

`run.reapStuck` now fails active child stages in the same transaction as a stuck run. It stamps their completion times and errors, clears their poll deadlines, preserves terminal children and retains the stale-version guard.
