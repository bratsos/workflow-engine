import { AwsV4Signer } from "aws4fetch";
import type { ObjectStorePresigner } from "../../object-store.js";

export interface S3PresignerConfig {
  /** S3-compatible base URL, e.g. https://s3.us-east-1.amazonaws.com or https://<acct>.r2.cloudflarestorage.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Default true — puts the bucket in the URL path (MinIO/R2/local). Set false for virtual-hosted-style AWS. */
  pathStyle?: boolean;
}

function buildObjectUrl(cfg: S3PresignerConfig, key: string): string {
  const pathStyle = cfg.pathStyle !== false;
  const base = cfg.endpoint.replace(/\/$/, "");
  return pathStyle
    ? `${base}/${cfg.bucket}/${key}`
    : `${base.replace("://", `://${cfg.bucket}.`)}/${key}`;
}

async function presign(
  cfg: S3PresignerConfig,
  key: string,
  method: string,
  ttlMs: number,
): Promise<string> {
  const objectUrl = buildObjectUrl(cfg, key);
  const ttlSeconds = String(Math.max(1, Math.ceil(ttlMs / 1000)));

  // aws4fetch reads X-Amz-Expires from the URL query string (not from request
  // headers) when signQuery=true. Pre-set it so the library picks it up.
  const urlWithExpiry = new URL(objectUrl);
  urlWithExpiry.searchParams.set("X-Amz-Expires", ttlSeconds);

  const signer = new AwsV4Signer({
    method,
    url: urlWithExpiry.toString(),
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    sessionToken: cfg.sessionToken,
    region: cfg.region,
    service: "s3",
    signQuery: true,
  });

  const signed = await signer.sign();
  return signed.url.toString();
}

export function createS3Presigner(
  cfg: S3PresignerConfig,
): ObjectStorePresigner {
  return {
    presignPut(key: string, ttlMs: number): Promise<string> {
      return presign(cfg, key, "PUT", ttlMs);
    },
    presignGet(key: string, ttlMs: number): Promise<string> {
      return presign(cfg, key, "GET", ttlMs);
    },
  };
}
