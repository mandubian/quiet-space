import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import puppeteer, { type Page } from "puppeteer";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import { createApp } from "../server/app.js";
import { createClassifier } from "../server/classifier.js";
import { collect, describe, replace } from "../extension/dom.js";
import { collectWithFrames } from "../extension/frame.js";
import { FIXTURE, IMAGE_AD, WRAPPED_IMAGE_AD, startFixtureServer } from "./fixture.js";
import { JSDOM } from "jsdom";

function jsdomLayout(window: JSDOM["window"]) {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 400, height: 120, top: 10, bottom: 130, left: 0, right: 400, x: 0, y: 10, toJSON: () => ({}) } as DOMRect;
  };
}

async function withServer(transport: Fetch) {
  const client = new TypeSafeClient({ apiKey: "test-api-key", fetch: transport, logLevel: "off", retry: { maxRetries: 0 } });
  const { key } = JSON.parse(await readFile(new URL("../extension/key.json", import.meta.url), "utf8"));
  const extensionId = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  const server = createApp({ extensionId, token: "test-pairing-token", classify: createClassifier(client) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { port: (server.address() as AddressInfo).port, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

test("jsdom extraction picks the sponsored card and not the article or nav", () => {
  const window = new JSDOM(FIXTURE).window;
  const document = window.document;
  jsdomLayout(window);
  const { request, candidates } = collect(document);
  const promoted = candidates.find((candidate) => candidate.node.id === "promo");
  assert.ok(promoted, "sponsored card should be a candidate");
  assert.match(promoted.block.text, /50% off/);
  assert.deepEqual(promoted.block.linkHosts, ["ads.example.test"]);
  assert.deepEqual(promoted.block.imageAlts, ["special offer banner"]);
  const texts = request.blocks.map((block) => block.text);
  assert.ok(!texts.some((text) => text.includes("council approved")), "article body must not be scanned");
  assert.ok(!texts.some((text) => text.includes("Sections")), "nav must not be scanned");
  const promo = candidates.find((candidate) => candidate.block.text.includes("50% off"));
  if (promo) {
    const restore = replace(promo, 0.99);
    assert.ok(restore);
    assert.equal(document.querySelectorAll("[data-jev-neutral]").length, 1);
    restore();
    assert.equal(document.querySelectorAll("[data-jev-neutral]").length, 0);
    assert.ok(document.getElementById("promo"), "original node is preserved");
  }
});

test("labelled L’Équipe iframe slot survives the general walk cap as one whole container", () => {
  const window = new JSDOM(`<body>${"<span>news</span>".repeat(2600)}${IMAGE_AD}</body>`).window;
  jsdomLayout(window);
  const { candidates, request } = collect(window.document);
  const ad = window.document.querySelector<HTMLElement>(".AmPlaceholder__skeleton")!;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].node, ad);
  assert.match(request.blocks[0].text, /publicité/i);
  assert.match(request.blocks[0].label, /Publicité/);
  assert.match(request.blocks[0].hints, /data-adunitpath/);
  assert.doesNotMatch(JSON.stringify(request), /fixture-query|366560878|google_ads_iframe_fixture/);
  const restore = replace(candidates[0], 0.99)!;
  assert.equal(ad.isConnected, false);
  restore();
  assert.equal(ad.isConnected, true);
  window.close();
});

test("970x250 SLOT-2 is selected outside the viewport while ordinary cards stay local", () => {
  const slot = IMAGE_AD.replaceAll("SLOT-1", "SLOT-2").replaceAll("slot-1", "slot-2").replaceAll("300px", "970px");
  const window = new JSDOM(`<body>${slot}<article><a href="https://example.test">Ordinary news card</a></article></body>`).window;
  jsdomLayout(window);
  for (const top of [-1000, 4000]) {
    window.Element.prototype.getBoundingClientRect = function () {
      return { width: 970, height: 250, top, bottom: top + 250, left: 0, right: 970, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    const { candidates } = collect(window.document);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].node, window.document.querySelector(".AmPlaceholder__skeleton"));
  }
  const wrapper = window.document.querySelector<HTMLElement>(".AmPlaceholder__skeleton")!;
  wrapper.style.display = "none";
  assert.equal(collect(window.document).candidates.length, 0);
  window.close();
});

test("rendered 728x90 wrapper is extracted once with its iframe label", () => {
  const window = new JSDOM(`<body><main><p>Sports news</p>${WRAPPED_IMAGE_AD}</main></body>`).window;
  jsdomLayout(window);
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 728, height: 90, top: 100, bottom: 190, left: 0, right: 728, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
  };
  const { candidates } = collect(window.document);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].node, window.document.querySelector(".AmPlaceholder__skeleton"));
  assert.match(candidates[0].block.label, /Publicité/);
  assert.match(candidates[0].block.hints, /data-adunitpath present/);
  window.close();
});

test("SLOT-8 fluid ad is collected on incremental scans even with a full handled budget", () => {
  const window = new JSDOM(`<body><main><p>Sports news</p></main></body>`).window;
  jsdomLayout(window);
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1240, height: 158, top: 300, bottom: 458, left: 0, right: 1240, x: 0, y: 300, toJSON: () => ({}) } as DOMRect;
  };
  const document = window.document;
  const main = document.querySelector("main")!;
  for (let index = 0; index < 33; index++) {
    const slot = document.createElement("div");
    slot.className = "AmPlaceholder__skeleton";
    slot.innerHTML = `<div class="AmPlaceholder__skeletonSubtitle">publicité</div><iframe title="Contenu d'annonce tiers" aria-label="Publicité" data-slot="${index}"></iframe>`;
    main.appendChild(slot);
  }
  const first = collect(document);
  assert.equal(first.candidates.length, 32, "budget caps at 32");
  const belowThreshold = new Set(first.candidates.map((candidate) => candidate.snapshot));
  assert.equal(collect(document, { incremental: true, skipSignatures: belowThreshold }).candidates.length, 0, "unchanged below-threshold slots are skipped on incremental scans");
  main.insertAdjacentHTML("beforeend", WRAPPED_IMAGE_AD.replaceAll("SLOT-2", "SLOT-8").replaceAll("slot-2", "slot-8").replaceAll("width:728px;height:90px", "width:100%;height:auto").replace('width="728" height="90"', 'width="100%" height="158"'));
  const second = collect(document, { incremental: true, skipSignatures: belowThreshold });
  assert.equal(second.candidates.length, 1, "a re-rendered ad must not be suppressed by below-threshold slots");
  assert.equal(second.candidates[0].node.querySelector("[data-ad-position]")?.getAttribute("data-ad-position"), "SLOT-8");
  assert.equal(collect(document, { skipSignatures: belowThreshold }).candidates.length >= 1, true, "full scans ignore the skip set");
  window.close();
});

test("full-page network-hosted skin is shortlisted, described by hosts, and capped in height", () => {
  const window = new JSDOM(`<body>${"<span>news</span>".repeat(2600)}<a id="skin" href="https://adclick.g.doubleclick.net/pcs/click?xai=1&amp;adurl=https://ad.doubleclick.net/ddm/trackclk/N7657;gdpr=1" style="height:8488px"><img class="imageSkin" src="https://tpc.googlesyndication.com/simgad/6709157004231374402?"></a></body>`).window;
  jsdomLayout(window);
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1900, height: 8488, top: 0, bottom: 8488, left: 0, right: 1900, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const { candidates, request, diagnostics } = collect(window.document);
  assert.equal(diagnostics.inspected, 2500, "generic walk must hit its cap in this fixture");
  assert.equal(candidates.length, 1, "skin must still be shortlisted despite the walk cap");
  assert.equal(candidates[0].node.id, "skin");
  assert.ok(request.blocks[0].linkHosts.includes("adclick.g.doubleclick.net"));
  assert.ok(request.blocks[0].imageHosts?.includes("tpc.googlesyndication.com"));
  assert.doesNotMatch(JSON.stringify(request), /adurl|gdpr|xai|simgad\/\d+/);
  const restore = replace(candidates[0], 0.99)!;
  const placeholder = window.document.querySelector<HTMLElement>("[data-jev-neutral]")!;
  assert.equal(placeholder.style.height, "900px", "placeholder must not replicate the 8488px skin height");
  restore();
  assert.equal(window.document.getElementById("skin")?.tagName, "A");
  window.close();
});

test("ad-host iframes are shortlisted by container and same-origin frame content is judged", async () => {
  const window = new JSDOM(`<body><main><p>News</p><iframe src="https://tpc.googlesyndication.com/simgad/x"></iframe></main></body>`).window;
  jsdomLayout(window);
  const { candidates } = collect(window.document);
  const container = candidates.find((candidate) => candidate.node.tagName === "IFRAME" || candidate.node.querySelector("iframe"));
  assert.ok(container, "label-less ad-host iframe container must be shortlisted");
  assert.match(JSON.stringify(container.block.hints), /frame-host tpc\.googlesyndication\.com/);
  window.close();

  const frameWindow = new JSDOM(`<body><div id="frame-ad" class="AmPlaceholder__skeleton"><div class="AmPlaceholder__skeletonSubtitle">publicité</div><iframe title="Contenu d'annonce tiers" aria-label="Publicité"></iframe></div></body>`).window;
  jsdomLayout(frameWindow);
  const topWindow = new JSDOM(`<body><main><p>Article text stays visible</p><iframe></iframe></main></body>`).window;
  jsdomLayout(topWindow);
  const frame = topWindow.document.querySelector("iframe")!;
  frameWindow.document.querySelectorAll<HTMLElement>("[data-jev-neutral], #frame-ad").forEach(() => undefined);
  Object.defineProperty(frame, "contentDocument", { value: frameWindow.document, configurable: true });
  Object.defineProperty(frame, "contentWindow", { value: frameWindow, configurable: true });
  const merged = collectWithFrames(topWindow.document, { framesOverride: [frameWindow] });
  const frameCandidate = merged.candidates.find((candidate) => candidate.block.id.startsWith("f0-"));
  assert.ok(frameCandidate, "same-origin frame content must be collected");
  assert.match(frameCandidate.block.text, /publicité/i);
  const restore = replace(frameCandidate, 0.99)!;
  assert.equal(frameWindow.document.querySelectorAll("[data-jev-neutral]").length, 1);
  restore();
  assert.ok(frameWindow.document.getElementById("frame-ad"));
  topWindow.close();
  frameWindow.close();
});

test("unlabelled frames and sensitive ad containers are not selected", () => {
  const window = new JSDOM(`<body><div><iframe title="Sports highlights"></iframe></div><form>${IMAGE_AD}</form></body>`).window;
  jsdomLayout(window);
  assert.equal(collect(window.document).candidates.length, 0);
  window.close();
});

test("describe never leaks query strings or full URLs", () => {
  const document = new JSDOM(FIXTURE).window.document;
  const { block } = describe(document.querySelector("aside")!);
  assert.deepEqual(block.linkHosts, ["ads.example.test"]);
  assert.ok(!JSON.stringify(block).includes("utm"));
  assert.ok(!JSON.stringify(block).includes("deal"));
});

test("replacement respects the freshness snapshot", () => {
  const window = new JSDOM(FIXTURE).window;
  const document = window.document;
  jsdomLayout(window);
  const { candidates } = collect(document);
  const promo = candidates.find((candidate) => candidate.node.id === "promo")!;
  promo.node.querySelector("a")!.href = "https://ads.example.test/changed";
  const stale = replace(promo, 0.99);
  assert.equal(stale, undefined, "changed node must not be replaced");
});

test("site-auto mode filters new tabs with no popup interaction and stops when unlocked", { timeout: 120000 }, async () => {
  let upstreamCalls = 0;
  const { close, port } = await withServer(async (url, init) => {
    upstreamCalls++;
    const body = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.97 }]));
    return Response.json({ model: "jev-latest", answers, usage: { input_tokens: 300, output_tokens: 30 } });
  });
  const fixture = startFixtureServer(FIXTURE);
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${join(import.meta.dirname, "../dist/extension")}`, `--load-extension=${join(import.meta.dirname, "../dist/extension")}`] });
  try {
    const bootstrap = await browser.newPage();
    await bootstrap.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker", { timeout: 15000 });
    const worker = (await workerTarget.worker())!;
    await worker.evaluate((backendPort) => chrome.storage.local.set({ token: "test-pairing-token", backendPort, threshold: 0.95, autoSites: { "127.0.0.1": true } }), port);
    const pagePromise = new Promise<Page>((resolve) => browser.once("targetcreated", async (target) => resolve((await target.page()) as Page)));
    await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), fixtureUrl);
    const autoPage = await pagePromise;
    await autoPage.waitForSelector("[data-jev-neutral]", { timeout: 30000 });
    assert.equal(upstreamCalls, 1, "page load must trigger exactly one automatic scan");
    const label = await autoPage.$eval("[data-jev-neutral] >>> span", (node) => node.textContent);
    assert.match(label ?? "", /97% ad probability/);
    let summary: { replaced?: number; decisions?: { outcome: string }[] } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const all = await worker.evaluate(() => chrome.storage.session.get(null)) as Record<string, { replaced?: number; decisions?: { outcome: string }[] }>;
      const entry = Object.entries(all).find(([key, value]) => key.startsWith("scan:") && typeof value?.replaced === "number");
      if (entry) { summary = entry[1]; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(summary, "auto-scan summary must be recorded for the popup to show");
    assert.equal(summary!.replaced, 1);
    assert.match(summary!.decisions?.[0]?.outcome ?? "", /replaced/);
    await worker.evaluate(() => chrome.storage.local.set({ autoSites: {} }));
    await autoPage.goto(fixtureUrl, { waitUntil: "load" });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.equal(upstreamCalls, 1, "unlocked site must not be scanned again");
    assert.equal(await autoPage.$$eval("[data-jev-neutral]", (nodes) => nodes.length), 0);
  } finally {
    await browser.close();
    fixture.close();
    fixture.closeAllConnections?.();
    await close();
  }
});

test("auto-scan debounces mutations and reclassifies inserted ads", { timeout: 120000 }, async () => {
  let upstreamCalls = 0;
  const { close, port } = await withServer(async (url, init) => {
    upstreamCalls++;
    const body = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.97 }]));
    return Response.json({ model: "jev-latest", answers, usage: { input_tokens: 300, output_tokens: 30 } });
  });
  const fixture = startFixtureServer(FIXTURE);
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${join(import.meta.dirname, "../dist/extension")}`, `--load-extension=${join(import.meta.dirname, "../dist/extension")}`] });
  try {
    const page = await browser.newPage();
    await page.goto(fixtureUrl, { waitUntil: "load" });
    page.on("console", (message) => console.log(`[page] ${message.text()}`));
    const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker", { timeout: 15000 });
    const worker = (await workerTarget.worker())!;
    await worker.evaluate((backendPort) => chrome.storage.local.set({ token: "test-pairing-token", backendPort, threshold: 0.95 }), port);
    const [tab] = await worker.evaluate(async () => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
    assert.ok(tab?.id);
    await worker.evaluate(async () => {
      await chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/popup.html`, active: true });
    });
    const extensionTarget = (await browser.waitForTarget((target) => target.url().endsWith("popup.html"), { timeout: 10000 }))!;
    const extensionPage = (await extensionTarget.page()) as Page;
    await extensionPage.bringToFront();
    await extensionPage.waitForSelector("#consent", { timeout: 10000 });
    await extensionPage.click("#consent");
    await extensionPage.evaluate((tabId) => chrome.runtime.sendMessage({ type: "jev-scan", tabId, threshold: 0.95, auto: true }), tab.id);
    assert.equal(upstreamCalls, 1);
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.className = "AmPlaceholder__skeleton";
      div.innerHTML = '<div class="AmPlaceholder__skeletonSubtitle">publicité</div><iframe title="Contenu d\'annonce tiers" aria-label="Publicité"></iframe>';
      document.body.appendChild(div);
    });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(await page.$$eval("[data-jev-neutral]", (nodes) => nodes.length), 2, "inserted ad must be replaced automatically");
    assert.equal(upstreamCalls, 2);
    await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: "jev-auto-off" }), tab.id);
    await page.evaluate(() => document.body.appendChild(document.createElement("div")));
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(upstreamCalls, 2, "auto-scan must stop after disable");
  } finally {
    await browser.close();
    fixture.close();
    fixture.closeAllConnections?.();
    await close();
  }
});

test("end-to-end: Chromium scan replaces the sponsored card and reports latency", { timeout: 120000 }, async () => {
  let upstreamCalls = 0;
  const { close, port } = await withServer(async () => {
    upstreamCalls++;
    return Response.json({
      model: "jev-latest",
      answers: { ad_0: { type: "noul", noul: 0.97 }, ad_1: { type: "noul", noul: 0.97 }, ad_2: { type: "noul", noul: 0.97 }, ad_3: { type: "noul", noul: 0.97 } },
      usage: { input_tokens: 300, output_tokens: 30 },
    });
  });
  const fixture = startFixtureServer(FIXTURE.replace("</main>", `${IMAGE_AD}${WRAPPED_IMAGE_AD}</main>`));
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${join(import.meta.dirname, "../dist/extension")}`, `--load-extension=${join(import.meta.dirname, "../dist/extension")}`] });
  try {
    const page = await browser.newPage();
    await page.goto(fixtureUrl, { waitUntil: "load" });
    page.on("console", (message) => console.log(`[page] ${message.text()}`));
    const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker", { timeout: 15000 });
    const worker = (await workerTarget.worker())!;
    const network = await workerTarget.createCDPSession();
    await network.send("Network.enable");
    network.on("Network.responseReceived", async ({ response, requestId }) => {
      if (!response.url.endsWith("/classify")) return;
      console.log("classifier HTTP", response.status);
      try { console.log("classifier response", await network.send("Network.getResponseBody", { requestId })); } catch { console.log("Response body unavailable"); }
    });
    await worker.evaluate((backendPort) => chrome.storage.local.set({ token: "test-pairing-token", backendPort, threshold: 0.95 }), port);
    const fixtureTab = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
      return tab?.id ?? null;
    });
    assert.ok(fixtureTab !== null, "fixture tab must be visible to chrome.tabs");
    await worker.evaluate(async () => {
      await chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/popup.html`, active: true });
    });
    const extensionTarget = (await browser.waitForTarget((target) => target.url().endsWith("popup.html"), { timeout: 10000 }))!;
    const extensionPage = (await extensionTarget.page()) as Page;
    await extensionPage.bringToFront();
    await extensionPage.waitForSelector("#consent", { timeout: 10000 });
    await extensionPage.click("#consent");
    const scanStarted = Date.now();
    await page.bringToFront();
    await extensionPage.evaluate(() => document.getElementById("scan")!.click());
    await extensionPage.waitForFunction(() => {
      const node = document.getElementById("status");
      return node?.textContent?.includes("block(s) replaced") || node?.className === "error";
    }, { timeout: 30000, polling: 50 });
    const statusText = await extensionPage.$eval("#status", (node) => node.textContent);
    const seconds = (Date.now() - scanStarted) / 1000;
    console.log(`scan round-trip: ${statusText} (${seconds.toFixed(1)}s)`);
    assert.match(statusText ?? "", /^3\/3 block/);
    const details = await extensionPage.$eval("#decisions", (node) => node.textContent);
    assert.match(details ?? "", /SLOT-1: 97.00% — replaced/);
    assert.match(details ?? "", /SLOT-2: 97.00% — replaced/);
    assert.equal(await page.$$eval("[data-jev-neutral]", (nodes) => nodes.length), 3);
    assert.equal(await extensionPage.$eval("#restore", (node) => (node as HTMLButtonElement).disabled), false, "restore must be enabled while placeholders exist");
    await page.waitForSelector("[data-jev-neutral]", { timeout: 20000 });
    const label = await page.$eval("[data-jev-neutral] >>> span", (node) => node.textContent);
    assert.match(label ?? "", /97% ad probability/);
    const stillThere = await page.$eval("article p", (node) => node.textContent);
    assert.match(stillThere ?? "", /council approved/);
    assert.equal(upstreamCalls, 1);
    const shadow = await page.$eval("[data-jev-neutral]", (node) => ({
      hasShadowRoot: Boolean(node.shadowRoot),
      tags: [...(node.shadowRoot?.querySelectorAll("*") ?? [])].map((element) => element.tagName),
      button: node.shadowRoot?.querySelector("button")?.textContent,
    }));
    console.log("Rendered placeholder:", shadow);
    assert.equal(shadow.hasShadowRoot, true);
    assert.equal(shadow.button, "Show original");
    await page.bringToFront();
    for (let index = 0; index < 3; index++) await page.click("[data-jev-neutral] >>> button");
    assert.equal(await page.$("[data-jev-neutral]"), null);
    assert.ok(await page.$("#promo"), "restore brings back the original node");
    assert.equal(await page.$$eval(".AmPlaceholder__skeleton", (nodes) => nodes.length), 2);
    assert.ok(await page.$(".AmPlaceholder.is-rendered iframe"));
  } finally {
    await browser.close();
    fixture.close();
    fixture.closeAllConnections?.();
    await close();
  }
});
