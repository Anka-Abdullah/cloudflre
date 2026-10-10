#!/usr/bin/env node
/**
 * Sends a wuzapi-shaped, HMAC-signed webhook to a worker, so the ingest path can
 * be tested without WhatsApp and without wuzapi (useful against `pnpm run dev`).
 *
 *   pnpm run simulate -- --url http://127.0.0.1:8787/ingest/<token> --key <hmac key> --format json
 *   pnpm run simulate -- --url ... --key ... --format form
 *   pnpm run simulate -- --url ... --key ... --format media --media-bytes 150000
 *   pnpm run simulate -- --url ... --key ... --format json --count 5
 *
 * The signature is computed with node:crypto over the exact bytes that are sent,
 * which is also what the worker does when it verifies.
 */
import { createHmac } from "node:crypto";

function parseArgs(argv) {
  const options = {
    url: null,
    key: null,
    format: "json",
    count: 1,
    mediaBytes: 120_000,
    event: "Message",
    userID: "1",
    instanceName: "nomor-1",
    token: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--url":
        options.url = next();
        break;
      case "--key":
        options.key = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--format":
        options.format = next();
        break;
      case "--count":
        options.count = Number(next());
        break;
      case "--media-bytes":
        options.mediaBytes = Number(next());
        break;
      case "--event":
        options.event = next();
        break;
      case "--user-id":
        options.userID = next();
        break;
      case "--instance-name":
        options.instanceName = next();
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: pnpm run simulate -- --url <ingest url> --key <hmac key> [--format json|form|media] [--count n] [--media-bytes n]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  if (!options.url) throw new Error("--url is required");
  if (!options.format || !["json", "form", "media"].includes(options.format)) {
    throw new Error("--format must be json, form or media");
  }
  return options;
}

/** Mirrors the event shape wuzapi forwards (postmap with type + event). */
function buildEvent(options, index) {
  const messageID = `3EB0SIM${String(index).padStart(4, "0")}`;
  return {
    type: options.event,
    event: {
      Info: {
        Chat: "6281234567890@s.whatsapp.net",
        ID: messageID,
        IsFromMe: false,
        PushName: "Simulator",
        Timestamp: new Date().toISOString(),
      },
      Message: { conversation: `Halo <admin> & tes #${index} \u2014 dari simulate-webhook.mjs` },
    },
    userID: options.userID,
    instanceName: options.instanceName,
  };
}

function buildMediaEvent(options, index) {
  const base64 = Buffer.alloc(options.mediaBytes, index + 1).toString("base64");
  return {
    base64,
    fileName: `SIM-${index}.jpg`,
    mimeType: "image/jpeg",
    type: options.event,
    event: {
      Info: { Chat: "6281234567890@s.whatsapp.net", ID: `3EB0SIM${index}`, IsFromMe: false },
      Message: { imageMessage: { mimetype: "image/jpeg" } },
    },
    userID: options.userID,
    instanceName: options.instanceName,
  };
}

function sign(key, body) {
  return createHmac("sha256", key).update(body).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = options.token ? options.url.replace(/\/ingest\/[^/]+$/, `/ingest/${options.token}`) : options.url;

  for (let index = 1; index <= options.count; index++) {
    const media = options.format === "media";
    const payload = media ? buildMediaEvent(options, index) : buildEvent(options, index);

    let body;
    let contentType;
    if (options.format === "form" || media) {
      // wuzapi signs url.Values.Encode(); URLSearchParams produces the same
      // encoding for these values, so the signature covers the sent body.
      const params = new URLSearchParams({
        jsonData: JSON.stringify(payload),
        userID: options.userID,
        instanceName: options.instanceName,
      });
      body = params.toString();
      contentType = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(payload);
      contentType = "application/json";
    }

    const headers = {
      "content-type": contentType,
      "user-agent": "wuzapi-simulator/1.0",
      "x-wuzapi-simulated": "true",
    };
    if (options.key) headers["x-hmac-signature"] = sign(options.key, body);

    const response = await fetch(url, { method: "POST", headers, body });
    const text = await response.text();
    console.log(
      `#${index} ${options.format.padEnd(5)} ${body.length.toString().padStart(7)} bytes -> ${response.status} ${text}`,
    );
    if (!response.ok && response.status !== 413) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
