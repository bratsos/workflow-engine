/**
 * The provider-side half of crash recovery: the external key is stamped into
 * the field each provider exposes at creation, and found again by listing.
 */

import { describe, expect, it, vi } from "vitest";
import {
  adoptGoogleBatch,
  adoptOpenAIBatch,
  createGoogleDisplayNameStamp,
  createOpenAIBatchFetch,
  EXTERNAL_KEY_METADATA_FIELD,
} from "../../ai/batch/adoption.js";
import { createGoogleBatchFetch } from "../../ai/batch/google-json-schema.js";

const KEY = "wfe-0123456789abcdef0123456789abcdef-p0";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI batch metadata stamping", () => {
  it("adds the external key to the batch creation body and nothing else", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const base = vi.fn(async (input: any, init: any) => {
      seen.push({ url: String(input), body: JSON.parse(init.body) });
      return jsonResponse({ id: "batch_1" });
    });
    const wrapped = createOpenAIBatchFetch(base as never, () => KEY);

    await wrapped("https://api.openai.com/v1/batches", {
      method: "POST",
      body: JSON.stringify({
        input_file_id: "file_1",
        endpoint: "/v1/responses",
      }),
    });

    expect(seen[0]?.body).toEqual({
      input_file_id: "file_1",
      endpoint: "/v1/responses",
      metadata: { [EXTERNAL_KEY_METADATA_FIELD]: KEY },
    });
  });

  it("leaves every other request untouched", async () => {
    const base = vi.fn(async () => jsonResponse({ ok: true }));
    const wrapped = createOpenAIBatchFetch(base as never, () => KEY);

    await wrapped("https://api.openai.com/v1/files", {
      method: "POST",
      body: "not json",
    });
    await wrapped("https://api.openai.com/v1/batches/batch_1", {
      method: "GET",
    });

    expect(base).toHaveBeenCalledTimes(2);
    expect((base.mock.calls[0] as any[])[1].body).toBe("not json");
  });
});

describe("adoptOpenAIBatch", () => {
  it("finds the batch carrying the key and maps its status", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "batch_other", status: "in_progress", metadata: {} },
          {
            id: "batch_ours",
            status: "in_progress",
            metadata: { [EXTERNAL_KEY_METADATA_FIELD]: KEY },
          },
        ],
        has_more: false,
      }),
    );

    await expect(
      adoptOpenAIBatch(
        {
          fetch: fetchFn as never,
          baseURL: "https://api.openai.com/v1",
          apiKey: "k",
        },
        KEY,
      ),
    ).resolves.toEqual({ id: "batch_ours", status: "pending" });
  });

  it("pages until the key is found", async () => {
    let page = 0;
    const fetchFn = vi.fn(async () => {
      page++;
      return page === 1
        ? jsonResponse({
            data: [{ id: "batch_a", status: "completed", metadata: {} }],
            has_more: true,
            last_id: "batch_a",
          })
        : jsonResponse({
            data: [
              {
                id: "batch_b",
                status: "completed",
                metadata: { [EXTERNAL_KEY_METADATA_FIELD]: KEY },
              },
            ],
            has_more: false,
          });
    });

    await expect(
      adoptOpenAIBatch(
        {
          fetch: fetchFn as never,
          baseURL: "https://api.openai.com/v1",
          apiKey: "k",
        },
        KEY,
      ),
    ).resolves.toEqual({ id: "batch_b", status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns null when the crashed worker never reached the provider", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ data: [], has_more: false }),
    );
    await expect(
      adoptOpenAIBatch(
        {
          fetch: fetchFn as never,
          baseURL: "https://api.openai.com/v1",
          apiKey: "k",
        },
        KEY,
      ),
    ).resolves.toBeNull();
  });
});

describe("Gemini batch displayName stamping", () => {
  it("replaces the SDK's generated display name on an inline creation", async () => {
    const seen: unknown[] = [];
    const base = vi.fn(async (_input: any, init: any) => {
      seen.push(JSON.parse(init.body));
      return jsonResponse({ name: "batches/abc" });
    });
    const wrapped = createGoogleBatchFetch(
      base as never,
      new Map(),
      undefined,
      createGoogleDisplayNameStamp(() => KEY),
    );

    await wrapped(
      "https://generativelanguage.googleapis.com/v1beta/models/x:batchGenerateContent",
      {
        method: "POST",
        body: JSON.stringify({
          batch: {
            displayName: "ai-sdk-batch-1",
            inputConfig: { requests: { requests: [] } },
          },
        }),
      },
    );

    expect(seen[0]).toMatchObject({ batch: { displayName: KEY } });
  });

  it("stamps the file-upload creation too", async () => {
    const seen: unknown[] = [];
    const onFileUpload = vi.fn();
    const base = vi.fn(async (_input: any, init: any) => {
      seen.push(JSON.parse(init.body));
      return jsonResponse({ name: "batches/abc" });
    });
    const wrapped = createGoogleBatchFetch(
      base as never,
      new Map(),
      onFileUpload,
      createGoogleDisplayNameStamp(() => KEY),
    );

    await wrapped(
      "https://generativelanguage.googleapis.com/v1beta/models/x:batchGenerateContent",
      {
        method: "POST",
        body: JSON.stringify({
          batch: {
            displayName: "ai-sdk-batch-1",
            inputConfig: { fileName: "files/in" },
          },
        }),
      },
    );

    expect(onFileUpload).toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ batch: { displayName: KEY } });
  });
});

describe("adoptGoogleBatch", () => {
  it("matches the operation whose displayName is the key", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        operations: [
          {
            name: "batches/other",
            metadata: {
              displayName: "ai-sdk-batch-9",
              state: "JOB_STATE_RUNNING",
            },
          },
          {
            name: "batches/ours",
            metadata: { displayName: KEY, state: "JOB_STATE_SUCCEEDED" },
          },
        ],
      }),
    );

    await expect(
      adoptGoogleBatch(
        {
          fetch: fetchFn as never,
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "k",
        },
        KEY,
      ),
    ).resolves.toEqual({ id: "batches/ours", status: "completed" });
  });

  it("accepts the batch-shaped envelope as well as the operations one", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        batches: [
          {
            name: "batches/ours",
            displayName: KEY,
            state: "JOB_STATE_PENDING",
          },
        ],
      }),
    );

    await expect(
      adoptGoogleBatch(
        {
          fetch: fetchFn as never,
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "k",
        },
        KEY,
      ),
    ).resolves.toEqual({ id: "batches/ours", status: "pending" });
  });

  it("throws rather than reporting 'no batch' when the lookup itself fails", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      adoptGoogleBatch(
        {
          fetch: fetchFn as never,
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "k",
        },
        KEY,
      ),
    ).rejects.toThrow(/Gemini batch lookup failed \(HTTP 500\)/);
  });
});
