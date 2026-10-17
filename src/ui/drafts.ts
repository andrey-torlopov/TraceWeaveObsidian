export interface DraftPersistence {
  loadDrafts(projectId?: string): Promise<Record<string, unknown>>;
  saveDraft(key: string, value: unknown | null): Promise<void>;
}
export interface DraftStatus { hydrated: boolean; loading: boolean; pending: number; error: string | null; saved: boolean }
interface PendingWrite { version: number; value: unknown | null }
const EMPTY_STATUS: DraftStatus = Object.freeze({ hydrated: false, loading: false, pending: 0, error: null, saved: false });
const FORMAT = 'traceweave.metadata-draft';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Shared view drafts. Only the host persistence API writes the centralized technical folder. */
export class MetadataDraftStore {
  private readonly drafts = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private readonly touched = new Set<string>();
  private readonly restored = new Set<string>();
  private readonly statuses = new Map<string, DraftStatus>();
  private readonly hydration = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, PendingWrite>();
  private persistence: DraftPersistence | null = null;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  get<T>(key: string): T | undefined { return this.drafts.get(key) as T | undefined; }
  has(key: string): boolean { return this.drafts.has(key); }
  hasPrefix(prefix: string): boolean { return [...this.drafts.keys()].some((key) => key === prefix || key.startsWith(`${prefix}/`)); }
  hasRestoredPrefix(prefix: string): boolean { return [...this.restored].some((key) => key === prefix || key.startsWith(`${prefix}/`)); }
  status(projectId: string): DraftStatus { return this.statuses.get(projectId) ?? EMPTY_STATUS; }
  set<T>(key: string, value: T): void {
    this.drafts.set(key, value); this.touched.add(key); this.restored.delete(key);
    this.queue(key, { format: FORMAT, value }); this.notify();
  }
  clear(key: string): void { this.drafts.delete(key); this.touched.add(key); this.restored.delete(key); this.queue(key, null); this.notify(); }
  clearPrefix(prefix: string): void {
    const keys = [...this.drafts.keys()].filter((key) => key === prefix || key.startsWith(`${prefix}/`));
    // Prefix tombstones prevent a slow load from resurrecting a discarded draft.
    this.touched.add(`${prefix}/`);
    for (const key of keys) this.clear(key);
    if (!keys.length) this.notify();
  }
  hydrate(persistence: DraftPersistence, projectId: string): Promise<void> {
    this.persistence = persistence;
    if (this.status(projectId).hydrated) return Promise.resolve();
    const previous = this.hydration.get(projectId); if (previous) return previous;
    this.updateStatus(projectId, { loading: true, error: null });
    const work = persistence.loadDrafts(projectId).then((records) => {
      for (const [key, record] of Object.entries(records)) {
        if (!key.startsWith(`${projectId}/`)) throw new Error('Черновик относится к другому исследованию.');
        if (!record || typeof record !== 'object' || Array.isArray(record) || (record as Record<string, unknown>).format !== FORMAT || !Object.hasOwn(record, 'value')) throw new Error('Неизвестный формат черновика метаданных.');
        const touched = this.touched.has(key) || [...this.touched].some((prefix) => prefix.endsWith('/') && key.startsWith(prefix));
        if (!touched && !this.drafts.has(key)) { this.drafts.set(key, (record as { value: unknown }).value); this.restored.add(key); }
        else if (touched && !this.drafts.has(key) && !this.pending.has(key)) this.queue(key, null);
      }
      this.updateStatus(projectId, { hydrated: true, loading: false, error: null, saved: this.countPending(projectId) === 0 });
      this.notify();
      if (this.countPending(projectId)) this.schedule();
    }).catch((error: unknown) => {
      this.updateStatus(projectId, { loading: false, error: message(error) }); throw error;
    }).finally(() => { this.hydration.delete(projectId); });
    this.hydration.set(projectId, work); return work;
  }
  async flush(projectId?: string): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.persistence) return;
    if (this.flushing) { await this.flushing; if (this.hasPending(projectId)) return this.flush(projectId); return; }
    const persistence = this.persistence;
    const work = (async () => {
      const failed = new Set<string>(), failedScopes = new Set<string>(); let firstError: unknown;
      while (this.hasPending(projectId)) {
        const entry = [...this.pending].find(([key]) => !failed.has(key) && (!projectId || key.startsWith(`${projectId}/`)));
        if (!entry) break;
        const [key, write] = entry, scope = key.split('/')[0]!;
        try {
          await persistence.saveDraft(key, write.value);
          if (this.pending.get(key)?.version === write.version) this.pending.delete(key);
          this.updateStatus(scope, { ...(!failedScopes.has(scope) ? { error: null } : {}), pending: this.countPending(scope), saved: this.countPending(scope) === 0 });
        } catch (error) {
          this.updateStatus(scope, { error: message(error), pending: this.countPending(scope), saved: false });
          failed.add(key); failedScopes.add(scope); firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })();
    this.flushing = work;
    try { await work; } finally { this.flushing = null; }
  }
  private queue(key: string, value: unknown | null): void {
    const projectId = key.split('/')[0]!;
    if (projectId === 'vault') return; // No project exists yet; its creation form is kept in memory.
    this.pending.set(key, { version: ++this.version, value });
    this.updateStatus(projectId, { pending: this.countPending(projectId), saved: false });
    if (this.persistence) this.schedule();
  }
  private countPending(projectId: string): number { return [...this.pending.keys()].filter((key) => key.startsWith(`${projectId}/`)).length; }
  private hasPending(projectId?: string): boolean { return projectId ? this.countPending(projectId) > 0 : this.pending.size > 0; }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => { /* flush exposes the exact failure through the subscribed status. */ }); }, 150);
  }
  private updateStatus(projectId: string, changes: Partial<DraftStatus>): void {
    this.statuses.set(projectId, { ...this.status(projectId), ...changes }); this.notify();
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}

const stores = new WeakMap<object, MetadataDraftStore>();
export function metadataDrafts(service: object): MetadataDraftStore {
  let store = stores.get(service);
  if (!store) { store = new MetadataDraftStore(); stores.set(service, store); }
  return store;
}
