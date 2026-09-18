import { DEFAULT_THRESHOLD, type ScanRequest } from "../shared/protocol.js";
import { baseSiteKey } from "../shared/site.js";
import { validateResult } from "../shared/validation.js";
import { describe, hideProvisional, replace, resolveSlotWrapper, safe, slotSelector, unhideProvisional, type Candidate } from "./dom.js";
import { collectWithFrames } from "./frame.js";
import { VerdictCache } from "./verdicts.js";

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
  const verdictCache: Promise<VerdictCache> = VerdictCache.load(baseSiteKey(location.hostname));
  let verdictsInstance: VerdictCache | undefined;
  void verdictCache.then((cache) => { verdictsInstance = cache; });

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
    const provisionallyHidden: HTMLElement[] = [];
    const labelFor = (candidate: Candidate) => {
      const position = candidate.node.querySelector("[data-ad-position]")?.getAttribute("data-ad-position");
      return position && /^SLOT-\d+$/.test(position) ? position : candidate.node.id || candidate.block.id;
    };
    if (!document.body) {
      scanning = false;
      if (enableAuto) enableAutoScan(threshold);
      return { replaced: 0, scanned: 0, limited: false, extractionMs: 0, auto: autoEnabled, autoDisabledReason };
    }
    try {
      const started = performance.now();
      const verdicts = await verdictCache;
      const { request, candidates, limited, diagnostics } = collectWithFrames(document, { incremental, skipSignatures: belowThresholdSignatures });
      const extractionMs = Math.round(performance.now() - started);
      if (!candidates.length) {
        if (enableAuto) enableAutoScan(threshold);
        else scheduleAuto();
        return { replaced: 0, scanned: 0, limited, extractionMs, diagnostics, auto: autoEnabled, autoDisabledReason };
      }
      let replaced = 0;
      const judgedBelow = new Set<string>();
      const decisions: Decision[] = [];
      const unknown = candidates.filter((candidate) => {
        const cachedProbability = verdicts.get(candidate.snapshot);
        if (cachedProbability === undefined) return true;
        const restore = cachedProbability >= threshold ? replace(candidate, cachedProbability) : undefined;
        if (restore) { restores.push(restore); replaced++; }
        else if (cachedProbability < threshold) judgedBelow.add(candidate.snapshot);
        decisions.push({
          label: labelFor(candidate),
          probability: cachedProbability,
          outcome: restore ? "replaced (known)" : cachedProbability < threshold ? "below threshold (known)" : "changed or detached before replacement",
        });
        return false;
      });
      for (const candidate of unknown) {
        if (!candidate.strong) continue;
        hideProvisional(candidate.node);
        provisionallyHidden.push(candidate.node);
      }
      const failOpen = () => {
        provisionallyHidden.forEach(unhideProvisional);
        provisionallyHidden.length = 0;
      };
      if (unknown.length) {
        const unknownRequest: ScanRequest = { ...request, blocks: unknown.map((candidate) => candidate.block) };
        const response = await chrome.runtime.sendMessage({ type: "jev-classify", request: unknownRequest });
        if (generation !== currentGeneration || location.href !== pageUrl) {
          failOpen();
          return { replaced, scanned: candidates.length, limited, extractionMs, cancelled: true };
        }
        if (response?.error) {
          failOpen();
          return { replaced, scanned: candidates.length, limited, extractionMs, error: String(response.error) };
        }
        const result = validateResult(response, unknownRequest);
        const probabilities = new Map(result.decisions.map((decision) => [decision.id, decision.probability]));
        for (const candidate of unknown) {
          const probability = probabilities.get(candidate.block.id)!;
          verdicts.set(candidate.snapshot, probability);
          const restore = probability >= threshold ? replace(candidate, probability) : undefined;
          if (restore) { restores.push(restore); replaced++; }
          else {
            unhideProvisional(candidate.node);
            judgedBelow.add(candidate.snapshot);
          }
          decisions.push({
            label: labelFor(candidate),
            probability,
            outcome: restore ? "replaced" : probability < threshold ? "below threshold" : "changed or detached before replacement",
          });
        }
      } else {
        failOpen();
      }
      belowThresholdSignatures.clear();
      for (const signature of judgedBelow) belowThresholdSignatures.add(signature);
      void verdicts.save();
      if (enableAuto) enableAutoScan(threshold);
      else scheduleAuto();
      recordSummary({ replaced, scanned: candidates.length, limited, extractionMs, diagnostics, decisions, incremental, autoEnabled, autoDisabledReason });
      return { replaced, scanned: candidates.length, limited, extractionMs, diagnostics, decisions, auto: autoEnabled, autoDisabledReason };
    } catch (error) {
      provisionallyHidden.forEach(unhideProvisional);
      throw error;
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

  function fastPath(added: Element[]) {
    const verdicts = verdictsInstance;
    if (!verdicts) return;
    for (const root of added.slice(0, 10)) {
      if (!(root instanceof window.HTMLElement)) continue;
      const targets: HTMLElement[] = [];
      if (root.matches(slotSelector)) targets.push(root);
      for (const element of [...root.querySelectorAll<HTMLElement>(slotSelector)].slice(0, 8)) targets.push(element);
      for (const node of targets.slice(0, 8)) {
        if (!node.isConnected) continue;
        const resolved = resolveSlotWrapper(node);
        if (!resolved || !safe(resolved)) continue;
        const { block, signature } = describe(resolved);
        const probability = verdicts.get(signature);
        if (probability === undefined) {
          if (!resolved.dataset.jevHidden) {
            hideProvisional(resolved);
          }
          continue;
        }
        if (probability >= autoThreshold) {
          const restore = replace({ node: resolved, snapshot: signature, block: { id: `fast-${resolved.tagName}`, ...block }, strong: true }, probability);
          if (restore) restores.push(restore);
        }
      }
    }
  }

  function scheduleAuto() {
    if (!autoEnabled || autoTimer !== undefined) return;
    autoTimer = window.setTimeout(async () => {
      autoTimer = undefined;
      if (location.href !== document.location.href || !document.body) {
        scheduleAuto();
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
    const added: Element[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) added.push(node as Element);
      }
    }
    if (added.length) fastPath(added);
    if (scanning) {
      mutationPending = true;
      return;
    }
    if (autoTimer !== undefined) return;
    if (records.some((record) => record.addedNodes.length > 0)) scheduleAuto();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
