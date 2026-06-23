import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "../object-store.js";

describe("InMemoryObjectStore", () => {
  it("round-trips bytes via a presigned put url and reads them back as a BlobStore", async () => {
    const os = new InMemoryObjectStore();
    const putUrl = await os.presignPut(
      "remote-activity/r1/s/t/audio.bin",
      60_000,
    );
    await os.putViaUrl(putUrl, { bytes: 123 });
    expect(await os.get("remote-activity/r1/s/t/audio.bin")).toEqual({
      bytes: 123,
    });
  });

  it("rejects an expired url", async () => {
    let t = 0;
    const os = new InMemoryObjectStore({ now: () => new Date(t) });
    const putUrl = await os.presignPut("k", 1_000);
    t = 2_000;
    await expect(os.putViaUrl(putUrl, 1)).rejects.toThrow(/expired/);
  });

  it("rejects using a get url for put", async () => {
    const os = new InMemoryObjectStore();
    const getUrl = await os.presignGet("k", 1_000);
    await expect(os.putViaUrl(getUrl, 1)).rejects.toThrow(/invalid/);
  });
});
