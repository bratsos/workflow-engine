---
"@bratsos/workflow-engine-host-remote": patch
---

The blocking `createRemoteExecutor` no longer runs a remote activity twice for the same attempt, and actually reruns it on a retry.

- Before submitting, and whenever the broker no longer knows the task, it reads the worker's stored report (`remote-activity/<runId>/<stageId>/<taskId>/report.json` in the kernel's blob store). If the report is there, the executor answers from it instead of submitting the task again. Previously a broker that lost the task after the worker reported (a broker restart, or a redelivery after a lost acknowledgement or a lost process) made the executor submit it again, and the worker ran a second time.
- The task id is now scoped to the attempt (`<stageRecordId>-attempt-<n>` from attempt 2 on; attempt 1 keeps the bare record id). Previously a retry the kernel granted reused the failed attempt's task. A surviving broker then played back that attempt's failed report, and the retry never ran the worker.
