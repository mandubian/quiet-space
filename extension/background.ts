import { BACKEND_URL, type ScanRequest } from "../shared/protocol.js";
import { buildJevRequestBody, mapJevResponse } from "../shared/jev.js";
import { matchingSiteKey } from "../shared/site.js";
import { validateRequest, validateResult } from "../shared/validation.js";

declare const self: typeof globalThis & { __jevAuthorizedTabs?: Set<number> };

let scanning = false;

self.chrome.runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
  if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  if (type === "jev-classify" && sender.tab?.id !== undefined && self.__jevAuthorizedTabs?.has(sender.tab.id)) {
    handleClassify((message as { request: ScanRequest }).request, sendResponse);
    return true;
  }
  if (type === "jev-scan" && sender.url === chrome.runtime.getURL("popup.html")) {
    handleScan(Number((message as { tabId?: unknown }).tabId), Number((message as { threshold?: unknown }).threshold), (message as { auto?: unknown }).auto === true, sendResponse);
    return true;
  }
  if (type === "jev-auto-update" && sender.tab?.id !== undefined) {
    const replaced = Number((message as { replaced?: unknown }).replaced) || 0;
    self.chrome.action.setBadgeText({ text: replaced > 0 ? `+${replaced}` : "" });
    if (replaced > 0) setTimeout(() => self.chrome.action.setBadgeText({ text: "" }), 5000);
    return false;
  }
  if (type === "jev-scan-record" && sender.tab?.id !== undefined && typeof message === "object" && "summary" in message) {
    const summary = (message as { summary: Record<string, unknown> }).summary;
    void self.chrome.storage.session.set({ [`scan:${sender.tab.id}`]: summary });
    if (summary.incremental === true) {
      const replaced = Number(summary.replaced) || 0;
      self.chrome.action.setBadgeText({ text: replaced > 0 ? `+${replaced}` : "" });
      if (replaced > 0) setTimeout(() => self.chrome.action.setBadgeText({ text: "" }), 5000);
    }
    return false;
  }
  if (type === "jev-reading" && sender.url === chrome.runtime.getURL("popup.html")) {
    handleReading(Number((message as { tabId?: unknown }).tabId), sendResponse);
    return true;
  }
  if (type === "jev-auto-check" && sender.tab?.id !== undefined && sender.tab.id !== undefined) {
    void autoStateForTab(sender.tab.id).then((state) => {
      if (state.enabled) self.__jevAuthorizedTabs?.add(sender.tab!.id!);
      sendResponse(state);
    });
    return true;
  }
  return false;
});

self.chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void self.chrome.storage.session.remove(`scan:${tabId}`);
  if (changeInfo.status !== "loading") return;
  void injectForAutoScan(tabId);
});

async function injectForAutoScan(tabId: number) {
  try {
    const state = await autoStateForTab(tabId);
    if (!state.enabled) return;
    (self.__jevAuthorizedTabs ??= new Set<number>()).add(tabId);
    await self.chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"], injectImmediately: true });
  } catch { /* navigation aborted or frame not ready */ }
}

async function autoStateForTab(tabId: number): Promise<{ enabled: boolean; threshold: number }> {
  const tab = await self.chrome.tabs.get(tabId);
  const url = tab.url ? new URL(tab.url) : undefined;
  const host = url?.hostname ?? "";
  if (!host || !/^https?:$/.test(url!.protocol)) return { enabled: false, threshold: 0.95 };
  const { autoSites, threshold } = await self.chrome.storage.local.get(["autoSites", "threshold"]);
  const sites = (autoSites && typeof autoSites === "object") ? autoSites as Record<string, unknown> : {};
  const key = matchingSiteKey(host, sites);
  if (!key) return { enabled: false, threshold: 0.95 };
  const schemePattern = `${url!.protocol}//${host}/*`;
  const granted = await self.chrome.permissions.contains({ origins: [schemePattern] })
    || await self.chrome.permissions.contains({ origins: [`*://${host}/*`] })
    || await self.chrome.permissions.contains({ origins: [`*://*.${key}/*`] });
  return { enabled: granted, threshold: typeof threshold === "number" ? threshold : 0.95 };
}

async function handleScan(tabId: number, threshold: number, auto: boolean, sendResponse: (response: unknown) => void) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ error: "Open an http(s) page and try again" });
    return;
  }
  if (scanning) {
    sendResponse({ error: "A scan is already running" });
    return;
  }
  const tab = await self.chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || !/^https?:/.test(tab.url ?? "")) {
    sendResponse({ error: "Open an http(s) page and try again" });
    return;
  }
  scanning = true;
  const authorized = (self.__jevAuthorizedTabs ??= new Set<number>());
  authorized.add(tabId);
  try {
    await self.chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const result = await chrome.tabs.sendMessage(tabId, { type: "jev-do-scan", threshold, auto });
    sendResponse(result ?? { error: "Scan script did not run" });
  } catch (error) {
    sendResponse({ error: error instanceof Error && error.message ? error.message : "Scan failed" });
  } finally {
    if (!auto) authorized.delete(tabId);
    scanning = false;
  }
}

async function handleReading(tabId: number, sendResponse: (response: unknown) => void) {
  const { apiKey, token } = await self.chrome.storage.local.get(["apiKey", "token"]);
  if (!(typeof apiKey === "string" && apiKey) && !(typeof token === "string" && token)) {
    sendResponse({ error: "Paste your TypeSafe API key in the extension popup" });
    return;
  }
  const tab = await self.chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || !/^https?:/.test(tab.url ?? "")) {
    sendResponse({ error: "Open an http(s) page and try again" });
    return;
  }
  const authorized = (self.__jevAuthorizedTabs ??= new Set<number>());
  authorized.add(tabId);
  try {
    await self.chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const { threshold } = await self.chrome.storage.local.get("threshold");
    const result = await chrome.tabs.sendMessage(tabId, { type: "jev-do-reading", threshold: typeof threshold === "number" ? threshold : 0.95 });
    sendResponse(result ?? { error: "Reading script did not run" });
  } catch (error) {
    sendResponse({ error: error instanceof Error && error.message ? error.message : "Quiet reading failed" });
  } finally {
    authorized.delete(tabId);
  }
}

async function handleClassify(request: ScanRequest, sendResponse: (response: unknown) => void) {
  const { apiKey, apiBase, token, backendPort } = await self.chrome.storage.local.get(["apiKey", "apiBase", "token", "backendPort"]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    request = validateRequest(request);
    if (typeof apiKey === "string" && apiKey) {
      const base = typeof apiBase === "string" && /^https?:\/\//.test(apiBase) ? apiBase : "https://api.typesafe.ai";
      const url = `${base}/v1/systemone`;
      console.log(`[jev] direct TypeSafe POST ${url} (${Object.keys(buildJevRequestBody(request).questions).length} questions)`);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildJevRequestBody(request)),
        signal: controller.signal,
      });
      const data: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        sendResponse({ error: response.status === 401 ? "TypeSafe rejected the API key — check it in the popup" : `TypeSafe API error (${response.status})` });
        return;
      }
      sendResponse(mapJevResponse(data, request));
      return;
    }
    if (typeof token !== "string" || !token) {
      sendResponse({ error: "Paste your TypeSafe API key in the extension popup" });
      return;
    }
    const base = typeof backendPort === "number" && backendPort > 0 && backendPort < 65536 ? `http://127.0.0.1:${backendPort}` : BACKEND_URL;
    const url = `${base}/classify`;
    console.log(`[jev] classify POST ${url} (${JSON.stringify(request).length} bytes)`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || typeof body !== "object" || body === null || !("decisions" in body)) {
      sendResponse({ error: body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : `Classification failed (${response.status})` });
      return;
    }
    sendResponse(validateResult(body, request));
  } catch {
    sendResponse({ error: "Could not reach TypeSafe. Check your connection and API key." });
  } finally {
    clearTimeout(timeout);
  }
}
