/**
 * The scanner is what keeps oversized media events usable: it recovers routing
 * metadata from a body that is never buffered in full.
 */
import { describe, expect, it } from "vitest";
import { ScanError, scanTopLevelJson } from "../src/lib/jsonScan";

function streamOf(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
      }
      controller.close();
    },
  });
}

async function scan(text: string, options?: Parameters<typeof scanTopLevelJson>[1]) {
  return await scanTopLevelJson(streamOf(text), options);
}

describe("scanTopLevelJson", () => {
  it("parses a flat object", async () => {
    const result = await scan('{"a":1,"b":"two","c":true,"d":null}');
    expect(result.fields).toEqual({ a: 1, b: "two", c: true, d: null });
    expect(result.skipped).toEqual({});
    expect(result.truncated).toEqual([]);
  });

  it("keeps nested objects and arrays", async () => {
    const result = await scan('{"event":{"Info":{"Chat":"628@s.whatsapp.net","N":1},"List":[1,2,{"x":"}"}]}}');
    expect(result.fields).toEqual({
      event: { Info: { Chat: "628@s.whatsapp.net", N: 1 }, List: [1, 2, { x: "}" }] },
    });
  });

  it("skips base64, reports its exact byte size, and keeps the rest", async () => {
    const base64 = "A".repeat(5000);
    const body = JSON.stringify({ base64, fileName: "IMG.jpg", type: "Message", userID: "1", instanceName: "n-1" });
    const result = await scan(body);
    expect(result.fields).toEqual({ fileName: "IMG.jpg", type: "Message", userID: "1", instanceName: "n-1" });
    // 5000 base64 chars + 2 quotes
    expect(result.skipped["base64"]).toBe(5002);
  });

  it("measures a skipped value in bytes, not characters", async () => {
    const multibyte = "\u00e9".repeat(10); // 2 bytes each in UTF-8
    const body = `{"base64":"${multibyte}","type":"Message"}`;
    const result = await scan(body);
    expect(result.skipped["base64"]).toBe(22);
    expect(result.fields["type"]).toBe("Message");
  });

  it("honours custom skip lists", async () => {
    const result = await scan('{"huge":"0123456789","keep":1}', { skip: ["huge"] });
    expect(result.fields).toEqual({ keep: 1 });
    expect(result.skipped["huge"]).toBe(12);
  });

  it("handles escapes inside strings", async () => {
    const value = 'quote " backslash \\ newline \n tab \t unicode \u00e9 brace } bracket ]';
    const body = JSON.stringify({ base64: "skip-me", text: value, nested: { inner: "a\\\"b" } });
    const result = await scan(body);
    expect(result.fields["text"]).toBe(value);
    expect(result.fields["nested"]).toEqual({ inner: 'a\\"b' });
  });

  it("drops fields that exceed maxFieldBytes", async () => {
    const body = JSON.stringify({ big: "x".repeat(100), small: "y" });
    const result = await scan(body, { maxFieldBytes: 20 });
    expect(result.fields).toEqual({ small: "y" });
    expect(result.truncated).toEqual(["big"]);
  });

  it("does not apply the field budget to skipped fields", async () => {
    const body = JSON.stringify({ base64: "z".repeat(1000), keep: "ok" });
    const result = await scan(body, { maxFieldBytes: 10 });
    expect(result.fields).toEqual({ keep: "ok" });
    expect(result.skipped["base64"]).toBe(1002);
    expect(result.truncated).toEqual([]);
  });

  it("reads very long skipped values without buffering them", async () => {
    const base64 = "Q".repeat(3_000_000);
    const body = `{"base64":"${base64}","type":"Message"}`;
    const result = await scan(body, { skip: ["base64"] });
    expect(result.skipped["base64"]).toBe(base64.length + 2);
    expect(result.fields["type"]).toBe("Message");
  });

  it("parses escaped field names the way JSON does", async () => {
    // "ty\u0070e" is "type"; an escaped key must still match the skip list, and
    // "bas\u006564" must be recognised as the skipped "base64".
    const result = await scan('{"bas\\u006564":"payload","ty\\u0070e":"Message"}');
    expect(result.fields).toEqual({ type: "Message" });
    expect(result.skipped["base64"]).toBe(9);
  });

  it("tolerates whitespace and newlines", async () => {
    const result = await scan('{\n  "a" : 1 ,\n\t"b"\t:\t[ ]\n}');
    expect(result.fields).toEqual({ a: 1, b: [] });
  });

  it("accepts an empty object and trailing whitespace", async () => {
    expect((await scan("{}")).fields).toEqual({});
    expect((await scan('{"a":1}  \n')).fields).toEqual({ a: 1 });
  });

  it("rejects non-objects, truncated input and trailing data", async () => {
    await expect(scan("[1,2]")).rejects.toBeInstanceOf(ScanError);
    await expect(scan('"just a string"')).rejects.toBeInstanceOf(ScanError);
    await expect(scan('{"a":1')).rejects.toBeInstanceOf(ScanError);
    await expect(scan('{"a":1} extra')).rejects.toBeInstanceOf(ScanError);
    await expect(scan('{"a" 1}')).rejects.toBeInstanceOf(ScanError);
  });

  it("scans a realistic wuzapi media event", async () => {
    const body = JSON.stringify({
      base64: "B".repeat(120_000),
      event: {
        Info: { Chat: "6281234567890@s.whatsapp.net", ID: "3EB0MEDIA", IsFromMe: false, PushName: "Pelanggan" },
        Message: { imageMessage: { mimetype: "image/jpeg", fileLength: 90_000 } },
      },
      fileName: "IMG-0001.jpg",
      instanceName: "nomor-1",
      mimeType: "image/jpeg",
      type: "Message",
      userID: "1",
    });
    const result = await scan(body);
    expect(result.fields["type"]).toBe("Message");
    expect(result.fields["userID"]).toBe("1");
    expect(result.fields["instanceName"]).toBe("nomor-1");
    expect(result.skipped["base64"]).toBe(120_002);
    const info = (result.fields["event"] as { Info: { Chat: string } }).Info;
    expect(info.Chat).toBe("6281234567890@s.whatsapp.net");
  });
});
