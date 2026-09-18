import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { JEV_MODEL, mapJevResponse, questionSpecs } from "../shared/jev.js";
import type { ScanRequest, ScanResult } from "../shared/protocol.js";

export function createClassifier(client: TypeSafeClient) {
  return async (request: ScanRequest): Promise<ScanResult> => {
    const response = await client.systemOne({
      model: JEV_MODEL,
      state: { page: { ...request.page }, blocks: request.blocks.map((block) => ({ ...block })) },
      questions: Object.fromEntries(questionSpecs(request.blocks.length).map((spec) => [spec.id, noul(spec.instructions, spec.criteria)])),
    }, { signal: AbortSignal.timeout(15000), retry: { maxRetries: 0 } });
    console.log(`[TypeSafe] model=${response.model} blocks=${request.blocks.length} usage: ${response.usage.input_tokens ?? "?"} input / ${response.usage.output_tokens ?? "?"} output tokens`);
    return mapJevResponse(response, request);
  };
}
