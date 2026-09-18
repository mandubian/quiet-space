import { DEFAULT_THRESHOLD } from "../shared/protocol.js";
import { validateResult } from "../shared/validation.js";
import { collectWithFrames } from "./frame.js";
import { replace } from "./dom.js";

declare const self: Window & { __jevInstalled?: boolean };

interface Decision {
  label: string;
  probability: number;
  outcome: string;
}

interface ScanSummary {
  replaced: number;
  scanned: number;
  limited: boolean;
  extractionMs: number;
  diagnostics?: { inspected: number; eligible: number };
  decisions?: Decision[];
  cancelled?: boolean;
  error?: string;
  auto?: boolean;
  autoDisabledReason?: string;
}

const AUTO_DELAY_MS = 800;
const AUTO_MAX_SCANS = 60;

if (!self.__jevInstalled) {
  self.__jevInstalled = true;
  let generation = 0;
  let scanning = false;
  let autoEnabled = false;
  let autoTimer: number | undefined;
  let autoCount = 0;
  let autoThreshold = DEFAULT_THRESHOLD;
  let autoDisabledReason = "";
  let mutationPending = false;
  const restores: (() => void)[] = [];
  const belowThresholdSignatures = new Set<string>();

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "jev-restore") {
      disableAuto("Restore all");
      const count = restores.length;
      restores.splice(0).forEach((restore) => restore());
      belowThresholdSignatures.clear();
      respond({ restored: count, auto: false });
      return false;
    }
    if (message?.type === "jev-auto-off") {
      disableAuto("Off");
      respond({ auto: false });
      return false;
    }
    if (message?.type === "jev-state") {
      respond({ placeholders: document.querySelectorAll("[data-jev-neutral]").length });
      return false;
    }
    if (message?.type !== "jev-do-scan") return false;
    const threshold = Number(message.threshold);
    const enableAuto = message.auto === true;
    scan(threshold, enableAuto).then(respond).catch(() => respond({ error: "Scan failed; remaining page content is unchanged." }));
    return true;
  });

  window.addEventListener("pagehide", () => disableAuto("Page unloaded"));

  function recordSummary(summary: Record<string, unknown>) {
    chrome.runtime.sendMessage({ type: "jev-scan-record", summary }).catch(() => undefined);
  }

  void chrome.runtime.sendMessage({ type: "jev-auto-check" }).then((state: { enabled?: boolean; threshold?: number } | undefined) => {
    if (state?.enabled) return scan(Number(state.threshold) || 0.95, true);
    return undefined;
  }).catch(() => undefined);

  function disableAuto(reason: string) {
    generation++;
    autoEnabled = false;
    autoDisabledReason = reason;
    if (autoTimer !== undefined) clearTimeout(autoTimer);
    autoTimer = undefined;
  }

  async function scan(threshold: number, enableAuto: boolean, incremental = false): Promise<ScanSummary> {
    if (!Number.isFinite(threshold) || threshold < 0.7 || threshold > 0.99) {
      return { replaced: 0, scanned: 0, limited: false, extractionMs: 0, error: "Invalid threshold" };
    }
    if (scanning) {
      return { replaced: 0, scanned: 0, limited: false, extractionMs: 0, error: "A scan is already running" };
    }
    scanning = true;
    const currentGeneration = ++generation;
    const pageUrl = location.href;
    try {
      const started = performance.now();
      const { request, candidates, limited, diagnostics } = collectWithFrames(document, { incremental, skipSignatures: belowThresholdSignatures });
      const extractionMs = Math.round(performance.now() - started);
      if (!candidates.length) {
        if (enableAuto) enableAutoScan(threshold);
        else scheduleAuto();
        return { replaced: 0, scanned: 0, limited, extractionMs, diagnostics, auto: autoEnabled, autoDisabledReason };
      }
      const response = await chrome.runtime.sendMessage({ type: "jev-classify", request });
      if (generation !== currentGeneration || location.href !== pageUrl) {
        return { replaced: 0, scanned: 0, limited, extractionMs, cancelled: true };
      }
      if (response?.error) {
        return { replaced: 0, scanned: 0, limited, extractionMs, error: String(response.error) };
      }
      const result = validateResult(response, request);
      const probabilities = new Map(result.decisions.map((decision) => [decision.id, decision.probability]));
      let replaced = 0;
      const judgedBelow = new Set<string>();
      const decisions = candidates.map((candidate) => {
        const probability = probabilities.get(candidate.block.id)!;
        const position = candidate.node.querySelector("[data-ad-position]")?.getAttribute("data-ad-position");
        const label = position && /^SLOT-\d+$/.test(position) ? position : candidate.node.id || candidate.block.id;
        const restore = probability >= threshold ? replace(candidate, probability) : undefined;
        if (restore) { restores.push(restore); replaced++; }
        else if (probability < threshold) judgedBelow.add(candidate.snapshot);
        return {
          label,
          probability,
          outcome: restore ? "replaced" : probability < threshold ? "below threshold" : "changed or detached before replacement",
        };
      });
      belowThresholdSignatures.clear();
      for (const signature of judgedBelow) belowThresholdSignatures.add(signature);
      if (enableAuto) enableAutoScan(threshold);
      else scheduleAuto();
      recordSummary({ replaced, scanned: candidates.length, limited, extractionMs, diagnostics, decisions, incremental, autoEnabled, autoDisabledReason });
      return { replaced, scanned: candidates.length, limited, extractionMs, diagnostics, decisions, auto: autoEnabled, autoDisabledReason };
    } finally {
      scanning = false;
      if (mutationPending && autoEnabled) {
        mutationPending = false;
        scheduleAuto();
      }
    }
  }

  function enableAutoScan(threshold: number) {
    autoEnabled = true;
    autoThreshold = threshold;
    autoCount = 0;
    autoDisabledReason = "";
    scheduleAuto();
  }

  function scheduleAuto() {
    if (!autoEnabled || autoTimer !== undefined) return;
    autoTimer = window.setTimeout(async () => {
      autoTimer = undefined;
      if (location.href !== document.location.href || !document.body) {
        disableAuto("Page changed");
        return;
      }
      if (autoCount >= AUTO_MAX_SCANS) {
        disableAuto("Auto-scan limit reached");
        return;
      }
      autoCount++;
      await scan(autoThreshold, false, true);
    }, AUTO_DELAY_MS);
  }

  const observer = new MutationObserver((records) => {
    if (!autoEnabled) return;
    if (scanning) {
      mutationPending = true;
      return;
    }
    if (autoTimer !== undefined) return;
    if (records.some((record) => record.addedNodes.length > 0)) scheduleAuto();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
}
