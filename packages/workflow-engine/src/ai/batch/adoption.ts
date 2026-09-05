/**
 * Crash recovery for batch submissions.
 *
 * A batch submit is a non-idempotent external call inside a replayable step.
 * When the worker dies between the provider accepting the creation and the
 * ledger recording it, the replay must find the batch that already exists
 * instead of creating a second one that is billed and never read.
 *
 * Two providers make that possible, and the engine uses the field each one
 * offers:
 *
 * - **OpenAI** — `POST /v1/batches` accepts `metadata`, "a set of 16 key-value
 *   pairs ... useful for storing additional information about the object in a
 *   structured format, and querying for objects via API or the dashboard"
 *   (keys ≤64 chars, values ≤512), and `GET /v1/batches` returns it on every
 *   listed batch. The engine stamps the step's external key into
 *   `metadata.workflow_engine_external_key` and searches the list for it.
 * - **Gemini Developer API** — batch creation takes `batch.displayName`, and
 *   `GET /v1beta/batches` lists jobs with their display name. The engine
 *   overwrites the AI SDK's generated display name with the external key.
 *   This matters most here: Google documents that "if you send the same
 *   creation request twice, two separate batch jobs will be created".
 *
 * Anthropic Message Batches carry no metadata field, and OpenRouter's beta
 * batch body takes only `endpoint`, `model` and `requests`. Neither offers a
 * request-idempotency header the engine can rely on, so on those transports a
 * crashed submit is not recoverable and the engine says so loudly rather than
 * paying twice.
 *
 * The provider SDKs expose no hook for these fields, so — exactly as
 * `google-json-schema.ts` already does for the response schema — the engine
 * rewrites the creation body at the `fetch` boundary.
 */

import type { FetchLike } from "./google-json-schema";
import type { EngineBatchRef, EngineBatchStatus } from "./model";

/** Metadata key the engine stamps its external key into on OpenAI batches. */
export const EXTERNAL_KEY_METADATA_FIELD = "workflow_engine_external_key";

/** Reads the key the in-flight `start()` call is creating a batch under. */
export type CurrentExternalKey = () => string | undefined;

function urlOf(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

/**
 * Wrap a fetch so an OpenAI batch creation carries the engine's external key
 * in `metadata`. Every other request passes through untouched.
 */
export function createOpenAIBatchFetch(
  base: FetchLike | undefined,
  currentKey: CurrentExternalKey,
): FetchLike {
  const underlying: FetchLike = base ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    const key = currentKey();
    const url = urlOf(input);
    if (
      key === undefined ||
      !/\/batches$/.test(url.split("?")[0] ?? url) ||
      (init?.method ?? "GET").toUpperCase() !== "POST" ||
      typeof init?.body !== "string"
    ) {
      return underlying(input, init);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return underlying(input, init);
    }
    if (typeof parsed !== "object" || parsed === null) {
      return underlying(input, init);
    }
    const body = parsed as { metadata?: Record<string, unknown> };
    body.metadata = {
      ...(body.metadata ?? {}),
      [EXTERNAL_KEY_METADATA_FIELD]: key,
    };
    return underlying(input, { ...init, body: JSON.stringify(body) });
  };
}

interface OpenAIBatchListRow {
  id?: unknown;
  status?: unknown;
  metadata?: Record<string, unknown> | null;
}

/**
 * OpenAI batch statuses, mapped the way `@ai-sdk/openai` maps them, so an
 * adopted batch reports the same status the same batch would report through
 * the normal `status()` path.
 */
function mapOpenAIStatus(raw: unknown): EngineBatchStatus["status"] {
  switch (raw) {
    case "completed":
      return "completed";
    case "failed":
    case "expired":
    case "cancelled":
      return "failed";
    default:
      return "pending";
  }
}

export interface AdoptRequest {
  fetch?: FetchLike;
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** Pages of the provider's list endpoint to scan before giving up. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 5;
const LIST_PAGE_SIZE = 100;

/** Find an OpenAI batch stamped with `externalKey`, newest first. */
export async function adoptOpenAIBatch(
  request: AdoptRequest,
  externalKey: string,
): Promise<{ id: string; status: EngineBatchStatus["status"] } | null> {
  const doFetch = request.fetch ?? ((input, init) => fetch(input, init));
  const base = request.baseURL.replace(/\/+$/, "");
  let after: string | undefined;
  for (let page = 0; page < (request.maxPages ?? DEFAULT_MAX_PAGES); page++) {
    const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    if (after) query.set("after", after);
    const res = await doFetch(`${base}/batches?${query.toString()}`, {
      method: "GET",
      headers: {
        ...request.headers,
        Authorization: `Bearer ${request.apiKey}`,
      },
      signal: request.abortSignal,
    });
    if (!res.ok) {
      throw new Error(
        `OpenAI batch lookup failed (HTTP ${res.status}) while recovering external key "${externalKey}"`,
      );
    }
    const body = (await res.json()) as {
      data?: OpenAIBatchListRow[];
      has_more?: boolean;
      last_id?: string;
    };
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const row of rows) {
      if (
        typeof row.id === "string" &&
        row.metadata?.[EXTERNAL_KEY_METADATA_FIELD] === externalKey
      ) {
        return { id: row.id, status: mapOpenAIStatus(row.status) };
      }
    }
    if (body.has_more !== true || rows.length === 0) return null;
    after =
      typeof body.last_id === "string"
        ? body.last_id
        : typeof rows[rows.length - 1]?.id === "string"
          ? (rows[rows.length - 1]!.id as string)
          : undefined;
    if (!after) return null;
  }
  return null;
}

/**
 * Wrap a fetch so a Gemini batch creation carries the engine's external key
 * as its `displayName`, replacing the AI SDK's generated one.
 */
export function createGoogleDisplayNameStamp(
  currentKey: CurrentExternalKey,
): (body: unknown) => boolean {
  return (body: unknown) => {
    const key = currentKey();
    if (key === undefined) return false;
    const batch = (body as { batch?: Record<string, unknown> })?.batch;
    if (typeof batch !== "object" || batch === null) return false;
    batch.displayName = key;
    return true;
  };
}

interface GoogleOperationRow {
  name?: unknown;
  displayName?: unknown;
  state?: unknown;
  metadata?: { displayName?: unknown; state?: unknown } | null;
}

/** Gemini batch job states, mapped the way `@ai-sdk/google` maps them. */
function mapGoogleState(raw: unknown): EngineBatchStatus["status"] {
  switch (raw) {
    case "JOB_STATE_SUCCEEDED":
      return "completed";
    case "JOB_STATE_FAILED":
    case "JOB_STATE_CANCELLED":
    case "JOB_STATE_EXPIRED":
      return "failed";
    default:
      return "pending";
  }
}

/** Find a Gemini batch job whose `displayName` is `externalKey`. */
export async function adoptGoogleBatch(
  request: AdoptRequest,
  externalKey: string,
): Promise<{ id: string; status: EngineBatchStatus["status"] } | null> {
  const doFetch = request.fetch ?? ((input, init) => fetch(input, init));
  const base = request.baseURL.replace(/\/+$/, "");
  let pageToken: string | undefined;
  for (let page = 0; page < (request.maxPages ?? DEFAULT_MAX_PAGES); page++) {
    const query = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
    if (pageToken) query.set("pageToken", pageToken);
    const res = await doFetch(`${base}/batches?${query.toString()}`, {
      method: "GET",
      headers: {
        ...request.headers,
        "x-goog-api-key": request.apiKey,
      },
      signal: request.abortSignal,
    });
    if (!res.ok) {
      throw new Error(
        `Gemini batch lookup failed (HTTP ${res.status}) while recovering external key "${externalKey}"`,
      );
    }
    // The endpoint is long-running-operation shaped ("operations"), but the
    // SDKs surface it as batch jobs; accept either envelope and read the
    // display name from the operation metadata or the row itself.
    const body = (await res.json()) as {
      operations?: GoogleOperationRow[];
      batches?: GoogleOperationRow[];
      nextPageToken?: string;
    };
    const rows = body.operations ?? body.batches ?? [];
    for (const row of rows) {
      const displayName = row.metadata?.displayName ?? row.displayName;
      if (typeof row.name === "string" && displayName === externalKey) {
        return {
          id: row.name,
          status: mapGoogleState(row.metadata?.state ?? row.state),
        };
      }
    }
    pageToken = body.nextPageToken;
    if (!pageToken || rows.length === 0) return null;
  }
  return null;
}

/** Build the adopted handle an `EngineBatchModel.adopt` returns. */
export function adoptedRef(
  found: { id: string; status: EngineBatchStatus["status"] },
  provider: string,
  modelId: string,
): EngineBatchRef & EngineBatchStatus {
  return {
    version: 1,
    type: "text",
    id: found.id,
    provider,
    modelId,
    status: found.status,
  };
}
