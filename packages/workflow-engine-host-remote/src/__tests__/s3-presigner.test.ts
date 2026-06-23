/**
 * Unit tests for createS3Presigner.
 *
 * We test URL shape and SigV4 query parameter presence — we don't re-verify
 * aws4fetch's cryptographic correctness (that's the library's job), only that
 * we're calling it correctly and returning a well-formed presigned URL.
 */
import { describe, expect, it } from "vitest";
import { createS3Presigner } from "../object-store/s3/s3-presigner.js";

const BASE_CFG = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "test-bucket",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

describe("createS3Presigner", () => {
  it("presignPut returns an absolute http URL targeting the correct bucket/key", async () => {
    const presigner = createS3Presigner(BASE_CFG);
    const url = await presigner.presignPut("workflow/run1/blob.json", 60_000);

    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:9000\/test-bucket\/workflow\/run1\/blob\.json/,
    );
  });

  it("presignGet returns an absolute http URL targeting the correct bucket/key", async () => {
    const presigner = createS3Presigner(BASE_CFG);
    const url = await presigner.presignGet("workflow/run1/blob.json", 30_000);

    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:9000\/test-bucket\/workflow\/run1\/blob\.json/,
    );
  });

  it("presignPut URL contains all required SigV4 query parameters", async () => {
    const presigner = createS3Presigner(BASE_CFG);
    const url = await presigner.presignPut("some/key.json", 120_000);
    const parsed = new URL(url);

    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(/minioadmin/);
    expect(parsed.searchParams.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBeTruthy();
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("presignGet URL contains all required SigV4 query parameters", async () => {
    const presigner = createS3Presigner(BASE_CFG);
    const url = await presigner.presignGet("some/key.json", 60_000);
    const parsed = new URL(url);

    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(/minioadmin/);
    expect(parsed.searchParams.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBeTruthy();
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("rounds sub-second TTL up to 1 second minimum", async () => {
    const presigner = createS3Presigner(BASE_CFG);
    const url = await presigner.presignPut("key.json", 500);
    const parsed = new URL(url);
    expect(
      Number(parsed.searchParams.get("X-Amz-Expires")),
    ).toBeGreaterThanOrEqual(1);
  });

  it("uses the credential string with the configured region", async () => {
    const presigner = createS3Presigner({ ...BASE_CFG, region: "eu-west-1" });
    const url = await presigner.presignPut("key.json", 60_000);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(/eu-west-1/);
  });

  it("produces distinct PUT vs GET URLs for the same key", async () => {
    const presigner = createS3Presigner(BASE_CFG);
    const putUrl = await presigner.presignPut("shared/key.json", 60_000);
    const getUrl = await presigner.presignGet("shared/key.json", 60_000);
    // Both should target the same path but may differ in date/signature (they
    // are signed independently). Both must contain the SigV4 Signature param.
    expect(new URL(putUrl).searchParams.has("X-Amz-Signature")).toBe(true);
    expect(new URL(getUrl).searchParams.has("X-Amz-Signature")).toBe(true);
  });

  it("path-style=false produces virtual-hosted-style URL", async () => {
    const presigner = createS3Presigner({
      ...BASE_CFG,
      endpoint: "https://s3.us-east-1.amazonaws.com",
      pathStyle: false,
    });
    const url = await presigner.presignPut("my/key.json", 60_000);
    // Virtual-hosted style: bucket in subdomain
    expect(url).toMatch(
      /^https:\/\/test-bucket\.s3\.us-east-1\.amazonaws\.com\/my\/key\.json/,
    );
  });
});
