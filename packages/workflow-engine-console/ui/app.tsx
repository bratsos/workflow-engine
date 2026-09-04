import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

interface ConsoleCapabilities {
  runs: boolean;
  steps: boolean;
  annotations: boolean;
  queue: boolean;
  suspended: boolean;
  deadLetters: boolean;
  workers: boolean;
  costs: boolean;
}

interface ConsoleConfig {
  basePath: string;
  readOnly: boolean;
  pollIntervalMs: number;
  forcePollInterval: boolean;
  capabilities: ConsoleCapabilities;
}

interface RunSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  totalCost: number;
  totalTokens: number;
  priority: number;
  definitionVersion: string | null;
  redriveCount: number;
}

interface RunListPage {
  runs: RunSummary[];
  nextCursor: string | null;
}

interface StageSummary {
  id: string;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  attempt: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  nextPollAt: string | null;
  pollInterval: number | null;
  maxWaitUntil: string | null;
  errorMessage: string | null;
}

interface StepSummary {
  id: string;
  stageRecordId: string;
  stepId: string;
  seq: number;
  kind: string;
  status: string;
  attempt: number;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AnnotationSummary {
  id: string;
  createdAt: string;
  workflowRunId: string;
  workflowStageRecordId: string | null;
  attempt: number;
  scope: string;
  scopeId: string | null;
  actorKind: string | null;
  actorId: string | null;
  key: string;
  value: unknown;
}

interface LogEntry {
  id: string;
  createdAt: string;
  workflowRunId: string | null;
  workflowStageId: string | null;
  level: string;
  message: string;
}

interface RunEvent {
  id: string;
  workflowRunId: string;
  sequence: number;
  eventType: string;
  occurredAt: string;
  publishedAt: string | null;
  retryCount: number;
  dlqAt: string | null;
}

interface RunDetail {
  run: RunSummary & {
    input: unknown;
    output: unknown;
    config: unknown;
    metadata: unknown;
  };
  stages: StageSummary[];
  steps: StepSummary[];
  annotations: AnnotationSummary[];
  logs: LogEntry[];
  events: RunEvent[];
  truncated: {
    steps: boolean;
    annotations: boolean;
    logs: boolean;
    events: boolean;
  };
}

interface QueueHealth {
  countsByStatus: Record<string, number>;
  oldestPendingAt: string | null;
  oldestLeaseAt: string | null;
  overduePolls: number;
}

interface SuspendedStage {
  id: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  stageName: string;
  attempt: number;
  nextPollAt: string | null;
  pollInterval: number | null;
  maxWaitUntil: string | null;
}

interface WorkerInstance {
  workerId: string;
  runningJobs: number;
  oldestLockedAt: string | null;
  lastSeenAt: string | null;
}

interface DeadLetter {
  id: string;
  workflowRunId: string;
  sequence: number;
  eventType: string;
  retryCount: number;
  occurredAt: string;
  dlqAt: string | null;
}

interface CostBucket {
  key: string;
  runs: number;
  cost: number;
  tokens: number;
}

class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const diff = Date.now() - time;
  if (diff >= 0) {
    const sec = Math.floor(diff / 1000);
    if (sec < 10) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  } else {
    const sec = Math.floor(-diff / 1000);
    if (sec < 10) return "just now";
    if (sec < 60) return `in ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `in ${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `in ${hr}h`;
    const days = Math.floor(hr / 24);
    return `in ${days}d`;
  }
}

function formatNextPoll(iso: string | null): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const diff = Date.now() - time;
  if (diff > 0) {
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `overdue by ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `overdue by ${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `overdue by ${hr}h`;
    const days = Math.floor(hr / 24);
    return `overdue by ${days}d`;
  }
  return formatRelative(iso);
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) {
    const s = ms / 1000;
    return `${s.toFixed(1)}s`;
  }
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function formatCost(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "0";
  return n.toLocaleString();
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatVersion(version: string | null): string {
  if (!version) return "—";
  return version.length > 8 ? `…${version.slice(-8)}` : version;
}

async function api<T>(config: ConsoleConfig, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.basePath}/api${path}`;
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers,
  });

  if (!response.ok) {
    let code = "unknown";
    let message = `Request failed with status ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      if (payload?.error?.message) {
        message = payload.error.message;
        code = payload.error.code ?? "unknown";
      }
    } catch {
      // Non-JSON response
    }
    throw new ApiError(code, message);
  }

  return (await response.json()) as T;
}

function usePolled<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  intervalMs: number,
  paused: boolean,
): {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [tick, setTick] = useState<number>(0);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    const execute = async () => {
      try {
        const result = await fnRef.current();
        if (!mounted) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (!mounted) return;
        // Retain stale data across failures so operators can inspect the table
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void execute();

    let timer: ReturnType<typeof setInterval> | null = null;

    const startTimer = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (!paused && intervalMs > 0 && typeof document !== "undefined" && !document.hidden) {
        timer = setInterval(() => {
          if (!paused && !document.hidden) {
            void execute();
          }
        }, intervalMs);
      }
    };

    const handleVisibility = () => {
      // Polling background tabs wastes server and network resources
      if (typeof document !== "undefined" && !document.hidden && !paused && intervalMs > 0) {
        void execute();
        startTimer();
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    startTimer();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [...deps, tick, intervalMs, paused]);

  return { data, error, loading, refresh };
}

type Route =
  | { view: "runs" }
  | { view: "run-detail"; runId: string }
  | { view: "queue" }
  | { view: "dead-letters" }
  | { view: "costs" };

function parseHash(hash: string): Route {
  // Fragment routing allows embedding at arbitrary subpaths without host rewrite rules
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = raw.startsWith("/") ? raw.slice(1) : raw;
  const parts = path.split("/").filter(Boolean);
  const first = parts[0];

  if (first === "runs") {
    const second = parts[1];
    if (parts.length >= 2 && second) {
      return { view: "run-detail", runId: decodeURIComponent(parts.slice(1).join("/")) };
    }
    return { view: "runs" };
  }
  if (first === "queue") {
    return { view: "queue" };
  }
  if (first === "dead-letters") {
    return { view: "dead-letters" };
  }
  if (first === "costs") {
    return { view: "costs" };
  }
  return { view: "runs" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return route;
}

const POLL_STORAGE_KEY = "workflow-console:poll";

function getStoredPollInterval(fallback: number): number {
  try {
    // localStorage may throw SecurityError in restricted iframes or sandboxes
    const raw = localStorage.getItem(POLL_STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && [0, 2000, 5000, 10000, 30000, 60000].includes(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Gracefully degrade to configured default
  }
  return fallback;
}

function setStoredPollInterval(val: number): void {
  try {
    localStorage.setItem(POLL_STORAGE_KEY, String(val));
  } catch {
    // Ignore storage write rejections in restricted contexts
  }
}

function StatusPill({ status }: { status: string }) {
  const lower = status.toLowerCase();
  const cls = ["pending", "running", "suspended", "completed", "failed", "cancelled", "skipped"].includes(lower)
    ? `pill-${lower}`
    : "pill-pending";
  return <span class={`pill ${cls}`}>{status}</span>;
}

function ErrorBanner({
  error,
  onDismiss,
}: {
  error: ApiError | Error | null;
  onDismiss: () => void;
}) {
  if (!error) return null;
  const isTimeout = "code" in error && error.code === "query_timeout";
  const isForbidden = "code" in error && error.code === "forbidden";

  let message = error.message;
  if (isForbidden) {
    message = "You are not permitted to view this.";
  } else if (isTimeout) {
    message = `${error.message} Narrow the filter and try again.`;
  }

  return (
    <div class="banner" role="status">
      <span class="banner-message">{message}</span>
      <button
        type="button"
        class="banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
}

const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUSPENDED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
] as const;

/** A text filter, settled, so typing does not fire a request per keystroke. */
function useDebounced(value: string, delayMs = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

function RunsView({
  config,
  pollInterval,
  paused,
  refreshSignal,
}: {
  config: ConsoleConfig;
  pollInterval: number;
  paused: boolean;
  refreshSignal: number;
}) {
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [workflowIdInput, setWorkflowIdInput] = useState<string>("");
  const [definitionVersionInput, setDefinitionVersionInput] = useState<string>("");
  const [fromInput, setFromInput] = useState<string>("");
  const [toInput, setToInput] = useState<string>("");
  const debouncedWorkflowId = useDebounced(workflowIdInput);
  const debouncedDefinitionVersion = useDebounced(definitionVersionInput);

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [dismissedError, setDismissedError] = useState<Error | null>(null);

  useEffect(() => {
    setCursor(undefined);
    setCursorStack([]);
  }, [
    selectedStatuses,
    debouncedWorkflowId,
    debouncedDefinitionVersion,
    fromInput,
    toInput,
  ]);

  const toggleStatus = (st: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(st) ? prev.filter((item) => item !== st) : [...prev, st],
    );
  };

  const fetchRuns = useCallback(async () => {
    const params = new URLSearchParams();
    for (const st of selectedStatuses) {
      params.append("status", st);
    }
    if (debouncedWorkflowId.trim()) {
      params.set("workflowId", debouncedWorkflowId.trim());
    }
    if (debouncedDefinitionVersion.trim()) {
      params.set("definitionVersion", debouncedDefinitionVersion.trim());
    }
    if (fromInput) {
      const d = new Date(fromInput);
      if (!Number.isNaN(d.getTime())) params.set("from", d.toISOString());
    }
    if (toInput) {
      const d = new Date(toInput);
      if (!Number.isNaN(d.getTime())) params.set("to", d.toISOString());
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    const qs = params.toString();
    return await api<RunListPage>(config, `/runs${qs ? `?${qs}` : ""}`);
  }, [
    config,
    selectedStatuses,
    debouncedWorkflowId,
    debouncedDefinitionVersion,
    fromInput,
    toInput,
    cursor,
  ]);

  const { data, error, loading } = usePolled(
    fetchRuns,
    [fetchRuns, refreshSignal],
    pollInterval,
    paused,
  );

  const activeError = error === dismissedError ? null : error;
  const isForbidden = activeError && "code" in activeError && activeError.code === "forbidden";

  const handleNext = () => {
    if (data?.nextCursor) {
      // Keyset pagination: stack previous cursors for backwards traversal without offset scan
      setCursorStack((prev) => [...prev, cursor ?? ""]);
      setCursor(data.nextCursor);
    }
  };

  const handlePrevious = () => {
    if (cursorStack.length > 0) {
      const nextStack = [...cursorStack];
      const prevCursor = nextStack.pop();
      setCursorStack(nextStack);
      setCursor(prevCursor === "" ? undefined : prevCursor);
    }
  };

  return (
    <div>
      <div class="filter-bar">
        <div class="filter-row">
          <div class="status-toggle-group">
            {RUN_STATUSES.map((st) => (
              <button
                type="button"
                key={st}
                class={`status-toggle ${selectedStatuses.includes(st) ? "active" : ""}`}
                onClick={() => toggleStatus(st)}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
        <div class="filter-row">
          <label class="sr-only" for="wc-filter-workflow">Workflow ID</label>
          <input
            id="wc-filter-workflow"
            type="text"
            placeholder="Filter workflow ID..."
            value={workflowIdInput}
            onInput={(e) => setWorkflowIdInput((e.target as HTMLInputElement).value)}
          />
          <label class="sr-only" for="wc-filter-version">Definition version</label>
          <input
            id="wc-filter-version"
            type="text"
            placeholder="Filter definition version..."
            value={definitionVersionInput}
            onInput={(e) => setDefinitionVersionInput((e.target as HTMLInputElement).value)}
          />
          <label class="sr-only" for="wc-filter-from">From</label>
          <input
            id="wc-filter-from"
            type="datetime-local"
            value={fromInput}
            onChange={(e) => setFromInput((e.target as HTMLInputElement).value)}
          />
          <label class="sr-only" for="wc-filter-to">To</label>
          <input
            id="wc-filter-to"
            type="datetime-local"
            value={toInput}
            onChange={(e) => setToInput((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <ErrorBanner
        error={activeError}
        onDismiss={() => setDismissedError(error)}
      />

      {!isForbidden && (
        <>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Run ID</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Version</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {(data?.runs ?? []).map((run) => (
                  <tr key={run.id}>
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td>
                      <a href={`#/runs/${encodeURIComponent(run.id)}`} title={run.id}>
                        {run.id.length > 12 ? `…${run.id.slice(-12)}` : run.id}
                      </a>
                    </td>
                    <td>{run.workflowName || run.workflowId}</td>
                    <td title={run.definitionVersion ?? undefined}>
                      {formatVersion(run.definitionVersion)}
                      {run.redriveCount > 0 && (
                        <span title={`${run.redriveCount} redrives`}>
                          {` +${run.redriveCount}`}
                        </span>
                      )}
                    </td>
                    <td>{formatRelative(run.startedAt)}</td>
                    <td>{formatDuration(run.duration)}</td>
                    <td>{formatCost(run.totalCost)}</td>
                    <td>{formatTokens(run.totalTokens)}</td>
                  </tr>
                ))}
                {data && data.runs.length === 0 && (
                  <tr>
                    <td colspan={8} class="empty-state">No workflow runs found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div class="pagination">
            <button
              type="button"
              disabled={cursorStack.length === 0 || loading}
              onClick={handlePrevious}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!data?.nextCursor || loading}
              onClick={handleNext}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RunDetailView({
  config,
  runId,
  pollInterval,
  paused,
  refreshSignal,
}: {
  config: ConsoleConfig;
  runId: string;
  pollInterval: number;
  paused: boolean;
  refreshSignal: number;
}) {
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<ApiError | Error | null>(null);
  const [dismissedError, setDismissedError] = useState<Error | null>(null);

  const fetchDetail = useCallback(async () => {
    return await api<RunDetail>(config, `/runs/${encodeURIComponent(runId)}`);
  }, [config, runId]);

  const { data, error, refresh } = usePolled(
    fetchDetail,
    [fetchDetail, refreshSignal],
    pollInterval,
    paused,
  );

  const effectiveError = actionError ?? error;
  const activeError = effectiveError === dismissedError ? null : effectiveError;
  const isForbidden = activeError && "code" in activeError && activeError.code === "forbidden";

  const handleCancelRun = async () => {
    if (!window.confirm("Cancel this workflow run?")) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await api(config, `/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: "{}",
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRerunStage = async (stageId: string, stageName: string) => {
    if (!window.confirm(`Rerun workflow from stage "${stageName}"?`)) return;
    await redrive({ from: { kind: "stage", stageId } });
  };

  // The rescue for a run pinned to a definition version no host serves any
  // more: it cannot make progress on its own version, so redriving it is
  // only useful together with a re-pin.
  const handleRedriveOnLatest = async () => {
    if (
      !window.confirm(
        "Redrive this run from its last failure on the version this deployment serves?",
      )
    )
      return;
    await redrive({
      from: { kind: "lastFailure" },
      definitionVersion: "latest",
    });
  };

  const redrive = async (body: Record<string, unknown>) => {
    setActionLoading(true);
    setActionError(null);
    try {
      await api(config, `/runs/${encodeURIComponent(runId)}/rerun`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setActionLoading(false);
    }
  };

  const sortedStages = useMemo(() => {
    return [...(data?.stages ?? [])].sort((a, b) => a.stageNumber - b.stageNumber);
  }, [data?.stages]);

  const { runStartMs, totalDurationMs } = useMemo(() => {
    if (!data?.run) return { runStartMs: 0, totalDurationMs: 1 };
    const firstStage = sortedStages[0];
    const runStart = data.run.startedAt
      ? Date.parse(data.run.startedAt)
      : firstStage?.startedAt
        ? Date.parse(firstStage.startedAt)
        : Date.parse(data.run.createdAt);
    const runEnd = data.run.completedAt ? Date.parse(data.run.completedAt) : Date.now();
    return {
      runStartMs: Number.isNaN(runStart) ? 0 : runStart,
      totalDurationMs: Math.max(1, (Number.isNaN(runEnd) ? Date.now() : runEnd) - runStart),
    };
  }, [data?.run, sortedStages]);

  const { stepsByStage, unassignedSteps } = useMemo(() => {
    const map = new Map<string, StepSummary[]>();
    const unassigned: StepSummary[] = [];
    for (const step of data?.steps ?? []) {
      if (step.stageRecordId) {
        const list = map.get(step.stageRecordId);
        if (list) {
          list.push(step);
        } else {
          map.set(step.stageRecordId, [step]);
        }
      } else {
        unassigned.push(step);
      }
    }
    return { stepsByStage: map, unassignedSteps: unassigned };
  }, [data?.steps]);

  return (
    <div>
      <ErrorBanner
        error={activeError}
        onDismiss={() => {
          setDismissedError(effectiveError);
          setActionError(null);
        }}
      />

      {data && !isForbidden && (
        <>
          <div class="run-detail-header">
            <div class="run-detail-title-row">
              <div class="run-detail-title-left">
                <a href="#/runs">← Back to runs</a>
                <h2 class="header-title" style={{ wordBreak: "break-all" }}>
                  {data.run.id}
                </h2>
                <StatusPill status={data.run.status} />
              </div>
              {!config.readOnly && (
                <div class="run-detail-actions">
                  {data.run.definitionVersion && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={handleRedriveOnLatest}
                      title="Move this run onto the definition version this deployment serves, then redrive it from its last failure"
                    >
                      Redrive on latest version
                    </button>
                  )}
                  <button
                    type="button"
                    class="btn-danger"
                    disabled={actionLoading}
                    onClick={handleCancelRun}
                  >
                    Cancel run
                  </button>
                </div>
              )}
            </div>

            <div class="run-detail-meta">
              <div class="meta-item">
                <span class="meta-label">Workflow</span>
                <span class="meta-value">{data.run.workflowName || data.run.workflowId}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Version</span>
                <span class="meta-value" title={data.run.definitionVersion ?? undefined}>
                  {formatVersion(data.run.definitionVersion)}
                </span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Redrives</span>
                <span class="meta-value">{data.run.redriveCount}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Started</span>
                <span class="meta-value">{formatAbsolute(data.run.startedAt)}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Completed</span>
                <span class="meta-value">{formatAbsolute(data.run.completedAt)}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Duration</span>
                <span class="meta-value">{formatDuration(data.run.duration)}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Cost</span>
                <span class="meta-value">{formatCost(data.run.totalCost)}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Tokens</span>
                <span class="meta-value">{formatTokens(data.run.totalTokens)}</span>
              </div>
            </div>
          </div>

          <div class="section-header">
            <h3 class="section-title">Stage timeline</h3>
          </div>
          <div class="stage-timeline">
            {sortedStages.map((stage) => {
              let leftPercent = 0;
              let widthPercent = 0;
              if (stage.startedAt && runStartMs > 0) {
                const sStart = Date.parse(stage.startedAt);
                const sEnd = stage.completedAt ? Date.parse(stage.completedAt) : Date.now();
                leftPercent = Math.max(0, Math.min(100, ((sStart - runStartMs) / totalDurationMs) * 100));
                widthPercent = Math.max(0.5, Math.min(100 - leftPercent, ((sEnd - sStart) / totalDurationMs) * 100));
              }
              return (
                <div key={stage.id} class="stage-timeline-row">
                  <div class="stage-timeline-meta">
                    <div class="stage-timeline-meta-left">
                      <span class="stage-num">#{stage.stageNumber}</span>
                      <span class="stage-name">{stage.stageName}</span>
                      <StatusPill status={stage.status} />
                      <span class="stage-timings">
                        <span>{formatAbsolute(stage.startedAt)}</span>
                        <span>→</span>
                        <span>{formatAbsolute(stage.completedAt)}</span>
                        <span>({formatDuration(stage.duration)})</span>
                      </span>
                    </div>
                    {!config.readOnly && (
                      <button
                        type="button"
                        class="btn-sm"
                        disabled={actionLoading}
                        onClick={() => handleRerunStage(stage.stageId, stage.stageName)}
                      >
                        Rerun from here
                      </button>
                    )}
                  </div>
                  <div class="timeline-track">
                    <div
                      class="timeline-bar"
                      style={{
                        left: `${leftPercent}%`,
                        width: `${widthPercent}%`,
                      }}
                    />
                  </div>
                  {stage.errorMessage && (
                    <div class="stage-error">{stage.errorMessage}</div>
                  )}
                </div>
              );
            })}
            {sortedStages.length === 0 && (
              <div class="empty-state">No stages recorded.</div>
            )}
          </div>

          <div class="section-header">
            <h3 class="section-title">Step ledger</h3>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Step ID</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">Lease expires</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {sortedStages.map((stage) => {
                  const steps = (stepsByStage.get(stage.id) ?? []).sort((a, b) => a.seq - b.seq);
                  if (steps.length === 0) return null;
                  return (
                    <tr key={`group-${stage.id}`}>
                      <td colspan={8} style={{ padding: 0 }}>
                        <table style={{ width: "100%", margin: 0 }}>
                          <thead>
                            <tr class="table-group-header">
                              <th scope="colgroup" colspan={8}>
                                Stage #{stage.stageNumber}: {stage.stageName}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {steps.map((step) => (
                              <tr key={step.id}>
                                <td style={{ width: "50px" }}>{step.seq}</td>
                                <td>{step.stepId}</td>
                                <td>{step.kind}</td>
                                <td><StatusPill status={step.status} /></td>
                                <td>{step.attempt}</td>
                                <td>{formatAbsolute(step.leaseExpiresAt)}</td>
                                <td>{formatAbsolute(step.deadlineAt)}</td>
                                <td>{step.error || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  );
                })}
                {unassignedSteps.length > 0 && (
                  <tr>
                    <td colspan={8} style={{ padding: 0 }}>
                      <table style={{ width: "100%", margin: 0 }}>
                        <thead>
                          <tr class="table-group-header">
                            <th scope="colgroup" colspan={8}>
                              Other steps
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {unassignedSteps.map((step) => (
                            <tr key={step.id}>
                              <td style={{ width: "50px" }}>{step.seq}</td>
                              <td>{step.stepId}</td>
                              <td>{step.kind}</td>
                              <td><StatusPill status={step.status} /></td>
                              <td>{step.attempt}</td>
                              <td>{formatAbsolute(step.leaseExpiresAt)}</td>
                              <td>{formatAbsolute(step.deadlineAt)}</td>
                              <td>{step.error || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                {data.steps.length === 0 && (
                  <tr>
                    <td colspan={8} class="empty-state">No steps recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data.truncated.steps && (
            <p class="truncated-note">
              Showing the first {data.steps.length} — there are more.
            </p>
          )}

          <div class="section-header">
            <h3 class="section-title">Events</h3>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th scope="col">Sequence</th>
                  <th scope="col">Event type</th>
                  <th scope="col">Occurred</th>
                  <th scope="col">Published</th>
                  <th scope="col">Retries</th>
                  <th scope="col">Dead-lettered</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((evt) => (
                  <tr key={evt.id}>
                    <td>{evt.sequence}</td>
                    <td>{evt.eventType}</td>
                    <td>{formatAbsolute(evt.occurredAt)}</td>
                    <td>{evt.publishedAt ? formatAbsolute(evt.publishedAt) : "pending"}</td>
                    <td>{evt.retryCount}</td>
                    <td>
                      {evt.dlqAt ? (
                        <span class="badge badge-dlq" title={`DLQ at ${evt.dlqAt}`}>
                          Dead-lettered
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
                {data.events.length === 0 && (
                  <tr>
                    <td colspan={6} class="empty-state">No events recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data.truncated.events && (
            <p class="truncated-note">
              Showing the first {data.events.length} — there are more.
            </p>
          )}

          <div class="section-header">
            <h3 class="section-title">Annotations</h3>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Value</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.annotations.map((ann) => (
                  <tr key={ann.id}>
                    <td>{ann.key}</td>
                    <td>
                      <code>{typeof ann.value === "string" ? ann.value : JSON.stringify(ann.value)}</code>
                    </td>
                    <td>{ann.scope}{ann.scopeId ? ` (${ann.scopeId})` : ""}</td>
                    <td>{ann.actorKind || ann.actorId ? `${ann.actorKind ?? ""}:${ann.actorId ?? ""}` : "—"}</td>
                    <td>{ann.attempt}</td>
                    <td>{formatAbsolute(ann.createdAt)}</td>
                  </tr>
                ))}
                {data.annotations.length === 0 && (
                  <tr>
                    <td colspan={6} class="empty-state">No annotations recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data.truncated.annotations && (
            <p class="truncated-note">
              Showing the first {data.annotations.length} — there are more.
            </p>
          )}

          <div class="section-header">
            <h3 class="section-title">Logs</h3>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Level</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => (
                  <tr key={log.id}>
                    <td>{formatAbsolute(log.createdAt)}</td>
                    <td>
                      <span class={`pill pill-log-${log.level.toLowerCase()}`}>
                        {log.level}
                      </span>
                    </td>
                    <td>{log.workflowStageId || "—"}</td>
                    <td>{log.message}</td>
                  </tr>
                ))}
                {data.logs.length === 0 && (
                  <tr>
                    <td colspan={4} class="empty-state">No logs recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data.truncated.logs && (
            <p class="truncated-note">
              Showing the first {data.logs.length} — there are more.
            </p>
          )}

          <div class="payload-sections">
            <details class="payload-block">
              <summary>Input</summary>
              <pre>{JSON.stringify(data.run.input, null, 2)}</pre>
            </details>
            <details class="payload-block">
              <summary>Output</summary>
              <pre>{JSON.stringify(data.run.output, null, 2)}</pre>
            </details>
            <details class="payload-block">
              <summary>Config</summary>
              <pre>{JSON.stringify(data.run.config, null, 2)}</pre>
            </details>
            <details class="payload-block">
              <summary>Metadata</summary>
              <pre>{JSON.stringify(data.run.metadata, null, 2)}</pre>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

interface QueueData {
  queue: QueueHealth | null;
  suspended: SuspendedStage[] | null;
  workers: WorkerInstance[] | null;
}

function QueueView({
  config,
  pollInterval,
  paused,
  refreshSignal,
}: {
  config: ConsoleConfig;
  pollInterval: number;
  paused: boolean;
  refreshSignal: number;
}) {
  const [dismissedError, setDismissedError] = useState<Error | null>(null);

  const fetchQueueData = useCallback(async (): Promise<QueueData> => {
    const [queue, suspended, workers] = await Promise.all([
      config.capabilities.queue ? api<QueueHealth>(config, "/queue") : Promise.resolve(null),
      config.capabilities.suspended ? api<SuspendedStage[]>(config, "/suspended") : Promise.resolve(null),
      config.capabilities.workers ? api<WorkerInstance[]>(config, "/workers") : Promise.resolve(null),
    ]);
    return { queue, suspended, workers };
  }, [config]);

  const { data, error } = usePolled(
    fetchQueueData,
    [fetchQueueData, refreshSignal],
    pollInterval,
    paused,
  );

  const activeError = error === dismissedError ? null : error;
  const isForbidden = activeError && "code" in activeError && activeError.code === "forbidden";

  return (
    <div>
      <ErrorBanner
        error={activeError}
        onDismiss={() => setDismissedError(error)}
      />

      {data && !isForbidden && (
        <>
          {config.capabilities.queue && data.queue && (
            <>
              <div class="section-header">
                <h3 class="section-title">Queue health</h3>
              </div>
              <div class="stat-tiles">
                {RUN_STATUSES.map((st) => (
                  <div key={st} class="stat-tile">
                    <span class="stat-tile-value">{data.queue?.countsByStatus[st] ?? 0}</span>
                    <span class="stat-tile-label"><StatusPill status={st} /></span>
                  </div>
                ))}
                <div class="stat-tile">
                  <span class="stat-tile-value">{formatRelative(data.queue.oldestPendingAt)}</span>
                  <span class="stat-tile-label">Oldest pending</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-tile-value">{formatRelative(data.queue.oldestLeaseAt)}</span>
                  <span class="stat-tile-label">Oldest lease</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-tile-value">{data.queue.overduePolls}</span>
                  <span class="stat-tile-label">Overdue polls</span>
                </div>
              </div>
            </>
          )}

          {config.capabilities.suspended && data.suspended && (
            <>
              <div class="section-header">
                <h3 class="section-title">Suspended stages</h3>
              </div>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">Workflow run</th>
                      <th scope="col">Attempt</th>
                      <th scope="col">Next poll</th>
                      <th scope="col">Poll interval</th>
                      <th scope="col">Max wait until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.suspended.map((st) => (
                      <tr key={st.id}>
                        <td>{st.stageName}</td>
                        <td>
                          <a href={`#/runs/${encodeURIComponent(st.workflowRunId)}`} title={st.workflowRunId}>
                            {st.workflowRunId.length > 12 ? `…${st.workflowRunId.slice(-12)}` : st.workflowRunId}
                          </a>
                        </td>
                        <td>{st.attempt}</td>
                        <td>{formatNextPoll(st.nextPollAt)}</td>
                        <td>{st.pollInterval ? formatDuration(st.pollInterval) : "—"}</td>
                        <td>{formatAbsolute(st.maxWaitUntil)}</td>
                      </tr>
                    ))}
                    {data.suspended.length === 0 && (
                      <tr>
                        <td colspan={6} class="empty-state">No suspended stages.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {config.capabilities.workers && data.workers && (
            <>
              <div class="section-header">
                <h3 class="section-title">Workers</h3>
              </div>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Worker ID</th>
                      <th scope="col">Running jobs</th>
                      <th scope="col">Oldest lease</th>
                      <th scope="col">Heartbeat age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workers.map((w) => {
                      const isStale = w.lastSeenAt
                        ? Date.now() - Date.parse(w.lastSeenAt) > 60000
                        : true;
                      return (
                        <tr key={w.workerId} class={isStale ? "row-warning" : ""}>
                          <td>{w.workerId}</td>
                          <td>{w.runningJobs}</td>
                          <td>{formatRelative(w.oldestLockedAt)}</td>
                          <td>{formatRelative(w.lastSeenAt)}</td>
                        </tr>
                      );
                    })}
                    {data.workers.length === 0 && (
                      <tr>
                        <td colspan={4} class="empty-state">No active workers.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function DeadLettersView({
  config,
  pollInterval,
  paused,
  refreshSignal,
}: {
  config: ConsoleConfig;
  pollInterval: number;
  paused: boolean;
  refreshSignal: number;
}) {
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<ApiError | Error | null>(null);
  const [dismissedError, setDismissedError] = useState<Error | null>(null);

  const fetchDeadLetters = useCallback(async () => {
    return await api<DeadLetter[]>(config, "/dead-letters");
  }, [config]);

  const { data, error, refresh } = usePolled(
    fetchDeadLetters,
    [fetchDeadLetters, refreshSignal],
    pollInterval,
    paused,
  );

  const effectiveError = actionError ?? error;
  const activeError = effectiveError === dismissedError ? null : effectiveError;
  const isForbidden = activeError && "code" in activeError && activeError.code === "forbidden";

  const handleReplay = async () => {
    if (!window.confirm("Replay up to 100 dead letters?")) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await api(config, "/dead-letters/replay", {
        method: "POST",
        body: JSON.stringify({ maxEvents: 100 }),
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div>
      <div class="section-header" style={{ marginTop: 0 }}>
        <h3 class="section-title">Dead letter queue</h3>
        {!config.readOnly && (
          <button
            type="button"
            class="btn-primary"
            disabled={actionLoading}
            onClick={handleReplay}
          >
            {actionLoading ? "Replaying..." : "Replay dead letters"}
          </button>
        )}
      </div>

      <ErrorBanner
        error={activeError}
        onDismiss={() => {
          setDismissedError(effectiveError);
          setActionError(null);
        }}
      />

      {data && !isForbidden && (
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th scope="col">Sequence</th>
                <th scope="col">Workflow run</th>
                <th scope="col">Event type</th>
                <th scope="col">Retries</th>
                <th scope="col">Occurred</th>
                <th scope="col">DLQ time</th>
              </tr>
            </thead>
            <tbody>
              {data.map((dl) => (
                <tr key={dl.id}>
                  <td>{dl.sequence}</td>
                  <td>
                    <a href={`#/runs/${encodeURIComponent(dl.workflowRunId)}`} title={dl.workflowRunId}>
                      {dl.workflowRunId.length > 12 ? `…${dl.workflowRunId.slice(-12)}` : dl.workflowRunId}
                    </a>
                  </td>
                  <td>{dl.eventType}</td>
                  <td>{dl.retryCount}</td>
                  <td>{formatAbsolute(dl.occurredAt)}</td>
                  <td>{formatAbsolute(dl.dlqAt)}</td>
                </tr>
              ))}
              {data.length === 0 && (
                <tr>
                  <td colspan={6} class="empty-state">No dead letters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CostsView({
  config,
  pollInterval,
  paused,
  refreshSignal,
}: {
  config: ConsoleConfig;
  pollInterval: number;
  paused: boolean;
  refreshSignal: number;
}) {
  const [by, setBy] = useState<"workflow" | "day">("workflow");
  const [dismissedError, setDismissedError] = useState<Error | null>(null);

  const fetchCosts = useCallback(async () => {
    return await api<CostBucket[]>(config, `/costs?by=${by}`);
  }, [config, by]);

  const { data, error } = usePolled(
    fetchCosts,
    [fetchCosts, refreshSignal],
    pollInterval,
    paused,
  );

  const activeError = error === dismissedError ? null : error;
  const isForbidden = activeError && "code" in activeError && activeError.code === "forbidden";

  const maxCost = useMemo(() => {
    return Math.max(0.0001, ...(data ?? []).map((b) => b.cost));
  }, [data]);

  return (
    <div>
      <div class="section-header" style={{ marginTop: 0 }}>
        <h3 class="section-title">Cost rollups</h3>
        <div class="toggle-group">
          <button
            type="button"
            class={`btn-toggle ${by === "workflow" ? "active" : ""}`}
            onClick={() => setBy("workflow")}
          >
            By workflow
          </button>
          <button
            type="button"
            class={`btn-toggle ${by === "day" ? "active" : ""}`}
            onClick={() => setBy("day")}
          >
            By day
          </button>
        </div>
      </div>

      <ErrorBanner
        error={activeError}
        onDismiss={() => setDismissedError(error)}
      />

      {data && !isForbidden && (
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th scope="col">{by === "workflow" ? "Workflow ID" : "Date"}</th>
                <th scope="col">Runs</th>
                <th scope="col">Cost</th>
                <th scope="col">Tokens</th>
                <th scope="col" style={{ width: "30%" }}>Proportion</th>
              </tr>
            </thead>
            <tbody>
              {data.map((bucket) => {
                const pct = Math.min(100, Math.max(0.5, (bucket.cost / maxCost) * 100));
                return (
                  <tr key={bucket.key}>
                    <td>{bucket.key}</td>
                    <td>{bucket.runs.toLocaleString()}</td>
                    <td>{formatCost(bucket.cost)}</td>
                    <td>{formatTokens(bucket.tokens)}</td>
                    <td>
                      <div class="cost-bar-track">
                        <div
                          class="cost-bar-fill"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {data.length === 0 && (
                <tr>
                  <td colspan={5} class="empty-state">No cost data available.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const INTERVAL_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
  { label: "60s", value: 60000 },
];

function App({ config }: { config: ConsoleConfig }) {
  const route = useHashRoute();
  const [pollInterval, setPollInterval] = useState<number>(() =>
    config.forcePollInterval
      ? config.pollIntervalMs
      : getStoredPollInterval(config.pollIntervalMs),
  );
  const [refreshSignal, setRefreshSignal] = useState<number>(0);

  const handlePollChange = (val: number) => {
    setPollInterval(val);
    setStoredPollInterval(val);
  };

  const handleRefreshNow = () => {
    setRefreshSignal((s) => s + 1);
  };

  const showQueueTab =
    config.capabilities.queue ||
    config.capabilities.suspended ||
    config.capabilities.workers;

  const currentView = useMemo(() => {
    if (route.view === "run-detail") {
      return (
        <RunDetailView
          config={config}
          runId={route.runId}
          pollInterval={pollInterval}
          paused={pollInterval === 0}
          refreshSignal={refreshSignal}
        />
      );
    }
    if (route.view === "queue" && showQueueTab) {
      return (
        <QueueView
          config={config}
          pollInterval={pollInterval}
          paused={pollInterval === 0}
          refreshSignal={refreshSignal}
        />
      );
    }
    if (route.view === "dead-letters" && config.capabilities.deadLetters) {
      return (
        <DeadLettersView
          config={config}
          pollInterval={pollInterval}
          paused={pollInterval === 0}
          refreshSignal={refreshSignal}
        />
      );
    }
    if (route.view === "costs" && config.capabilities.costs) {
      return (
        <CostsView
          config={config}
          pollInterval={pollInterval}
          paused={pollInterval === 0}
          refreshSignal={refreshSignal}
        />
      );
    }
    return (
      <RunsView
        config={config}
        pollInterval={pollInterval}
        paused={pollInterval === 0}
        refreshSignal={refreshSignal}
      />
    );
  }, [route, config, pollInterval, refreshSignal, showQueueTab]);

  return (
    <div>
      <header class="header">
        <div class="header-title-group">
          <h1 class="header-title">Workflow console</h1>
          {config.readOnly && <span class="badge badge-readonly">Read-only</span>}
        </div>
        <div class="header-controls">
          {!config.forcePollInterval && (
            <div>
              <label class="sr-only" for="wc-poll-select">Poll interval</label>
              <select
                id="wc-poll-select"
                value={pollInterval}
                onChange={(e) => handlePollChange(Number((e.target as HTMLSelectElement).value))}
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="button" class="btn-refresh" onClick={handleRefreshNow}>
            Refresh now
          </button>
        </div>
      </header>

      <nav class="nav-tabs" aria-label="Console navigation">
        {config.capabilities.runs && (
          <a
            href="#/runs"
            class={`nav-tab ${route.view === "runs" || route.view === "run-detail" ? "active" : ""}`}
            aria-current={route.view === "runs" || route.view === "run-detail" ? "page" : undefined}
          >
            Runs
          </a>
        )}
        {showQueueTab && (
          <a
            href="#/queue"
            class={`nav-tab ${route.view === "queue" ? "active" : ""}`}
            aria-current={route.view === "queue" ? "page" : undefined}
          >
            Queue
          </a>
        )}
        {config.capabilities.deadLetters && (
          <a
            href="#/dead-letters"
            class={`nav-tab ${route.view === "dead-letters" ? "active" : ""}`}
            aria-current={route.view === "dead-letters" ? "page" : undefined}
          >
            Dead letters
          </a>
        )}
        {config.capabilities.costs && (
          <a
            href="#/costs"
            class={`nav-tab ${route.view === "costs" ? "active" : ""}`}
            aria-current={route.view === "costs" ? "page" : undefined}
          >
            Costs
          </a>
        )}
      </nav>

      <main>{currentView}</main>
    </div>
  );
}

function boot(): void {
  const container = document.getElementById("workflow-console");
  if (!container) return;

  const configScript = document.getElementById("workflow-console-config");
  if (!configScript || !configScript.textContent) {
    container.textContent = "Workflow console configuration element missing.";
    return;
  }

  let config: ConsoleConfig;
  try {
    config = JSON.parse(configScript.textContent) as ConsoleConfig;
  } catch {
    container.textContent = "Workflow console configuration is invalid.";
    return;
  }

  render(<App config={config} />, container);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
