---
"@bratsos/workflow-engine": patch
---

The published conformance suites no longer fail a correct adapter on a slow machine. `aiCallLoggerConformanceSuite` polls (every 20 ms, up to 4 s) for a fire-and-forget `logCall` write instead of sleeping a fixed 100 ms. `jobQueueConformanceSuite`'s heartbeat test (a touched job survives `releaseStaleJobs`, an untouched one is reclaimed) measures the gap between `touchJob` and `releaseStaleJobs` and, when a loaded machine stretched it, repeats on fresh jobs with a 300 ms and then a 900 ms threshold (2.6 s of sleeping at most) instead of failing. A quiet machine takes the same 200 ms as before, and the logger tests no longer sleep. A `touchJob` that does not refresh the lease still fails the test. Keep your runner's per-test timeout at its 5 s default or higher.
