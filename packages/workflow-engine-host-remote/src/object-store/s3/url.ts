import type { S3PresignerConfig } from "./s3-presigner.js";

export function buildObjectUrl(cfg: S3PresignerConfig, key: string): string {
  const pathStyle = cfg.pathStyle !== false;
  const base = cfg.endpoint.replace(/\/$/, "");
  return pathStyle
    ? `${base}/${cfg.bucket}/${key}`
    : `${base.replace("://", `://${cfg.bucket}.`)}/${key}`;
}
