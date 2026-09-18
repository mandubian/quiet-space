import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import { createApp } from "../server/app.js";
import { createClassifier } from "../server/classifier.js";
import type { ScanRequest } from "../shared/protocol.js";
import { validateResult } from "../shared/validation.js";

const payload: ScanRequest = {
  page: { host: "example.test", title: "Daily news" },
  blocks: [
    { id: "block-0", text: "Sponsored: Try our travel insurance", tag: "aside", label: "Sponsored", hints: "sponsor-card", context: "Travel news", linkHosts: ["advertiser.test"], imageHosts: [], imageAlts: [] },
    { id: "block-1", text: "The city opened a new public park", tag: "article", label: "", hints: "news-card", context: "Local news", linkHosts: [], imageHosts: [], imageAlts: [] },
  ],
};
const extensionId = "a".repeat(32);
const headers = { Origin: `chrome-extension://${extensionId}`, Authorization: "Bearer test-pairing-token", "Content-Type": "application/json" };

async function withApp(transport: Fetch, run: (url: string) => Promise<void>) {
  const client = new TypeSafeClient({ apiKey: "test-api-key", fetch: transport, logLevel: "off", retry: { maxRetries: 0 } });
  const server = createApp({ extensionId, token: "test-pairing-token", classify: createClassifier(client) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/classify`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("HTTP route batches blocks into one real SDK request and maps Noul answers", async () => {
  let calls = 0;
  await withApp(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-api-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(body.state, payload);
    assert.equal(Object.keys(body.questions).length, 2);
    assert.equal(body.questions.ad_0.type, "noul");
    assert.match(body.questions.ad_1.instructions, /blocks\[1\]/);
    return Response.json({ model: "jev-latest", answers: { ad_0: { type: "noul", noul: 0.99 }, ad_1: { type: "noul", noul: 0.03 } }, usage: { input_tokens: 300, output_tokens: 30 } });
  }, async (url) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.deepEqual(validateResult(await response.json(), payload), { decisions: [{ id: "block-0", probability: 0.99 }, { id: "block-1", probability: 0.03 }] });
    assert.equal(calls, 1);
  });
});

test("invalid origin, token, and payload never reach TypeSafe", async () => {
  await withApp(async () => { throw new Error("Must not call upstream"); }, async (url) => {
    for (const [changed, status] of [[{ ...headers, Origin: "https://example.test" }, 403], [{ ...headers, Authorization: "Bearer wrong" }, 401]] as const) {
      const response = await fetch(url, { method: "POST", headers: changed, body: JSON.stringify(payload) });
      assert.equal(response.status, status);
    }
    const invalid = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...payload, blocks: [] }) });
    assert.equal(invalid.status, 400);
    const duplicate = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...payload, blocks: [payload.blocks[0], payload.blocks[0]] }) });
    assert.equal(duplicate.status, 400);
    const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: headers.Origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), headers.Origin);
  });
});

test("upstream errors and missing answers fail closed without exposing API details", async () => {
  for (const response of [Response.json({ error: "secret-api-detail" }, { status: 401 }), Response.json({ model: "jev-latest", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } })]) {
    await withApp(async () => response, async (url) => {
      const result = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      assert.equal(result.status, 502);
      assert.doesNotMatch(await result.text(), /secret-api-detail|test-api-key/);
    });
  }
});
