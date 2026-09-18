import assert from "node:assert/strict";
import test from "node:test";
import type { ScanRequest } from "../shared/protocol.js";
import { buildJevRequestBody, mapJevResponse, questionSpecs } from "../shared/jev.js";

const request: ScanRequest = {
  page: { host: "example.test", title: "News" },
  blocks: [
    { id: "block-0", text: "Sponsored deal", tag: "aside", label: "", hints: "", context: "", linkHosts: [], imageAlts: [] },
    { id: "block-1", text: "Regular story", tag: "article", label: "", hints: "", context: "", linkHosts: [], imageAlts: [] },
  ],
};

test("question specs build one indexed noul question per block", () => {
  const specs = questionSpecs(2);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((spec) => spec.id), ["ad_0", "ad_1"]);
  assert.match(specs[1].instructions, /blocks\[1\]/);
  assert.doesNotMatch(specs[0].instructions, /blocks\[1\]/);
});

test("request body carries model, page state, and typed noul questions", () => {
  const body = buildJevRequestBody(request);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state.page, request.page);
  assert.equal(body.state.blocks.length, 2);
  assert.equal(body.questions.ad_0.type, "noul");
  assert.ok(body.questions.ad_1.criteria.true.length > 10);
});

test("response mapping returns one probability per block", () => {
  const result = mapJevResponse({ answers: { ad_0: { type: "noul", noul: 0.97 }, ad_1: { type: "noul", noul: 0.03 } } }, request);
  assert.deepEqual(result.decisions, [{ id: "block-0", probability: 0.97 }, { id: "block-1", probability: 0.03 }]);
});

test("missing or malformed answers fail closed", () => {
  assert.throws(() => mapJevResponse({}, request));
  assert.throws(() => mapJevResponse({ answers: { ad_0: { type: "noul" } } }, request));
  assert.throws(() => mapJevResponse({ answers: { ad_0: { noul: "high" }, ad_1: { noul: 0.1 } } }, request));
});
