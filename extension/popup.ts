import { DEFAULT_THRESHOLD } from "../shared/protocol.js";
import { baseSiteKey, matchingSiteKey } from "../shared/site.js";

const status = document.getElementById("status")!;
const apiKey = document.getElementById("apikey") as HTMLInputElement;
const threshold = document.getElementById("threshold") as HTMLInputElement;
const thresholdValue = document.getElementById("threshold-value")!;
const siteAuto = document.getElementById("site-auto") as HTMLInputElement;
const scanButton = document.getElementById("scan") as HTMLButtonElement;
const restoreButton = document.getElementById("restore") as HTMLButtonElement;
const decisionsPanel = document.getElementById("decisions")!;
let summaryShown = false;

function sites(stored: unknown): Record<string, unknown> {
  return (stored && typeof stored === "object" && !Array.isArray(stored)) ? stored as Record<string, unknown> : {};
}

async function activeHttpTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && /^https?:/.test(active.url ?? "")) return active as chrome.tabs.Tab & { url: string; id: number };
  const httpTabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const candidate = httpTabs.find((tab) => tab.id && /^https?:/.test(tab.url ?? ""));
  return candidate ? candidate as chrome.tabs.Tab & { url: string; id: number } : undefined;
}

function renderSummary(summary: {
  replaced?: number; scanned?: number; limited?: boolean; extractionMs?: number;
  decisions?: { label: string; probability: number; outcome: string }[];
  incremental?: boolean; cancelled?: boolean; error?: string;
}) {
  summaryShown = true;
  if (summary.error) {
    status.textContent = summary.error;
    status.className = "error";
    decisionsPanel.textContent = "Scan failed — no classification results.";
    return;
  }
  const decisions = Array.isArray(summary.decisions) ? summary.decisions : [];
  decisionsPanel.textContent = decisions.length
    ? decisions.map((decision) => `${decision.label}: ${(decision.probability * 100).toFixed(2)}% — ${decision.outcome}`).join("\n")
    : "No classification results. Missing slots were not classified.";
  const counts = summary.extractionMs !== undefined ? ` · extracted in ${summary.extractionMs} ms` : "";
  status.className = summary.incremental ? "warn" : "";
  status.textContent = `${summary.replaced ?? 0}/${summary.scanned ?? 0} block(s) replaced${counts}${summary.limited ? " (page limit reached)" : ""}${summary.cancelled ? " (scan cancelled)" : ""}${summary.incremental ? " · automatic" : ""}`;
}

async function refreshRestoreState() {
  const tab = await activeHttpTab();
  if (!tab) {
    restoreButton.disabled = true;
    restoreButton.title = "Open an http(s) page first";
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const state = await chrome.tabs.sendMessage(tab.id, { type: "jev-state" });
    const count = Number(state?.placeholders) || 0;
    restoreButton.disabled = count === 0;
    restoreButton.title = count === 0 ? "Nothing replaced on this page yet" : `Restore ${count} replaced block(s)`;
  } catch {
    restoreButton.disabled = true;
    restoreButton.title = "Cannot reach this page";
  }
}

function consentChecked(): boolean {
  return (document.getElementById("consent") as HTMLInputElement).checked;
}

function init(stored: { apiKey?: unknown; threshold?: unknown; autoSites?: unknown; consent?: unknown }) {
  apiKey.value = typeof stored.apiKey === "string" ? stored.apiKey : "";
  threshold.value = typeof stored.threshold === "number" ? String(stored.threshold) : String(DEFAULT_THRESHOLD);
  thresholdValue.textContent = threshold.value;
  (document.getElementById("consent") as HTMLInputElement).checked = stored.consent === true;

  apiKey.addEventListener("change", () => chrome.storage.local.set({ apiKey: apiKey.value }));
  document.getElementById("consent")!.addEventListener("change", (event) => {
    chrome.storage.local.set({ consent: (event.target as HTMLInputElement).checked });
  });
  threshold.addEventListener("input", () => {
    thresholdValue.textContent = threshold.value;
    chrome.storage.local.set({ threshold: Number(threshold.value) });
  });

  void (async () => {
    const tab = await activeHttpTab();
    if (!tab) {
      siteAuto.disabled = true;
      (siteAuto.closest("label") as HTMLLabelElement).title = "Open an http(s) page to enable filtering";
      status.textContent = "Open an http(s) page to use Quiet Space";
      status.className = "warn";
      return;
    }
    const host = new URL(tab.url).hostname;
    const key = matchingSiteKey(host, sites((await chrome.storage.local.get("autoSites")).autoSites));
    siteAuto.checked = key !== undefined;
    if (key && !summaryShown) {
      status.textContent = `Auto-filtering is ON for ${key} — pages load pre-filtered`;
      status.className = "warn";
    }
  })();

  siteAuto.addEventListener("change", async () => {
    const tab = await activeHttpTab();
    if (!tab) return;
    const host = new URL(tab.url).hostname;
    const current = sites((await chrome.storage.local.get("autoSites")).autoSites);
    if (siteAuto.checked) {
      const key = baseSiteKey(host);
      const granted = await chrome.permissions.request({ origins: [`*://*.${key}/*`] });
      if (!granted) {
        siteAuto.checked = false;
        status.textContent = "Permission denied — site stays unfiltered";
        status.className = "error";
        return;
      }
      current[key] = true;
      await chrome.storage.local.set({ autoSites: current });
      await scanTab(tab.id, true);
    } else {
      const key = matchingSiteKey(host, current);
      if (key) delete current[key];
      await chrome.storage.local.set({ autoSites: current });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "jev-restore" });
      await chrome.tabs.sendMessage(tab.id, { type: "jev-auto-off" });
      status.textContent = `${host} unlocked — content restored`;
      status.className = "";
      await refreshRestoreState();
    }
  });

  scanButton.addEventListener("click", () => {
    const consent = document.getElementById("consent") as HTMLInputElement;
    if (!consent.checked) {
      status.textContent = "Check the consent box first for manual scans";
      status.className = "error";
      return;
    }
    void (async () => {
      const tab = await activeHttpTab();
      if (!tab) {
        status.textContent = "Open an http(s) page and try again";
        status.className = "error";
        return;
      }
      await scanTab(tab.id, false);
    })();
  });

  async function runReading(tab: chrome.tabs.Tab & { id: number }): Promise<{ active?: boolean; hidden?: number; kept?: number; error?: string } | undefined> {
    status.textContent = "Quiet reading…";
    decisionsPanel.textContent = "Analyzing page structure…";
    status.className = "";
    const result = await chrome.runtime.sendMessage({ type: "jev-reading", tabId: tab.id });
    if (!result || result.error) {
      status.textContent = result?.error ?? "Quiet reading failed";
      status.className = "error";
      return undefined;
    }
    status.textContent = result.active
      ? `Quiet reading: ${result.hidden} noise block(s) hidden — Exit via the page bar`
      : `Quiet reading off — ${result.kept} block(s) restored`;
    status.className = result.active ? "warn" : "";
    return result;
  }

  document.getElementById("reading")!.addEventListener("click", () => {
    if (!consentChecked()) {
      status.textContent = "Check the consent box first for quiet reading";
      status.className = "error";
      return;
    }
    void (async () => {
      const tab = await activeHttpTab();
      if (!tab) {
        status.textContent = "Open an http(s) page and try again";
        status.className = "error";
        return;
      }
      await runReading(tab);
    })();
  });

  document.getElementById("scan-read")!.addEventListener("click", () => {
    if (!consentChecked()) {
      status.textContent = "Check the consent box first";
      status.className = "error";
      return;
    }
    void (async () => {
      const tab = await activeHttpTab();
      if (!tab) {
        status.textContent = "Open an http(s) page and try again";
        status.className = "error";
        return;
      }
      status.textContent = "Scanning ads…";
      decisionsPanel.textContent = "Waiting for classification…";
      const scan = await scanTab(tab.id, false);
      if (!scan || scan.error) return;
      const reading = await runReading(tab);
      if (!reading || reading.error) return;
      status.textContent = `Scan + read done — ads: ${scan.replaced}/${scan.scanned}, reading: ${reading.hidden} hidden`;
    })();
  });

  restoreButton.addEventListener("click", async () => {
    const tab = await activeHttpTab();
    if (!tab?.id) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "jev-restore" });
    status.textContent = "Original content restored";
    status.className = "";
    await refreshRestoreState();
  });

  void refreshRestoreState();
}

async function scanTab(tabId: number, auto: boolean): Promise<{ replaced?: number; scanned?: number; limited?: boolean; incremental?: boolean; error?: string } | undefined> {
  status.textContent = "Scanning…";
  decisionsPanel.textContent = "Waiting for classification…";
  status.className = "";
  const result = await chrome.runtime.sendMessage({ type: "jev-scan", tabId, threshold: Number(threshold.value), auto });
  if (result.error) {
    status.textContent = result.error;
    status.className = "error";
    decisionsPanel.textContent = "Scan failed — no classification results.";
    return undefined;
  }
  renderSummary({ ...result, incremental: result.incremental ?? false });
  await refreshRestoreState();
  return result;
}

chrome.storage.local.get(["apiKey", "threshold", "autoSites", "consent"]).then(init);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "jev-scan-record") return false;
  renderSummary((message as { summary: Parameters<typeof renderSummary>[0] }).summary);
  void refreshRestoreState();
  return false;
});

void (async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const stored = await chrome.storage.session.get(`scan:${tab.id}`);
  const summary = stored[`scan:${tab.id}`] as Parameters<typeof renderSummary>[0] | undefined;
  if (summary) renderSummary(summary);
})();
