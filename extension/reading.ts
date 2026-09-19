import { MAX_BLOCKS, MAX_STATE_CHARS, type ScanRequest, type ScanResult } from "../shared/protocol.js";
import { validateResult } from "../shared/validation.js";
import { adNetworkEvidence, backgroundAdEvidence } from "./dom.js";

const sensitive = 'form,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-private]';

function readingSafe(node: HTMLElement): boolean {
  let current: HTMLElement | null = node;
  while (current) {
    if (current.matches(sensitive)) return false;
    current = current.parentElement;
  }
  return node.tagName !== "BODY" && node.tagName !== "HTML" && !node.querySelector(sensitive);
}

function adEvidence(node: HTMLElement): boolean {
  if (adNetworkEvidence(node) || backgroundAdEvidence(node)) return true;
  for (const element of [...node.querySelectorAll<HTMLElement>("img[src],iframe[src],[style*='background']")].slice(0, 8)) {
    try {
      const url = element.tagName === "IFRAME" || element.tagName === "IMG" ? (element as HTMLIFrameElement | HTMLImageElement).src : element.style.backgroundImage;
      if (!url) continue;
      const host = url.startsWith("http") ? new URL(url).hostname : (url.match(/https?:\/\/([^/"']+)/)?.[1] ?? "");
      if (host && /(^|\.)(doubleclick\.net|googlesyndication\.com|taboola\.com|outbrain\.com|digiteka\.com|teads\.tv|adnxs\.com|media\.net|3lift\.com)$/.test(host)) return true;
    } catch { continue; }
  }
  return false;
}

const noiseSelector = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[aria-hidden="true"]';
const noiseClassId = /(promo|banner|cookie|consent|newsletter|related|comment|sharing|social|sidebar|recommend|subscribe|signup|advert|breadcrumb|paywall|popup|modal|widget)/i;
const containerSelector = "article,section,div,main,ul,ol";

export interface ReadingAnalysis {
  keep: HTMLElement | null;
  hideNow: HTMLElement[];
  ambiguous: HTMLElement[];
}

function textLength(node: HTMLElement): number {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function linkDensity(node: HTMLElement): number {
  const total = textLength(node);
  if (total === 0) return 1;
  let linkText = 0;
  for (const link of [...node.querySelectorAll("a")].slice(0, 40)) linkText += textLength(link);
  return linkText / total;
}

function contentScore(node: HTMLElement): number {
  const paragraphs = node.querySelectorAll("p").length;
  const length = textLength(node);
  return length * (1 - linkDensity(node)) + paragraphs * 30;
}

function isNoiseNamed(node: HTMLElement): boolean {
  if (node.matches(noiseSelector)) return true;
  return noiseClassId.test(`${node.id} ${node.className}`);
}

function readingHidden(node: HTMLElement): boolean {
  return node.dataset.qsReadingHidden === "true";
}

function dominantContainer(body: HTMLElement): HTMLElement | null {
  let node: HTMLElement = body;
  const parentScore = contentScore(node) || 1;
  for (;;) {
    const children = [...node.children].filter((child): child is HTMLElement =>
      (child as HTMLElement).matches?.(containerSelector) && textLength(child as HTMLElement) >= 250 && readingSafe(child as HTMLElement));
    if (!children.length) break;
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const child of children) {
      const score = contentScore(child);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    if (!best || bestScore < parentScore * 0.4) break;
    node = best;
  }
  return node === body ? null : node;
}

export function analyzeReading(document: Document): ReadingAnalysis {
  const body = document.body;
  const hideNow: HTMLElement[] = [];
  const ambiguous: HTMLElement[] = [];
  if (!body) return { keep: null, hideNow, ambiguous };

  const keep = dominantContainer(body);

  const keepRelated = (node: HTMLElement) => keep !== null && (keep.contains(node) || node.contains(keep));

  const walker = document.createTreeWalker(body, 1);
  const claimed = new Set<HTMLElement>();
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as HTMLElement;
    if (readingHidden(node) || claimed.has(node)) continue;
    if (keepRelated(node)) continue;
    if (node === document.body || node.tagName === "HTML") continue;
    if (!readingSafe(node)) continue;
    if (adEvidence(node)) {
      hideNow.push(node);
      claimed.add(node);
      for (const ancestor of ancestors(node)) {
        if (ancestor === document.body) break;
        claimed.add(ancestor);
      }
      for (const descendant of [...node.querySelectorAll<HTMLElement>("*")]) claimed.add(descendant);
      continue;
    }
    if (isNoiseNamed(node) || (keep === null && textLength(node) >= 80)) {
      hideNow.push(node);
      claimed.add(node);
      for (const ancestor of ancestors(node)) {
        if (ancestor === document.body) break;
        claimed.add(ancestor);
      }
      for (const descendant of [...node.querySelectorAll<HTMLElement>("*")]) claimed.add(descendant);
      continue;
    }
    if (node.matches(containerSelector) && textLength(node) >= 80 && !node.querySelector(containerSelector)) {
      ambiguous.push(node);
    }
  }

  const deduped: HTMLElement[] = [];
  for (const node of ambiguous) {
    if (hideNow.some((hidden) => hidden.contains(node)) || deduped.some((existing) => existing.contains(node) || node.contains(existing))) continue;
    deduped.push(node);
  }
  return { keep, hideNow, ambiguous: deduped.slice(0, MAX_BLOCKS) };
}

function ancestors(node: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let current = node.parentElement;
  while (current) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

export interface ReadingSummary {
  active: boolean;
  hidden: number;
  kept: number;
  error?: string;
}

let readingState: { hidden: HTMLElement[]; bar: HTMLElement } | null = null;

function hideNode(node: HTMLElement) {
  node.dataset.qsReadingHidden = "true";
  node.style.setProperty("display", "none", "important");
}

function restoreNode(node: HTMLElement) {
  if (node.dataset.qsReadingHidden !== "true") return;
  delete node.dataset.qsReadingHidden;
  node.style.removeProperty("display");
}

export function isReadingActive(): boolean {
  return readingState !== null;
}

export function exitQuietReading(): number {
  if (!readingState) return 0;
  const count = readingState.hidden.length;
  readingState.hidden.forEach(restoreNode);
  readingState.bar.remove();
  readingState = null;
  return count;
}

function showExitBar(document: Document, onExit: () => void) {
  const bar = document.createElement("div");
  bar.dataset.qsReadingBar = "true";
  bar.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;align-items:center;background:#101815;color:#cfd8d2;font:13px system-ui;padding:8px 12px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.35);";
  const label = document.createElement("span");
  label.textContent = "Quiet reading";
  const button = document.createElement("button");
  button.textContent = "Exit";
  button.style.cssText = "font:12px system-ui;cursor:pointer;background:#cfd8d2;color:#101815;border:0;border-radius:5px;padding:4px 10px;";
  button.addEventListener("click", () => onExit());
  bar.append(label, button);
  document.documentElement.appendChild(bar);
  readingState!.bar = bar;
}

export async function applyQuietReading(document: Document, opts: { threshold: number; classify: (request: ScanRequest) => Promise<unknown> }): Promise<ReadingSummary> {
  if (readingState) {
    const restored = exitQuietReading();
    return { active: false, hidden: 0, kept: restored };
  }
  const { keep, hideNow, ambiguous } = analyzeReading(document);
  hideNow.forEach(hideNode);
  const hidden: HTMLElement[] = [...hideNow];
  let kept = keep ? 1 : 0;
  let error: string | undefined;
  const jevHidden: HTMLElement[] = [];
  if (ambiguous.length) {
    const request: ScanRequest = {
      page: { host: document.location.hostname, title: document.title.slice(0, 200) },
      blocks: ambiguous.map((node, index) => ({ id: `r-${index}`, ...describeBlock(node) })),
      mode: "reading",
    };
    while (JSON.stringify(request).length > MAX_STATE_CHARS && request.blocks.length > 1) request.blocks.pop();
    try {
      const response = await opts.classify(request);
      const result: ScanResult = validateResult(response, request);
      const probabilities = new Map(result.decisions.map((decision) => [decision.id, decision.probability]));
      ambiguous.forEach((node, index) => {
        const probability = probabilities.get(`r-${index}`) ?? 1;
        if (probability < opts.threshold) {
          hideNode(node);
          hidden.push(node);
          jevHidden.push(node);
        } else {
          kept++;
        }
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Reading classification failed";
      jevHidden.forEach(restoreNode);
    }
  }
  if (readingState) exitQuietReading();
  const bar = document.createElement("div");
  readingState = { hidden, bar };
  showExitBar(document, () => exitQuietReading());
  return { active: true, hidden: hidden.length, kept, error };
}

function describeBlock(node: HTMLElement) {
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const links = [...node.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(0, 4);
  const linkHosts = [...new Set(links.map((link) => {
    try {
      const url = new URL(link.href);
      return /^https?:$/.test(url.protocol) ? url.hostname : "";
    } catch { return ""; }
  }).filter(Boolean))].slice(0, 4);
  return {
    text,
    tag: node.tagName.toLowerCase(),
    label: node.getAttribute("aria-label") ?? "",
    hints: `${node.id} ${node.className}`.slice(0, 160),
    context: "",
    linkHosts,
    imageAlts: [],
  };
}
