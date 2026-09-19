import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReading, applyQuietReading, exitQuietReading, isReadingActive } from "../extension/reading.js";
import { JSDOM } from "jsdom";

const FIXTURE = `<body>
<nav id="site-nav"><a href="/a">Home</a><a href="/b">World</a></nav>
<div class="cookie-banner">We use cookies to improve your experience. Accept or manage preferences.</div>
<article id="story">
<h1>Deep dive: the quiet architecture</h1>
<p>The city council approved the plan after a long debate that stretched late into Tuesday evening, drawing residents from every district.</p>
<p>Officials said the next phase would begin in spring, with funding already allocated and contractors selected through an open tender process.</p>
<p>Residents responded positively, though some raised concerns about traffic, noise during construction, and the loss of the old marketplace square.</p>
</article>
<div id="extra-part" class="layout-column"><p>Second part of the story continues here with substantial reporting text that the reader came for and would want to keep visible while reading.</p></div>
<aside id="related" class="related-stories"><a href="/r1">Related: something else happened</a><a href="/r2">More: another story entirely</a></aside>
<section id="comments"><p>I totally disagree with this article.</p><p>Great reporting, keep it up!</p></section>
</body>`;

function readingWindow(): JSDOM["window"] {
  const window = new JSDOM(FIXTURE, { url: "https://example.test/article" }).window;
  window.document.querySelectorAll<HTMLElement>("nav, div, aside, section, article").forEach((node) => {
    node.getBoundingClientRect = function () {
      return { width: 700, height: 200, top: 0, bottom: 200, left: 0, right: 700, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  });
  return window;
}

test("analysis keeps the article and flags nav, banner, related, and comments", () => {
  const window = readingWindow();
  const { keep, hideNow, ambiguous } = analyzeReading(window.document);
  assert.equal(keep?.id, "story");
  const hiddenIds = hideNow.map((node) => node.id);
  assert.ok(hiddenIds.includes("site-nav"), "nav must be deterministic noise");
  assert.ok(hiddenIds.includes("related"), "related stories must be deterministic noise");
  assert.ok(hiddenIds.includes("comments"), "comments must be deterministic noise");
  const ambiguousIds = ambiguous.map((node) => node.id);
  assert.ok(ambiguousIds.includes("extra-part"), "neutral container needs Jev judgment");
  window.close();
});

test("apply hides deterministic noise and Jev-confirmed noise, restores on exit", async () => {
  const window = readingWindow();
  const document = window.document;
  const classify = async () => ({ decisions: [{ id: "r-0", probability: 0.2 }] });
  const summary = await applyQuietReading(document, { threshold: 0.95, classify });
  assert.equal(summary.active, true);
  assert.ok(summary.hidden >= 4, "nav + banner + related + comments + confirmed noise hidden");
  assert.equal(document.getElementById("site-nav")!.style.display, "none");
  assert.equal(document.getElementById("comments")!.style.display, "none");
  assert.equal(document.getElementById("extra-part")!.style.display, "none", "Jev-confirmed noise hidden");
  assert.equal(document.getElementById("story")!.style.display, "");
  assert.ok(document.querySelector("[data-qs-reading-bar]"), "exit bar must be visible");
  assert.equal(isReadingActive(), true);
  const restored = exitQuietReading();
  assert.ok(restored >= 4);
  assert.equal(document.getElementById("site-nav")!.style.display, "");
  assert.equal(isReadingActive(), false);
  window.close();
});

test("toggle: applying twice exits reading mode", async () => {
  const window = readingWindow();
  const document = window.document;
  const classify = async () => ({ answers: { ad_0: { type: "noul", noul: 0.2 } } });
  await applyQuietReading(document, { threshold: 0.95, classify });
  const second = await applyQuietReading(document, { threshold: 0.95, classify });
  assert.equal(second.active, false);
  assert.equal(document.getElementById("site-nav")!.style.display, "");
  window.close();
});

test("classification failure fails visible: nothing ambiguous stays hidden", async () => {
  const window = readingWindow();
  const document = window.document;
  const summary = await applyQuietReading(document, {
    threshold: 0.95,
    classify: async () => ({ error: "TypeSafe API error (401)" }),
  });
  assert.ok(summary.error, "classification error must surface");
  assert.equal(document.getElementById("extra-part")!.style.display, "", "ambiguous blocks must stay visible on failure");
  assert.equal(document.getElementById("site-nav")!.style.display, "none", "deterministic noise stays hidden");
  exitQuietReading();
  assert.equal(document.getElementById("site-nav")!.style.display, "");
  window.close();
});
