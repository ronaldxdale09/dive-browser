export interface AvatarInput { kind: "profile" | "workspace"; seed: string; color: string }
interface AvatarWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
}
// Bump when generator options or DiceBear versions change; saved seeds stay authoritative.
const STORAGE_KEY = "dive:avatar:9.4.3-v1";
const MAX_URL = 65536;
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 128;
const validUrl = (value: unknown): value is string => typeof value === "string" && value.startsWith("data:image/svg+xml;") && value.length <= MAX_URL;
export const avatarKey = (input: AvatarInput): string => JSON.stringify([input.kind, input.seed, input.color]);

/** Artwork is an expendable, bounded cache. Seeds/colors remain in the browser store.
 * No generator or worker is loaded by get(); misses run after paint in one worker. */
export class AvatarCache {
  private memory = new Map<string, string>();
  private hydrated = false;
  private pending = new Map<string, { input: AvatarInput; promise: Promise<string | undefined>; resolve(value: string | undefined): void }>();
  private worker: AvatarWorker | undefined;
  private scheduled = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private createWorker: () => AvatarWorker, private storage: () => Storage | null, private defer: (run: () => void) => void) {}

  get(input: AvatarInput): string | undefined {
    const key = avatarKey(input);
    const hit = this.memory.get(key);
    if (hit) return hit;
    if (!this.hydrated) {
      this.hydrated = true;
      for (const [savedKey, url] of this.readSaved()) this.remember(savedKey, url);
      return this.memory.get(key);
    }
    return undefined;
  }

  load(input: AvatarInput): Promise<string | undefined> {
    const hit = this.get(input);
    if (hit) return Promise.resolve(hit);
    const key = avatarKey(input);
    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    // Rapid picker changes cannot queue unlimited generation work.
    if (key.length > 4096 || this.pending.size >= MAX_ENTRIES) return Promise.resolve(undefined);
    let resolve!: (value: string | undefined) => void;
    const promise = new Promise<string | undefined>((done) => { resolve = done; });
    this.pending.set(key, { input, promise, resolve });
    clearTimeout(this.idle);
    if (this.worker) this.send(key, input);
    else if (!this.scheduled) {
      this.scheduled = true;
      this.defer(() => this.start());
    }
    return promise;
  }

  private start() {
    this.scheduled = false;
    if (!this.pending.size) return;
    const generation = ++this.generation;
    try {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (generation !== this.generation || typeof data !== "object" || !data) return;
        const { key, url } = data as { key?: unknown; url?: unknown };
        if (typeof key !== "string") return;
        const job = this.pending.get(key);
        if (!job) return;
        const result = validUrl(url) ? url : undefined;
        if (result) { this.remember(key, result); this.persist(key, result); }
        this.pending.delete(key);
        job.resolve(result);
        if (!this.pending.size) {
          clearTimeout(this.deadline);
          this.deadline = undefined;
          this.idle = setTimeout(() => this.stop(), 5000);
        }
      };
      worker.onerror = worker.onmessageerror = () => this.stop();
      for (const [key, job] of this.pending) this.send(key, job.input);
    } catch { this.stop(); }
  }

  private send(key: string, input: AvatarInput) {
    if (!this.deadline) this.deadline = setTimeout(() => this.stop(), 10000);
    try { this.worker?.postMessage({ key, ...input }); } catch { this.stop(); }
  }

  private stop() {
    ++this.generation;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
    this.deadline = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    for (const job of this.pending.values()) job.resolve(undefined);
    this.pending.clear();
  }

  private remember(key: string, url: string) {
    this.memory.delete(key);
    this.memory.set(key, url);
    let bytes = Array.from(this.memory.values()).reduce((sum, value) => sum + value.length, 0);
    while (this.memory.size > MAX_ENTRIES || bytes > MAX_BYTES) {
      const oldest = this.memory.entries().next().value!;
      bytes -= oldest[1].length;
      this.memory.delete(oldest[0]);
    }
  }

  private readSaved(): [string, string][] {
    try {
      const raw = this.storage()?.getItem(STORAGE_KEY);
      if (!raw || raw.length > MAX_BYTES) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && v[0].length <= 4096 && validUrl(v[1])).slice(-MAX_ENTRIES) : [];
    } catch { return []; }
  }

  private persist(key: string, url: string) {
    try {
      const storage = this.storage();
      if (!storage) return;
      // One atomic bounded record: failed writes and competing popout writers
      // may lose a cache hit, but can never leave unindexed artwork behind.
      const entries = this.readSaved().filter(([old]) => old !== key);
      entries.push([key, url]);
      let encoded = JSON.stringify(entries);
      while (entries.length > MAX_ENTRIES || encoded.length > MAX_BYTES) {
        entries.shift();
        encoded = JSON.stringify(entries);
      }
      storage.setItem(STORAGE_KEY, encoded);
    } catch { /* The in-memory result still works if persistence is unavailable. */ }
  }
}
