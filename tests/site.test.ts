import assert from "node:assert/strict";
import test from "node:test";
import { baseSiteKey, matchingSiteKey, siteMatches } from "../shared/site.js";

test("baseSiteKey strips only the www prefix", () => {
  assert.equal(baseSiteKey("www.footmercato.net"), "footmercato.net");
  assert.equal(baseSiteKey("sport.footmercato.net"), "sport.footmercato.net");
  assert.equal(baseSiteKey("127.0.0.1"), "127.0.0.1");
});

test("siteMatches covers the exact host and any subdomain depth", () => {
  assert.equal(siteMatches("footmercato.net", "footmercato.net"), true);
  assert.equal(siteMatches("sport.footmercato.net", "footmercato.net"), true);
  assert.equal(siteMatches("a.b.footmercato.net", "footmercato.net"), true);
  assert.equal(siteMatches("notfootmercato.net", "footmercato.net"), false);
  assert.equal(siteMatches("footmercato.net.evil.test", "footmercato.net"), false);
  assert.equal(siteMatches("sport.footmercato.net", "news.footmercato.net"), false);
});

test("matchingSiteKey returns the enabled key matching the host", () => {
  assert.equal(matchingSiteKey("sport.footmercato.net", { "footmercato.net": true }), "footmercato.net");
  assert.equal(matchingSiteKey("sport.footmercato.net", { "footmercato.net": false }), undefined);
  assert.equal(matchingSiteKey("example.test", { "footmercato.net": true }), undefined);
  assert.equal(matchingSiteKey("127.0.0.1", { "127.0.0.1": true }), "127.0.0.1");
});
