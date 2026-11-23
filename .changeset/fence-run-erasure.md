---
"@bratsos/workflow-engine": patch
---

Targeted run erasure now keeps runs discoverable while writes are in flight. It removes pending command keys without re-creating them when completion arrives late, respects reservations during age sweeps, and counts blob and step deletions atomically. Archived spill ownership is recorded on the run during redrive.

For targeted erasure, **stop old hosts first**. Earlier hosts can write without a reservation check. Apply the additive schema migration and establish ownership for archives from older redrives before erasing those runs.
