import { MAX_BLOCKS, MAX_STATE_CHARS, MAX_TEXT, type ScanRequest, type ScanResult } from "../shared/protocol.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

export function validateRequest(value: unknown): ScanRequest {
  if (!record(value) || !record(value.page) || !text(value.page.host, 253) || !text(value.page.title, 200) || !Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS || value.blocks.length === 0) {
    throw new Error("Invalid page or blocks");
  }
  const ids = new Set<string>();
  const blocks = value.blocks.map((block: unknown) => {
    if (!record(block) || !text(block.id, 60) || !/^[a-zA-Z0-9-]+$/.test(block.id) || ids.has(block.id) || !text(block.text, MAX_TEXT) || !text(block.tag, 20) || !text(block.label, 160) || !text(block.hints, 160) || !text(block.context, 200)) {
      throw new Error("Invalid block");
    }
    if (!Array.isArray(block.linkHosts) || block.linkHosts.length > 4 || !block.linkHosts.every((v) => text(v, 253)) || !Array.isArray(block.imageAlts) || block.imageAlts.length > 3 || !block.imageAlts.every((v) => text(v, 160))) {
      throw new Error("Invalid block metadata");
    }
    if (block.imageHosts !== undefined && (!Array.isArray(block.imageHosts) || block.imageHosts.length > 3 || !block.imageHosts.every((v) => text(v, 253)))) {
      throw new Error("Invalid block metadata");
    }
    ids.add(block.id);
    return { id: block.id, text: block.text, tag: block.tag, label: block.label, hints: block.hints, context: block.context, linkHosts: block.linkHosts as string[], imageHosts: Array.isArray(block.imageHosts) ? block.imageHosts as string[] : [], imageAlts: block.imageAlts as string[] };
  });
  const request = { page: { host: value.page.host, title: value.page.title }, blocks };
  if (JSON.stringify(request).length > MAX_STATE_CHARS) throw new Error("Page batch is too large");
  return request;
}

export function validateResult(value: unknown, request: ScanRequest): ScanResult {
  if (!record(value) || !Array.isArray(value.decisions) || value.decisions.length !== request.blocks.length) throw new Error("Incomplete classifier response");
  const ids = new Set(request.blocks.map((block) => block.id));
  const decisions = value.decisions.map((decision: unknown) => {
    if (!record(decision) || typeof decision.id !== "string" || !ids.delete(decision.id) || typeof decision.probability !== "number" || !Number.isFinite(decision.probability) || decision.probability < 0 || decision.probability > 1) throw new Error("Invalid classifier response");
    return { id: decision.id, probability: decision.probability };
  });
  return { decisions };
}
