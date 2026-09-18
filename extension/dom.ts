import { MAX_BLOCKS, MAX_STATE_CHARS, MAX_TEXT, type PageBlock, type ScanRequest } from "../shared/protocol.js";

const sensitive = 'form,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-private]';
const pageChrome = 'nav,header,footer,[role="navigation"]';
const adHint = /(?:^|[\s_-])(ad|ads|advert|advertisement|advertising|sponsored|sponsor|promoted)(?:$|[\s_-])/i;
const normalize = (text: string, length: number) => text.replace(/\s+/g, " ").trim().slice(0, length);
const slotSelector = '[data-adunitpath],iframe[aria-label="Publicité" i],iframe[aria-label="Advertisement" i],iframe[title="Advertisement" i]';
const wrapperSelector = '.AmPlaceholder__skeleton';
const adNetwork = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|adsrvr\.org|amazon-adsystem\.com|criteo\.com|criteo\.net|2mdn\.net|tabmo\.io|taboola\.com|outbrain\.com|teads\.tv|3lift\.com|media\.net|pubmatic\.com|rubiconproject\.com|openx\.net|smartadserver\.com|casalemedia\.com)$/;

function urlHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.hostname : undefined;
  } catch { return undefined; }
}

function backgroundHosts(style: CSSStyleDeclaration): string[] {
  const hosts: string[] = [];
  for (const match of style.backgroundImage.matchAll(/url\(["']?([^"')]+)/g)) {
    const host = urlHost(match[1]);
    if (host) hosts.push(host);
  }
  return hosts;
}

function adNetworkEvidence(node: HTMLElement): boolean {
  const anchors = node.matches("a[href]") ? [node as HTMLAnchorElement] : [...node.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(0, 2);
  for (const anchor of anchors) {
    try { if (adNetwork.test(new URL(anchor.href).hostname)) return true; } catch { continue; }
  }
  const image = node.querySelector<HTMLImageElement>("img[src]");
  if (image) {
    try { if (adNetwork.test(new URL(image.src).hostname)) return true; } catch { /* ignore */ }
  }
  const frame = node.matches("iframe[src]") ? node as HTMLIFrameElement : node.querySelector<HTMLIFrameElement>("iframe[src]");
  if (frame) {
    try { if (adNetwork.test(new URL(frame.src).hostname)) return true; } catch { /* ignore */ }
  }
  return false;
}

function backgroundAdEvidence(node: HTMLElement, style?: CSSStyleDeclaration): string | undefined {
  const candidates: string[] = [];
  if (style) candidates.push(style.backgroundImage);
  candidates.push(node.style.backgroundImage);
  for (const element of [...node.querySelectorAll<HTMLElement>('[style*="background"]')].slice(0, 2)) {
    candidates.push(element.style.backgroundImage);
  }
  for (const value of candidates) {
    for (const host of backgroundHosts({ backgroundImage: value } as CSSStyleDeclaration)) {
      if (adNetwork.test(host)) return host;
    }
  }
  return undefined;
}

function slotEvidence(node: HTMLElement) {
  const frames = [...node.querySelectorAll("iframe")].slice(0, 3);
  if (node.matches("iframe")) frames.unshift(node as HTMLIFrameElement);
  const labels = frames.map((frame) => normalize(`${frame.getAttribute("aria-label") ?? ""} ${frame.title}`, 100)).filter(Boolean);
  for (const imageRole of [...node.querySelectorAll<HTMLElement>('[role="img"][aria-label]')].slice(0, 2)) {
    const label = normalize(imageRole.getAttribute("aria-label") ?? "", 100);
    if (label) labels.push(label);
  }
  return {
    frames,
    labels,
    hasAdUnit: node.hasAttribute("data-adunitpath") || Boolean(node.querySelector("[data-adunitpath]")),
    hasFrame: frames.length > 0,
  };
}

export function describe(node: HTMLElement): { block: Omit<PageBlock, "id">; signature: string } {
  const links = [...node.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(0, 4);
  if (node.matches("a[href]")) links.unshift(node as HTMLAnchorElement);
  const context = node.parentElement?.getAttribute("aria-label") ?? "";
  const hosts: string[] = [];
  const hrefs: string[] = [];
  for (const link of links) {
    try {
      const url = new URL(link.href);
      if (/^https?:$/.test(url.protocol)) {
        hosts.push(url.hostname);
        hrefs.push(link.href.slice(0, 300));
      }
    } catch { continue; }
  }
  const evidence = slotEvidence(node);
  const imageHosts: string[] = [];
  for (const image of [...node.querySelectorAll<HTMLImageElement>("img[src]")].slice(0, 3)) {
    const host = urlHost(image.src);
    if (host) imageHosts.push(host);
  }
  const frameHosts: string[] = [];
  for (const frame of evidence.frames.slice(0, 3)) {
    const host = urlHost(frame.src);
    if (host) frameHosts.push(host);
  }
  const bgAdHost = backgroundAdEvidence(node);
  const bgHosts: string[] = [];
  if (bgAdHost) bgHosts.push(bgAdHost);
  for (const element of [...node.querySelectorAll<HTMLElement>('[style*="background"]')].slice(0, 3)) {
    for (const host of backgroundHosts(element.style)) {
      if (adNetwork.test(host) && !bgHosts.includes(host)) bgHosts.push(host);
    }
  }
  const block = {
    text: normalize(node.innerText ?? node.textContent ?? "", MAX_TEXT),
    tag: node.tagName.toLowerCase(),
    label: normalize([node.getAttribute("aria-label") ?? "", ...evidence.labels].join(" "), 160),
    hints: normalize(`${evidence.hasAdUnit ? "data-adunitpath present; " : ""}${evidence.hasFrame ? "iframe present; " : ""}${frameHosts.map((host) => `frame-host ${host};`).join(" ")}${bgHosts.map((host) => `background-host ${host};`).join(" ")}${node.id.startsWith("google_ads_iframe_") ? "advertising-frame-container" : node.id} ${node.className}`, 160),
    context: normalize(context, 200),
    linkHosts: [...new Set(hosts)].slice(0, 4),
    imageHosts: [...new Set(imageHosts)].slice(0, 3),
    imageAlts: [...node.querySelectorAll<HTMLImageElement>("img[alt]")].slice(0, 3).map((image) => normalize(image.alt, 160)),
  };
  return { block, signature: JSON.stringify([block, hrefs.slice(0, 4)]) };
}

export function safe(node: HTMLElement): boolean {
  const inside = (selector: string) => {
    let current: HTMLElement | null = node;
    while (current) {
      if (current.matches(selector)) return true;
      current = current.parentElement;
    }
    return false;
  };
  return !inside(sensitive) && !inside(pageChrome) && !inside("[data-jev-neutral]") && !node.querySelector(sensitive) && !node.querySelector(pageChrome) && node.tagName !== "BODY" && node.tagName !== "HTML";
}

export interface Candidate { node: HTMLElement; snapshot: string; block: PageBlock; strong: boolean }

export function collect(document: Document, options?: { incremental?: boolean; skipSignatures?: Set<string> }): { request: ScanRequest; candidates: Candidate[]; limited: boolean; diagnostics: { inspected: number; eligible: number } } {
  const request: ScanRequest = { page: { host: document.location.hostname, title: document.title.slice(0, 200) }, blocks: [] };
  const win = document.defaultView;
  const pool: { node: HTMLElement; priority: number; strong: boolean }[] = [];
  const seen = new Set<HTMLElement>();
  const incremental = options?.incremental === true;
  function consider(node: HTMLElement, explicitSlot = false) {
    if (seen.has(node)) return;
    seen.add(node);
    if (!node.matches("aside,article,li,section,div,a,iframe,span") || !safe(node) || node.matches('main,[role="main"]')) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 14) return;
    const style = win?.getComputedStyle(node);
    const bgHost = backgroundAdEvidence(node, style);
    const networkAd = adNetworkEvidence(node) || Boolean(bgHost);
    if (networkAd && !node.matches("a,iframe")) {
      const parent = node.parentElement;
      if (parent && parent.childElementCount <= 6) consider(parent, true);
    }
    if (!explicitSlot && !networkAd && (rect.height > 650 || rect.width > 2000)) return;
    if (!explicitSlot && !networkAd && (rect.bottom < -300 || rect.top > (win?.innerHeight ?? 1000) + 1200)) return;
    if (style?.visibility === "hidden" || style?.display === "none" || style?.opacity === "0") return;
    const rawText = node.innerText ?? node.textContent ?? "";
    if (rawText.length > MAX_TEXT || node.childElementCount > 12) return;
    const hint = explicitSlot || networkAd || adHint.test(`${node.id} ${node.className} ${node.getAttribute("aria-label") ?? ""}`) || /^(sponsored|advertisement|promoted|publicité)\b/i.test(rawText.trim());
    if (!hint && !node.querySelector("a[href]") && !node.matches("a[href]")) return;
    if (rawText.trim().length < 8 && !hint) return;
    pool.push({ node, priority: explicitSlot || networkAd ? 3 : hint ? 2 : node.matches("article,aside,li") ? 1 : 0, strong: explicitSlot || networkAd });
  }
  const slots = document.querySelectorAll<HTMLElement>(slotSelector);
  for (let index = 0; index < Math.min(slots.length, 100); index++) {
    const slot = slots[index];
    const wrapper = slot.closest<HTMLElement>(wrapperSelector);
    const candidate = wrapper ?? (slot.tagName === "IFRAME" ? slot.parentElement : slot);
    if (candidate) consider(candidate, true);
  }
  const anchors = document.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (let index = 0; index < Math.min(anchors.length, 400); index++) {
    try {
      if (!adNetwork.test(new URL(anchors[index].href).hostname)) continue;
    } catch { continue; }
    consider(anchors[index], true);
    const wrapper = anchors[index].parentElement;
    if (wrapper && wrapper.childElementCount <= 3) consider(wrapper, true);
  }
  const images = document.querySelectorAll<HTMLImageElement>("img[src]");
  for (let index = 0; index < Math.min(images.length, 200); index++) {
    try {
      if (!adNetwork.test(new URL(images[index].src).hostname)) continue;
    } catch { continue; }
    if (images[index].closest("a[href]")) continue;
    const holder = images[index].parentElement;
    if (holder) consider(holder, true);
  }
  const adFrames = document.querySelectorAll<HTMLIFrameElement>("iframe[src]");
  for (let index = 0; index < Math.min(adFrames.length, 200); index++) {
    try {
      if (!adNetwork.test(new URL(adFrames[index].src).hostname)) continue;
    } catch { continue; }
    const holder = adFrames[index].parentElement;
    if (holder) consider(holder, true);
    consider(adFrames[index], true);
  }
  const walker = document.createTreeWalker(document.body, 1);
  let visited = 0;
  let current: Node | null;
  if (!incremental) {
    while ((current = walker.nextNode()) && visited++ < 2500) consider(current as HTMLElement);
  }
  pool.sort((a, b) => b.priority - a.priority || Number(b.node.contains(a.node)) - Number(a.node.contains(b.node)));
  const candidates: Candidate[] = [];
  let limited = visited >= 2500;
  for (const { node, strong } of pool) {
    if (candidates.some((candidate) => candidate.node.contains(node) || node.contains(candidate.node))) continue;
    const { block: details, signature } = describe(node);
    if (incremental && options?.skipSignatures?.has(signature)) continue;
    if (candidates.length >= MAX_BLOCKS) { limited = true; break; }
    const block = { id: `block-${candidates.length}`, ...details };
    if (JSON.stringify({ ...request, blocks: [...request.blocks, block] }).length > MAX_STATE_CHARS) { limited = true; continue; }
    candidates.push({ node, snapshot: signature, block, strong });
    request.blocks.push(block);
  }
  return { request, candidates, limited, diagnostics: { inspected: Math.min(visited, 2500), eligible: pool.length } };
}

export function fresh(candidate: Candidate): boolean {
  return candidate.node.isConnected && safe(candidate.node) && describe(candidate.node).signature === candidate.snapshot;
}

export function hideProvisional(node: HTMLElement): void {
  node.dataset.jevHidden = "true";
  node.style.setProperty("opacity", "0", "important");
}

export function unhideProvisional(node: HTMLElement): void {
  if (node.dataset.jevHidden !== "true") return;
  delete node.dataset.jevHidden;
  node.style.removeProperty("opacity");
}

export function replace(candidate: Candidate, probability: number): (() => void) | undefined {
  if (!fresh(candidate)) return;
  const node = candidate.node;
  const document = node.ownerDocument;
  const rect = node.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : Math.min(node.offsetWidth || 640, 640);
  const height = rect.height > 0 ? rect.height : 80;
  const placeholder = document.createElement("div");
  placeholder.dataset.jevNeutral = "true";
  placeholder.style.cssText = `display:block!important;box-sizing:border-box!important;width:${width}px!important;max-width:100%!important;height:${Math.min(Math.max(height, 65), 900)}px!important;`;
  const shadow = placeholder.attachShadow({ mode: "open" });
  const panel = document.createElement("div");
  panel.style.cssText = "box-sizing:border-box;height:100%;display:flex;gap:10px;flex-direction:column;align-items:center;justify-content:center;background:#edf1ed;color:#536258;border:1px solid #dce4dc;border-radius:8px;font:13px system-ui;text-align:center;";
  const label = document.createElement("span");
  label.textContent = `A little quiet space · ${Math.round(probability * 100)}% ad probability`;
  const button = document.createElement("button");
  button.textContent = "Show original";
  button.style.cssText = "font:12px system-ui;cursor:pointer;color:#345743;background:white;border:1px solid #c2d0c5;border-radius:5px;padding:4px 9px;";
  let restored = false;
  const restore = () => {
    if (!restored && placeholder.parentNode) placeholder.replaceWith(node);
    unhideProvisional(node);
    restored = true;
  };
  button.addEventListener("click", restore);
  panel.append(label, button);
  shadow.append(panel);
  node.replaceWith(placeholder);
  return restore;
}
