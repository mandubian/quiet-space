import { randomBytes } from "node:crypto";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createApp } from "./app.js";
import { createClassifier } from "./classifier.js";

const extensionId = process.env.ALLOWED_EXTENSION_ID;
if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) throw new Error("Set ALLOWED_EXTENSION_ID to the ID from chrome://extensions.");
if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY in your environment or .env file.");
const token = randomBytes(32).toString("hex");
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseURL: "https://api.typesafe.ai",
  timeout: 15000,
  retry: { maxRetries: 0 },
  logLevel: "off",
  fetch: async (url, init) => {
    const started = performance.now();
    console.log("[TypeSafe] Sending API request");
    try {
      const response = await fetch(url, init);
      console.log(`[TypeSafe] HTTP ${response.status} in ${Math.round(performance.now() - started)} ms`);
      return response;
    } catch {
      console.error("[TypeSafe] API request failed before receiving HTTP headers");
      throw new Error("TypeSafe transport failed");
    }
  },
});
const server = createApp({ extensionId, token, classify: createClassifier(client) });
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.listen(4317, "127.0.0.1", () => {
  console.log("Jev Neutral listening on http://127.0.0.1:4317");
  console.log(`Local pairing token (paste into extension): ${token}`);
});
