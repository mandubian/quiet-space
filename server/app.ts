import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ScanRequest, ScanResult } from "../shared/protocol.js";
import { validateRequest, validateResult } from "../shared/validation.js";

interface AppOptions {
  extensionId: string;
  token: string;
  classify: (request: ScanRequest) => Promise<ScanResult>;
}

export function createApp(options: AppOptions) {
  let busy = false;
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const origin = `chrome-extension://${options.extensionId}`;
    const reject = (status: number, error: string) => response.writeHead(status).end(JSON.stringify({ error }));
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "") || request.headers.origin !== origin) {
      console.warn(`Rejected origin: ${request.headers.origin ?? "(none)"} (expected chrome-extension://${options.extensionId})`);
      reject(403, `Extension origin not allowed${request.headers.origin ? ` (got ${request.headers.origin})` : ""}`);
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS" && request.url === "/classify") {
      response.setHeader("Access-Control-Allow-Methods", "POST");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/classify") {
      reject(404, "Not found");
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reject(401, "Check the local pairing token");
      return;
    }
    if (request.headers["content-type"] !== "application/json") {
      reject(415, "Expected application/json");
      return;
    }
    if (busy) {
      reject(429, "A scan is already running; try again shortly");
      return;
    }
    busy = true;
    let payload: ScanRequest;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 80000) {
          reject(413, "Request too large");
          busy = false;
          return;
        }
        chunks.push(chunk);
      }
      payload = validateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      busy = false;
      reject(400, "Invalid scan payload");
      return;
    }
    try {
      const result = validateResult(await options.classify(payload), payload);
      response.end(JSON.stringify(result));
    } catch {
      reject(502, "Jev request failed or timed out. Check the server API key, quota, and connection; page content was left unchanged.");
    } finally {
      busy = false;
    }
  });
}
