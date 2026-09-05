import {
  type ConsoleAction,
  type ConsoleActionEvent,
  type ConsoleAuthorizeContext,
  type ConsoleKernel,
} from "./actions";
import { ConsoleBadRequestError, ConsoleQueryTimeoutError } from "./errors";
import {
  type ConsoleReadPort,
  type ConsoleStatus,
  clampLimit,
  isConsoleStatus,
  type RunListFilters,
} from "./read-port";
import { renderIndexHtml, UI_ASSETS } from "./ui-assets";

/**
 * The engine's `RunRedriveFrom`, restated rather than imported: the console
 * types kernel commands structurally (`ConsoleKernel.dispatch`) so it can be
 * mounted against any compatible kernel without a value dependency on one.
 */
type RunRedriveFrom =
  | { readonly kind: "lastFailure" }
  | { readonly kind: "start" }
  | { readonly kind: "stage"; readonly stageId: string };

/** The engine's `StepSignalCommand`, restated for the same reason. */
type StepSignalCommand = {
  readonly type: "step.signal";
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly stepId: string;
  readonly payload: unknown;
};

/**
 * The kernel reports a signal that cannot land as a thrown `Error` whose
 * message says why. The console answers with the status the reason
 * deserves rather than a 500: an unknown stage is a 404, and a step that
 * is not a pending signal is a 409, because the request was well-formed
 * and the ledger is what refused it.
 */
function signalErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  if (/ not found$/.test(message)) return 404;
  if (
    message.includes("was previously used as") ||
    message.includes("has failed and cannot receive a signal") ||
    message.endsWith("changed state")
  ) {
    return 409;
  }
  return undefined;
}

export interface WorkflowConsoleOptions {
  /** Reads run on this. It is constructed from the caller's client or transaction; the console never opens one. */
  reader: ConsoleReadPort;
  /**
   * Per-request authorisation. Omit it and every action is denied — a
   * console that shipped with a permissive default would be a way to leak
   * a tenant's runs by forgetting one line of configuration.
   *
   * It runs *after* the host's authentication. Assume "is this request
   * authenticated?" is already decided; answer only "may this principal do
   * this?". A throw denies, so a bug in the callback fails closed.
   */
  authorize?: (context: ConsoleAuthorizeContext) => boolean | Promise<boolean>;
  /** Required only when `actions` is true. */
  kernel?: ConsoleKernel;
  /** Write actions are off unless this is true. Read-only is the default. */
  actions?: boolean;
  /**
   * Mount path, if the handler cannot work it out. It normally can: the
   * SPA routes on the fragment, so the only paths the server ever sees are
   * the mount root itself, `<root>/api/...` and `<root>/assets/...`.
   */
  basePath?: string;
  /** UI poll interval in ms. Default 5000; the surveyed consoles sit between 1s and 5s and a shared console should be at the slow end. */
  pollIntervalMs?: number;
  /** Fix the poll interval and hide the picker. */
  forcePollInterval?: boolean;
  /** Supply a CSP nonce for the injected config script, for hosts running a strict policy. */
  cspNonce?: (request: Request) => string | undefined;
  /** Called after every allowed write. The audit trail hosts would otherwise have to build themselves. */
  onAction?: (event: ConsoleActionEvent) => void | Promise<void>;
}

export type WorkflowConsoleHandler = (request: Request) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, dateReplacer), {
    status,
    headers: JSON_HEADERS,
  });
}

/** Dates cross the wire as ISO strings; the UI parses them back. */
function dateReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return json({ error: { code, message } }, status);
}

/**
 * Work out where this handler is mounted from the request alone.
 *
 * The SPA routes on the URL fragment, which never reaches the server, so
 * the only three shapes that arrive are the mount root, `<root>/api/...`
 * and `<root>/assets/...`. That makes the prefix unambiguous without the
 * caller telling us, and without a build-time base path — pg-boss's
 * dashboard bakes its base path in at build time, which means a consumer
 * cannot change where it is mounted without rebuilding it.
 */
function splitPath(
  pathname: string,
  configuredBase: string | undefined,
): { basePath: string; route: string } {
  if (configuredBase !== undefined) {
    const base = normaliseBase(configuredBase);
    const route = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : pathname;
    return { basePath: base, route: route === "" ? "/" : route };
  }
  for (const marker of ["/api/", "/assets/"] as const) {
    const at = pathname.lastIndexOf(marker);
    if (at !== -1) {
      return {
        basePath: normaliseBase(pathname.slice(0, at)),
        route: pathname.slice(at),
      };
    }
  }
  // Anything else is the mount root, with or without a trailing slash.
  return { basePath: normaliseBase(pathname), route: "/" };
}

function normaliseBase(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed;
}

function parseStatuses(raw: string[]): ConsoleStatus[] {
  const statuses: ConsoleStatus[] = [];
  for (const entry of raw.flatMap((value) => value.split(","))) {
    const candidate = entry.trim().toUpperCase();
    if (candidate === "") continue;
    if (!isConsoleStatus(candidate)) {
      throw new ConsoleBadRequestError(`Unknown status "${entry.trim()}".`);
    }
    if (!statuses.includes(candidate)) statuses.push(candidate);
  }
  return statuses;
}

function parseDate(raw: string | null, field: string): Date | undefined {
  if (raw === null || raw === "") return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConsoleBadRequestError(`Invalid ${field}: "${raw}".`);
  }
  return parsed;
}

function parseFilters(params: URLSearchParams): RunListFilters {
  const filters: RunListFilters = {};
  const statuses = parseStatuses(params.getAll("status"));
  if (statuses.length > 0) filters.status = statuses;
  const workflowId = params.get("workflowId");
  if (workflowId) filters.workflowId = workflowId;
  const workflowType = params.get("workflowType");
  if (workflowType) filters.workflowType = workflowType;
  const definitionVersion = params.get("definitionVersion");
  if (definitionVersion) filters.definitionVersion = definitionVersion;
  const after = parseDate(params.get("from"), "from");
  if (after) filters.createdAfter = after;
  const before = parseDate(params.get("to"), "to");
  if (before) filters.createdBefore = before;
  return filters;
}

function parseLimit(params: URLSearchParams): number | undefined {
  const raw = params.get("limit");
  if (raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConsoleBadRequestError(`Invalid limit: "${raw}".`);
  }
  return clampLimit(parsed);
}

/**
 * Build a fetch handler serving the console's JSON API and its prebuilt UI.
 *
 * It opens no connection: every read goes through `reader`, which the caller
 * built over the client or transaction they already had, so the console runs
 * in the caller's security context and inherits their row-level security
 * rather than working around it.
 */
export function createWorkflowConsole(
  options: WorkflowConsoleOptions,
): WorkflowConsoleHandler {
  const {
    reader,
    kernel,
    authorize,
    actions = false,
    basePath,
    pollIntervalMs = 5000,
    forcePollInterval = false,
    cspNonce,
    onAction,
  } = options;

  if (actions && !kernel) {
    throw new Error(
      "createWorkflowConsole: `actions: true` needs a `kernel` to dispatch to. Console writes go through kernel commands, never SQL.",
    );
  }

  const readOnly = !actions;

  async function allowed(
    action: ConsoleAction,
    request: Request,
    runId?: string,
    scope?: { stageId: string; stepId: string },
  ): Promise<boolean> {
    if (authorize === undefined) return false;
    try {
      return (await authorize({ action, request, runId, ...scope })) === true;
    } catch {
      // A throw in the host's own authorisation code denies the call rather
      // than allowing it.
      return false;
    }
  }

  async function dispatch(
    request: Request,
    action: ConsoleAction,
    command: { readonly type: string; readonly [key: string]: unknown },
    runId?: string,
    scope?: { stageId: string; stepId: string },
  ): Promise<Response> {
    if (readOnly) {
      return errorResponse(
        "read_only",
        "This console is read-only. Construct it with `actions: true` to enable writes.",
        405,
      );
    }
    if (!(await allowed(action, request, runId, scope))) {
      return errorResponse("forbidden", "Not permitted.", 403);
    }
    const result = await kernel!.dispatch(command);
    if (onAction) {
      await onAction({
        action,
        runId,
        ...scope,
        request,
        result,
        at: new Date(),
      });
    }
    return json({ result });
  }

  async function readBody(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (text.trim() === "") return {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new ConsoleBadRequestError("Body must be a JSON object.");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ConsoleBadRequestError) throw error;
      throw new ConsoleBadRequestError("Body must be valid JSON.");
    }
  }

  /**
   * Read the optional `from` of a redrive request.
   *
   * Returns `undefined` when the caller sent none, which the legacy
   * `fromStageId` shape then covers. A malformed one is a bad request
   * rather than a silent fall back to the default mode: an operator who
   * asked to restart the whole run must not get a retry of one stage.
   */
  function parseRedriveFrom(value: unknown): RunRedriveFrom | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConsoleBadRequestError("`from` must be an object.");
    }
    const kind = (value as Record<string, unknown>).kind;
    if (kind === "lastFailure" || kind === "start") return { kind };
    if (kind === "stage") {
      const stageId = (value as Record<string, unknown>).stageId;
      if (typeof stageId !== "string" || stageId === "") {
        throw new ConsoleBadRequestError(
          '`from.stageId` is required for `from.kind` "stage".',
        );
      }
      return { kind: "stage", stageId };
    }
    throw new ConsoleBadRequestError(
      '`from.kind` must be "lastFailure", "start" or "stage".',
    );
  }

  async function guardedRead(
    request: Request,
    action: ConsoleAction,
    runId: string | undefined,
    produce: () => Promise<unknown>,
  ): Promise<Response> {
    if (!(await allowed(action, request, runId))) {
      return errorResponse("forbidden", "Not permitted.", 403);
    }
    return json(await produce());
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { basePath: base, route } = splitPath(url.pathname, basePath);
    const params = url.searchParams;
    const method = request.method.toUpperCase();

    try {
      // ---- static UI -------------------------------------------------
      if (route === "/" && (method === "GET" || method === "HEAD")) {
        const html = renderIndexHtml({
          basePath: base,
          readOnly,
          pollIntervalMs,
          forcePollInterval,
          capabilities: reader.capabilities,
          nonce: cspNonce?.(request),
        });
        return new Response(method === "HEAD" ? null : html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            // The document carries the mount path and the feature flags, so
            // it must never be cached; the assets it points at are
            // content-hashed and cached forever.
            "cache-control": "no-store",
          },
        });
      }

      if (route.startsWith("/assets/")) {
        if (method !== "GET" && method !== "HEAD") {
          return errorResponse(
            "method_not_allowed",
            "Method not allowed.",
            405,
          );
        }
        const asset = UI_ASSETS[route.slice("/assets/".length)];
        if (!asset) {
          return errorResponse("not_found", "No such asset.", 404);
        }
        return new Response(method === "HEAD" ? null : asset.body, {
          headers: {
            "content-type": asset.contentType,
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }

      // ---- JSON API --------------------------------------------------
      if (!route.startsWith("/api/")) {
        return errorResponse("not_found", "No such route.", 404);
      }
      const api = route.slice("/api".length);

      if (api === "/meta" && method === "GET") {
        // Deliberately not behind `authorize`: it carries no run data, and
        // the SPA needs it to render the "you are not permitted" state at
        // all. It is the same information already embedded in the HTML.
        return json({
          readOnly,
          basePath: base,
          pollIntervalMs,
          forcePollInterval,
          capabilities: reader.capabilities,
        });
      }

      if (api === "/runs" && method === "GET") {
        return await guardedRead(request, "runs.read", undefined, () =>
          reader.listRuns({
            filters: parseFilters(params),
            cursor: params.get("cursor") ?? undefined,
            limit: parseLimit(params),
          }),
        );
      }

      const runDetail = /^\/runs\/([^/]+)$/.exec(api);
      if (runDetail && method === "GET") {
        const runId = decodeURIComponent(runDetail[1]!);
        if (!(await allowed("run.read", request, runId))) {
          return errorResponse("forbidden", "Not permitted.", 403);
        }
        const detail = await reader.getRunDetail(runId);
        if (detail === null) {
          return errorResponse("not_found", "No such run.", 404);
        }
        return json(detail);
      }

      const runEvents = /^\/runs\/([^/]+)\/events$/.exec(api);
      if (runEvents && method === "GET") {
        const runId = decodeURIComponent(runEvents[1]!);
        const afterRaw = params.get("afterSequence") ?? "0";
        const after = Number(afterRaw);
        if (!Number.isFinite(after) || after < 0) {
          throw new ConsoleBadRequestError(
            `Invalid afterSequence: "${afterRaw}".`,
          );
        }
        return await guardedRead(request, "run.read", runId, () =>
          reader.listRunEvents(runId, Math.floor(after), parseLimit(params)),
        );
      }

      if (api === "/queue" && method === "GET") {
        return await guardedRead(request, "queue.read", undefined, () =>
          reader.getQueueHealth(),
        );
      }

      if (api === "/suspended" && method === "GET") {
        return await guardedRead(request, "suspended.read", undefined, () =>
          reader.listSuspendedStages(parseLimit(params)),
        );
      }

      if (api === "/dead-letters" && method === "GET") {
        return await guardedRead(request, "deadLetters.read", undefined, () =>
          reader.listDeadLetters(parseLimit(params)),
        );
      }

      if (api === "/workers" && method === "GET") {
        return await guardedRead(request, "workers.read", undefined, () =>
          reader.listWorkers(),
        );
      }

      if (api === "/costs" && method === "GET") {
        const by = params.get("by") ?? "workflow";
        if (by !== "workflow" && by !== "day") {
          throw new ConsoleBadRequestError(
            `Invalid by: "${by}". Expected "workflow" or "day".`,
          );
        }
        return await guardedRead(request, "costs.read", undefined, () =>
          reader.getCosts({
            by,
            from: parseDate(params.get("from"), "from"),
            to: parseDate(params.get("to"), "to"),
          }),
        );
      }

      const cancel = /^\/runs\/([^/]+)\/cancel$/.exec(api);
      if (cancel && method === "POST") {
        const runId = decodeURIComponent(cancel[1]!);
        const body = await readBody(request);
        const reason =
          typeof body.reason === "string" ? body.reason : undefined;
        return await dispatch(
          request,
          "run.cancel",
          { type: "run.cancel", workflowRunId: runId, reason },
          runId,
        );
      }

      const rerun = /^\/runs\/([^/]+)\/rerun$/.exec(api);
      if (rerun && method === "POST") {
        const runId = decodeURIComponent(rerun[1]!);
        const body = await readBody(request);

        // Dispatches `run.redrive`, not the deprecated `run.rerunFrom` it
        // used to: the narrower command refuses a CANCELLED run and cannot
        // re-pin the definition version, so an operator had no way to move
        // a run stranded at a version nothing serves -- the case redriving
        // onto `"latest"` exists for. The request shape is a superset of
        // the old one: `fromStageId` still means "rerun from this stage".
        const fromStageId = body.fromStageId;
        const from = parseRedriveFrom(body.from);
        if (from === undefined) {
          if (typeof fromStageId !== "string" || fromStageId === "") {
            throw new ConsoleBadRequestError(
              "`fromStageId` is required and must be a non-empty string, or pass `from`.",
            );
          }
        }
        const definitionVersion = body.definitionVersion;
        if (
          definitionVersion !== undefined &&
          (typeof definitionVersion !== "string" || definitionVersion === "")
        ) {
          throw new ConsoleBadRequestError(
            "`definitionVersion` must be a non-empty string or omitted.",
          );
        }

        return await dispatch(
          request,
          "run.rerun",
          {
            type: "run.redrive",
            workflowRunId: runId,
            from: from ?? { kind: "stage", stageId: fromStageId as string },
            ...(definitionVersion !== undefined ? { definitionVersion } : {}),
          },
          runId,
        );
      }

      const signal =
        /^\/runs\/([^/]+)\/stages\/([^/]+)\/steps\/([^/]+)\/signal$/.exec(api);
      if (signal && method === "POST") {
        const runId = decodeURIComponent(signal[1]!);
        const stageId = decodeURIComponent(signal[2]!);
        const stepId = decodeURIComponent(signal[3]!);
        const body = await readBody(request);
        // Any JSON value is a payload; an absent one is `null`, which is
        // what a bare approval carries. `undefined` cannot arrive over JSON.
        const payload = "payload" in body ? body.payload : null;
        const command: StepSignalCommand = {
          type: "step.signal",
          workflowRunId: runId,
          stageId,
          stepId,
          payload,
        };
        try {
          return await dispatch(request, "step.signal", command, runId, {
            stageId,
            stepId,
          });
        } catch (error) {
          const status = signalErrorStatus(error);
          if (status === undefined) throw error;
          return errorResponse(
            status === 404 ? "not_found" : "conflict",
            (error as Error).message,
            status,
          );
        }
      }

      if (api === "/dead-letters/replay" && method === "POST") {
        const body = await readBody(request);
        const maxEvents =
          typeof body.maxEvents === "number" && Number.isFinite(body.maxEvents)
            ? Math.max(1, Math.floor(body.maxEvents))
            : undefined;
        return await dispatch(request, "deadLetters.replay", {
          type: "plugin.replayDLQ",
          maxEvents,
        });
      }

      return errorResponse("not_found", "No such route.", 404);
    } catch (error) {
      if (error instanceof ConsoleQueryTimeoutError) {
        // Non-fatal by design: the UI keeps its filter bar interactive and
        // shows this inline, so the operator can narrow the query and retry
        // instead of staring at a spinner.
        return errorResponse("query_timeout", error.message, 504);
      }
      if (error instanceof ConsoleBadRequestError) {
        return errorResponse("bad_request", error.message, 400);
      }
      return errorResponse(
        "internal_error",
        error instanceof Error ? error.message : "Unexpected console error.",
        500,
      );
    }
  };
}
