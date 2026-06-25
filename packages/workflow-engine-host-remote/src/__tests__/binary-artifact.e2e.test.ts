/**
 * E2E test: binary artifact support across all transport layers.
 *
 * Part A: InMemoryObjectStore binary round-trip (unit)
 * Part B: worker-client binary round-trip over a real HTTP server
 * Part C: S3BlobStore binary round-trip (fake-S3)
 * Part D: Full blob-shim binary round-trip through broker-server HTTP
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { createS3BlobStore } from "../object-store/s3/s3-blob-store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createBrokerHttpServer } from "../transport/http/broker-server.js";
import { createHttpWorkerTransport } from "../transport/http/worker-client.js";

// Binary bytes that are NOT valid UTF-8/JSON — proves real binary support.
const BINARY_BYTES = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x81, 0x82]);

// ---------------------------------------------------------------------------
// Part A: InMemoryObjectStore binary round-trip
// ---------------------------------------------------------------------------

describe("InMemoryObjectStore — binary round-trip", () => {
  it("putViaUrl with Uint8Array → getViaUrl returns same bytes", async () => {
    const os = new InMemoryObjectStore();
    const putUrl = await os.presignPut("artifacts/binary.bin", 60_000);
    await os.putViaUrl(putUrl, BINARY_BYTES);

    const getUrl = await os.presignGet("artifacts/binary.bin", 60_000);
    const result = await os.getViaUrl(getUrl);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual(Array.from(BINARY_BYTES));
  });

  it("BlobStore put with Uint8Array → get returns Uint8Array", async () => {
    const os = new InMemoryObjectStore();
    await os.put("artifacts/binary.bin", BINARY_BYTES);
    const result = await os.get("artifacts/binary.bin");

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual(Array.from(BINARY_BYTES));
  });

  it("JSON still round-trips via putViaUrl / getViaUrl", async () => {
    const os = new InMemoryObjectStore();
    const putUrl = await os.presignPut("artifacts/data.json", 60_000);
    await os.putViaUrl(putUrl, { a: 1 });

    const getUrl = await os.presignGet("artifacts/data.json", 60_000);
    const result = await os.getViaUrl(getUrl);

    expect(result).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Part B: worker-client binary round-trip over a tiny HTTP server
// ---------------------------------------------------------------------------

describe("worker-client — binary round-trip over HTTP", () => {
  const teardowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const t of teardowns) {
      await t().catch(() => {});
    }
    teardowns.length = 0;
  });

  function startEchoServer(): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }> {
    // Stores the last PUT body + content-type so GET can echo it back.
    let lastBody: Buffer | null = null;
    let lastContentType = "application/json";

    const server = http.createServer((req, res) => {
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          lastBody = Buffer.concat(chunks);
          lastContentType = req.headers["content-type"] ?? "application/json";
          res.writeHead(200);
          res.end();
        });
        return;
      }
      if (req.method === "GET") {
        if (!lastBody) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": lastContentType,
          "Content-Length": String(lastBody.length),
        });
        res.end(lastBody);
        return;
      }
      res.writeHead(405);
      res.end();
    });

    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        const baseUrl = `http://127.0.0.1:${port}`;
        resolve({
          baseUrl,
          close: () =>
            new Promise<void>((res, rej) =>
              server.close((e) => (e ? rej(e) : res())),
            ),
        });
      });
    });
  }

  it(
    "putBytes with Uint8Array sends application/octet-stream",
    { timeout: 5_000 },
    async () => {
      const { baseUrl, close } = await startEchoServer();
      teardowns.push(close);

      let capturedContentType: string | null = null;
      let capturedBody: Buffer | null = null;

      // Intercept the PUT using a second server that captures.
      const captureServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          capturedContentType = req.headers["content-type"] ?? null;
          capturedBody = Buffer.concat(chunks);
          res.writeHead(200);
          res.end();
        });
      });

      await new Promise<void>((resolve) =>
        captureServer.listen(0, "127.0.0.1", resolve),
      );
      const capturePort = (captureServer.address() as AddressInfo).port;
      const captureUrl = `http://127.0.0.1:${capturePort}`;
      teardowns.push(
        () =>
          new Promise<void>((res, rej) =>
            captureServer.close((e) => (e ? rej(e) : res())),
          ),
      );

      // Use the capture URL as the baseUrl so auth headers are included and
      // we can inspect what was sent.
      const transport = createHttpWorkerTransport({ baseUrl: captureUrl });
      await transport.putBytes(`${captureUrl}/data`, BINARY_BYTES);

      expect(capturedContentType).toBe("application/octet-stream");
      expect(capturedBody).not.toBeNull();
      expect(Array.from(new Uint8Array(capturedBody!))).toEqual(
        Array.from(BINARY_BYTES),
      );
    },
  );

  it(
    "getBytes receiving application/octet-stream returns Uint8Array",
    { timeout: 5_000 },
    async () => {
      const { baseUrl, close } = await startEchoServer();
      teardowns.push(close);

      const transport = createHttpWorkerTransport({ baseUrl });
      const putUrl = `${baseUrl}/data`;
      const getUrl = `${baseUrl}/data`;

      await transport.putBytes(putUrl, BINARY_BYTES);
      const result = await transport.getBytes(getUrl);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual(
        Array.from(BINARY_BYTES),
      );
    },
  );

  it(
    "JSON: putBytes with object sends application/json; getBytes returns object",
    { timeout: 5_000 },
    async () => {
      const { baseUrl, close } = await startEchoServer();
      teardowns.push(close);

      const transport = createHttpWorkerTransport({ baseUrl });
      const putUrl = `${baseUrl}/data`;
      const getUrl = `${baseUrl}/data`;

      await transport.putBytes(putUrl, { hello: "world" });
      const result = await transport.getBytes(getUrl);

      expect(result).toEqual({ hello: "world" });
    },
  );
});

// ---------------------------------------------------------------------------
// Part C: S3BlobStore binary round-trip (fake-S3)
// ---------------------------------------------------------------------------

describe("S3BlobStore — binary round-trip (fake-S3)", () => {
  // Inline minimal fake-S3 that echoes back the same Content-Type that was PUT.
  // Includes LIST support for the has/list/delete test.
  function startFakeS3Binary(bucket: string): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }> {
    const store = new Map<string, Buffer>();
    const contentTypes = new Map<string, string>();

    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? "/";
      const qIdx = rawUrl.indexOf("?");
      const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
      const qs = qIdx === -1 ? "" : rawUrl.slice(qIdx + 1);
      const params = new URLSearchParams(qs);

      // LIST: GET /bucket?list-type=2&prefix=...
      if (
        req.method === "GET" &&
        rawPath === `/${bucket}` &&
        params.get("list-type") === "2"
      ) {
        const prefix = params.get("prefix") ?? "";
        const allMatchingKeys = [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort();
        const keyXml = allMatchingKeys
          .map((k) => `<Contents><Key>${k}</Key></Contents>`)
          .join("");
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${keyXml}</ListBucketResult>`;
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(xml);
        return;
      }

      const bucketPrefix = `/${bucket}/`;
      if (!rawPath.startsWith(bucketPrefix)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const objectKey = rawPath.slice(bucketPrefix.length);

      if (req.method === "PUT") {
        const ct = req.headers["content-type"] ?? "application/octet-stream";
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          store.set(objectKey, Buffer.concat(chunks));
          contentTypes.set(objectKey, ct);
          res.writeHead(200);
          res.end();
        });
        return;
      }

      if (req.method === "GET") {
        const data = store.get(objectKey);
        if (!data) {
          res.writeHead(404);
          res.end();
          return;
        }
        const storedCt =
          contentTypes.get(objectKey) ?? "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": storedCt,
          "Content-Length": String(data.length),
        });
        res.end(data);
        return;
      }

      if (req.method === "HEAD") {
        if (!store.has(objectKey)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "DELETE") {
        store.delete(objectKey);
        contentTypes.delete(objectKey);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(405);
      res.end();
    });

    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        const baseUrl = `http://127.0.0.1:${port}`;
        resolve({
          baseUrl,
          close: () =>
            new Promise<void>((res, rej) =>
              server.close((e) => (e ? rej(e) : res())),
            ),
        });
      });
    });
  }

  function makeS3Config(baseUrl: string, bucket: string) {
    return {
      endpoint: baseUrl,
      region: "us-east-1",
      bucket,
      accessKeyId: "fakeaccesskey",
      secretAccessKey: "fakesecretkey",
      pathStyle: true,
    };
  }

  const teardowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const t of teardowns) {
      await t().catch(() => {});
    }
    teardowns.length = 0;
  });

  it(
    "put(key, Uint8Array) → get(key) returns equal bytes",
    { timeout: 10_000 },
    async () => {
      const { baseUrl, close } = await startFakeS3Binary("test-bucket");
      teardowns.push(close);

      const store = createS3BlobStore(makeS3Config(baseUrl, "test-bucket"));
      await store.put("binary/data.bin", BINARY_BYTES);
      const result = await store.get("binary/data.bin");

      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual(
        Array.from(BINARY_BYTES),
      );
    },
  );

  it(
    "put(key, JSON) → get(key) returns same JSON (JSON still works)",
    { timeout: 10_000 },
    async () => {
      const { baseUrl, close } = await startFakeS3Binary("test-bucket");
      teardowns.push(close);

      const store = createS3BlobStore(makeS3Config(baseUrl, "test-bucket"));
      await store.put("json/data.json", { hello: "world" });
      const result = await store.get("json/data.json");

      expect(result).toEqual({ hello: "world" });
    },
  );

  it(
    "has, list, delete are unaffected by binary support",
    { timeout: 10_000 },
    async () => {
      const { baseUrl, close } = await startFakeS3Binary("test-bucket");
      teardowns.push(close);

      const store = createS3BlobStore(makeS3Config(baseUrl, "test-bucket"));
      await store.put("prefix/file1.bin", BINARY_BYTES);
      await store.put("prefix/file2.json", { x: 1 });

      expect(await store.has("prefix/file1.bin")).toBe(true);
      expect(await store.has("prefix/file2.json")).toBe(true);
      expect(await store.has("prefix/nonexistent")).toBe(false);

      const keys = await store.list("prefix/");
      expect(keys).toContain("prefix/file1.bin");
      expect(keys).toContain("prefix/file2.json");

      await store.delete("prefix/file1.bin");
      expect(await store.has("prefix/file1.bin")).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Part D: Full blob-shim binary round-trip through broker-server HTTP
//
// We presign URLs directly via InMemoryObjectStore (bypassing the broker's
// lease validation), then issue real HTTP PUT/GET to the broker's /blob shim.
// This proves the blob shim correctly handles binary content-type.
// ---------------------------------------------------------------------------

describe("broker-server blob shim — binary round-trip", () => {
  const teardowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const t of teardowns) {
      await t().catch(() => {});
    }
    teardowns.length = 0;
  });

  async function startBlobShimServer(): Promise<{
    brokerBaseUrl: string;
    os: InMemoryObjectStore;
    close: () => Promise<void>;
  }> {
    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os,
      clock,
      stageCodeVersion: "v1",
      staleLeaseMs: 60_000,
    });

    const brokerServer = createBrokerHttpServer({
      broker,
      objectStore: os,
    });

    await new Promise<void>((resolve) =>
      brokerServer.listen(0, "127.0.0.1", resolve),
    );
    const brokerPort = (brokerServer.address() as AddressInfo).port;
    const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;

    return {
      brokerBaseUrl,
      os,
      close: () =>
        new Promise<void>((res, rej) =>
          brokerServer.close((e) => (e ? rej(e) : res())),
        ),
    };
  }

  it(
    "binary Uint8Array round-trips through the /blob shim (PUT then GET)",
    { timeout: 10_000 },
    async () => {
      const { brokerBaseUrl, os, close } = await startBlobShimServer();
      teardowns.push(close);

      const transport = createHttpWorkerTransport({ baseUrl: brokerBaseUrl });

      // Presign directly via the objectStore (bypasses broker lease check).
      const memPutUrl = await os.presignPut("artifacts/binary.bin", 60_000);
      const blobPutUrl = `${brokerBaseUrl}/blob?u=${encodeURIComponent(memPutUrl)}`;

      // PUT binary via transport through the /blob shim.
      await transport.putBytes(blobPutUrl, BINARY_BYTES);

      // Presign a GET URL for the same key.
      const memGetUrl = await os.presignGet("artifacts/binary.bin", 60_000);
      const blobGetUrl = `${brokerBaseUrl}/blob?u=${encodeURIComponent(memGetUrl)}`;

      // GET via transport — must return the same bytes.
      const result = await transport.getBytes(blobGetUrl);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual(
        Array.from(BINARY_BYTES),
      );
    },
  );

  it(
    "JSON still round-trips through the /blob shim",
    { timeout: 10_000 },
    async () => {
      const { brokerBaseUrl, os, close } = await startBlobShimServer();
      teardowns.push(close);

      const transport = createHttpWorkerTransport({ baseUrl: brokerBaseUrl });

      const memPutUrl = await os.presignPut("artifacts/data.json", 60_000);
      const blobPutUrl = `${brokerBaseUrl}/blob?u=${encodeURIComponent(memPutUrl)}`;

      await transport.putBytes(blobPutUrl, { hello: "world" });

      const memGetUrl = await os.presignGet("artifacts/data.json", 60_000);
      const blobGetUrl = `${brokerBaseUrl}/blob?u=${encodeURIComponent(memGetUrl)}`;

      const result = await transport.getBytes(blobGetUrl);

      expect(result).toEqual({ hello: "world" });
    },
  );
});
