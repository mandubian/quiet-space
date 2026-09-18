import { MAX_BLOCKS, MAX_STATE_CHARS, type ScanRequest } from "../shared/protocol.js";
import { collect, type Candidate } from "./dom.js";

export function collectWithFrames(document: Document, options?: { incremental?: boolean; skipSignatures?: Set<string>; framesOverride?: Array<{ document: Document }> }): { request: ScanRequest; candidates: Candidate[]; limited: boolean; diagnostics: { inspected: number; eligible: number } } {
  const main = collect(document, options);
  const request = main.request;
  const candidates = [...main.candidates];
  let limited = main.limited;
  let inspected = main.diagnostics.inspected;
  let eligible = main.diagnostics.eligible;
  const frames = options?.framesOverride ?? (document.defaultView?.frames as unknown as Array<{ document: Document }> | undefined) ?? [];
  for (let frameIndex = 0; frameIndex < Math.min(frames.length, 5); frameIndex++) {
    let frameDocument: Document;
    try {
      frameDocument = frames[frameIndex].document;
      if (!frameDocument?.body || frameDocument === document) continue;
    } catch { continue; }
    const frameResult = collect(frameDocument, options);
    inspected += frameResult.diagnostics.inspected;
    eligible += frameResult.diagnostics.eligible;
    limited = limited || frameResult.limited;
    for (const candidate of frameResult.candidates) {
      if (candidates.some((existing) => existing.node === candidate.node)) continue;
      if (candidates.length >= MAX_BLOCKS) { limited = true; break; }
      const block = { ...candidate.block, id: `f${frameIndex}-${candidate.block.id}` };
      if (JSON.stringify({ ...request, blocks: [...request.blocks, block] }).length > MAX_STATE_CHARS) { limited = true; break; }
      candidates.push({ node: candidate.node, snapshot: candidate.snapshot, block, strong: candidate.strong });
      request.blocks.push(block);
    }
    if (candidates.length >= MAX_BLOCKS) { limited = true; break; }
  }
  return { request, candidates, limited, diagnostics: { inspected: Math.min(inspected, 2500), eligible } };
}
