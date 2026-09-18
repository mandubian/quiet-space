import assert from "node:assert/strict";
import test from "node:test";
import { VerdictCache } from "../extension/verdicts.js";

function mockStorage(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) store.set(k, v); },
    dump: () => store,
  };
}

test("verdicts persist to storage and reload across cache instances", async () => {
  const storage = mockStorage();
  const first = await VerdictCache.load("example.test", storage);
  first.set("sig-a", 0.97);
  first.set("sig-b", 0.02);
  await first.save();
  const second = await VerdictCache.load("example.test", storage);
  assert.equal(second.get("sig-a"), 0.97);
  assert.equal(second.get("sig-b"), 0.02);
  assert.equal(second.get("sig-unknown"), undefined);
  const third = await VerdictCache.load("other.test", storage);
  assert.equal(third.get("sig-a"), undefined, "verdicts are scoped per site key");
});

test("stale entries are dropped on load and access", async () => {
  const stale = Date.now() - 8 * 24 * 3600 * 1000;
  const storage = mockStorage({ "verdicts:example.test": [["old-sig", 0.9, stale], ["fresh-sig", 0.5, Date.now()]] });
  const cache = await VerdictCache.load("example.test", storage);
  assert.equal(cache.get("old-sig"), undefined);
  assert.equal(cache.get("fresh-sig"), 0.5);
  assert.equal(cache.size, 1);
});

test("cache prunes oldest entries beyond the cap", async () => {
  const storage = mockStorage();
  const cache = await VerdictCache.load("example.test", storage);
  for (let index = 0; index < 310; index++) cache.set(`sig-${index}`, 0.5);
  assert.equal(cache.size <= 300, true);
  assert.equal(cache.get("sig-0"), undefined, "oldest entry pruned");
  assert.equal(cache.get("sig-309"), 0.5);
  await cache.save();
  const reloaded = await VerdictCache.load("example.test", storage);
  assert.equal(reloaded.get("sig-309"), 0.5);
});

test("unreadable storage starts an empty cache instead of throwing", async () => {
  const cache = await VerdictCache.load("example.test", {
    get: async () => { throw new Error("boom"); },
    set: async () => {},
  });
  assert.equal(cache.size, 0);
  cache.set("sig", 0.9);
  assert.equal(cache.get("sig"), 0.9);
});
