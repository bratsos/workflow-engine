import type { BlobStore } from "@bratsos/workflow-engine/kernel";
import { AwsClient } from "aws4fetch";
import type { S3PresignerConfig } from "./s3-presigner.js";
import { buildObjectUrl } from "./url.js";

function buildListUrl(
  cfg: S3PresignerConfig,
  prefix: string,
  continuationToken?: string,
): string {
  const pathStyle = cfg.pathStyle !== false;
  const base = cfg.endpoint.replace(/\/$/, "");
  const bucketUrl = pathStyle
    ? `${base}/${cfg.bucket}`
    : base.replace("://", `://${cfg.bucket}.`);
  let url = `${bucketUrl}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  if (continuationToken !== undefined) {
    url += `&continuation-token=${encodeURIComponent(continuationToken)}`;
  }
  return url;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    );
}

function parseListKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    keys.push(decodeXmlEntities(m[1]));
  }
  return keys;
}

export function createS3BlobStore(cfg: S3PresignerConfig): BlobStore {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    sessionToken: cfg.sessionToken,
    region: cfg.region,
    service: "s3",
  });

  return {
    async put(key: string, data: unknown): Promise<void> {
      const url = buildObjectUrl(cfg, key);
      const body = JSON.stringify(data);
      const res = await client.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        throw new Error(
          `S3 PUT ${key} failed: ${res.status} ${res.statusText}`,
        );
      }
    },

    async get(key: string): Promise<unknown> {
      const url = buildObjectUrl(cfg, key);
      const res = await client.fetch(url, { method: "GET" });
      if (res.status === 404) return undefined;
      if (!res.ok) {
        throw new Error(
          `S3 GET ${key} failed: ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as unknown;
    },

    async has(key: string): Promise<boolean> {
      const url = buildObjectUrl(cfg, key);
      const res = await client.fetch(url, { method: "HEAD" });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(
          `S3 HEAD ${key} failed: ${res.status} ${res.statusText}`,
        );
      }
      return true;
    },

    async delete(key: string): Promise<void> {
      const url = buildObjectUrl(cfg, key);
      const res = await client.fetch(url, { method: "DELETE" });
      // 204 No Content and 404 are both acceptable for delete
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `S3 DELETE ${key} failed: ${res.status} ${res.statusText}`,
        );
      }
    },

    async list(prefix: string): Promise<string[]> {
      const allKeys: string[] = [];
      let continuationToken: string | undefined;

      do {
        const url = buildListUrl(cfg, prefix, continuationToken);
        const res = await client.fetch(url, { method: "GET" });
        if (!res.ok) {
          throw new Error(
            `S3 LIST prefix=${prefix} failed: ${res.status} ${res.statusText}`,
          );
        }
        const xml = await res.text();
        allKeys.push(...parseListKeys(xml));

        // Check for truncation and extract the continuation token.
        const truncatedMatch = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(
          xml,
        );
        const isTruncated = truncatedMatch?.[1] === "true";

        if (isTruncated) {
          const tokenMatch =
            /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
          continuationToken = tokenMatch?.[1];
          if (!continuationToken) {
            throw new Error(
              `S3 LIST prefix=${prefix}: IsTruncated=true but no NextContinuationToken`,
            );
          }
        } else {
          continuationToken = undefined;
        }
      } while (continuationToken !== undefined);

      return allKeys;
    },
  };
}
