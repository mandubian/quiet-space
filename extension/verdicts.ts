export interface VerdictEntry { probability: number; time: number }

const VERDICT_TTL_MS = 7 * 24 * 3600 * 1000;
const VERDICT_MAX_ENTRIES = 300;

type StorageLike = { get: (key: string) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void> };

export class VerdictCache {
  private entries = new Map<string, VerdictEntry>();

  private constructor(private hostKey: string, private storage: StorageLike) {}

  static async load(hostKey: string, storage?: StorageLike): Promise<VerdictCache> {
    const backend: StorageLike = storage ?? {
      get: (key) => chrome.storage.local.get(key),
      set: (items) => chrome.storage.local.set(items),
    };
    const cache = new VerdictCache(hostKey, backend);
    const storeKey = `verdicts:${hostKey}`;
    try {
      const stored = await backend.get(storeKey);
      const list = stored[storeKey];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number" && typeof entry[2] === "number" && Date.now() - entry[2] < VERDICT_TTL_MS) {
            cache.entries.set(entry[0], { probability: entry[1], time: entry[2] });
          }
        }
      }
    } catch { /* unreadable storage starts an empty cache */ }
    return cache;
  }

  get(signature: string): number | undefined {
    const entry = this.entries.get(signature);
    if (!entry) return undefined;
    if (Date.now() - entry.time > VERDICT_TTL_MS) {
      this.entries.delete(signature);
      return undefined;
    }
    return entry.probability;
  }

  set(signature: string, probability: number): void {
    this.entries.set(signature, { probability, time: Date.now() });
    if (this.entries.size > VERDICT_MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].time - b[1].time).slice(0, this.entries.size - VERDICT_MAX_ENTRIES);
      for (const [key] of oldest) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async save(): Promise<void> {
    const list = [...this.entries.entries()].map(([signature, entry]) => [signature, entry.probability, entry.time]);
    try {
      await this.storage.set({ [`verdicts:${this.hostKey}`]: list });
    } catch { /* saving is best-effort */ }
  }
}
