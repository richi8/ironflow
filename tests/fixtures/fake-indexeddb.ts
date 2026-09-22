/**
 * Enough IndexedDB to test `IndexedDbSaveRepository` against. See C25.
 *
 * The plan asks for "quota and unavailability failure paths with a mocked
 * IDB", and a mock that only fails is a mock that never proves the happy path
 * works — so this is a small real implementation instead: object stores that
 * hold what was put in them, transactions that complete on a microtask, and
 * **rollback on abort**, which is the one behaviour the quota row of §14
 * depends on ("do not destroy the existing save by writing a truncated one").
 *
 * It is not a conformance implementation and does not try to be. Key ranges,
 * cursors, indexes, versions past 1 and `deleteDatabase` are all absent
 * because the repository uses none of them; anything it grows into will fail
 * loudly here rather than silently pass.
 *
 * The backing store survives `close()`, which is what makes "a factory
 * survives a full browser restart" testable: a second `open` over the same
 * `FakeIndexedDb` is a second session against the same disk.
 */

type Record_ = { readonly [key: string]: unknown };

class FakeObjectStore {
  readonly rows = new Map<string, Record_>();
  constructor(readonly keyPath: string) {}

  snapshot(): Map<string, Record_> {
    return new Map(this.rows);
  }

  restore(rows: Map<string, Record_>): void {
    this.rows.clear();
    for (const [key, value] of rows) this.rows.set(key, value);
  }
}

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
}

/** A `DOMException`-shaped error, which is how a browser reports a quota. */
export function quotaError(): Error {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private readonly queue: (() => void)[] = [];
  private readonly rollback = new Map<string, Map<string, Record_>>();
  private settled = false;

  constructor(
    private readonly db: FakeDatabase,
    names: readonly string[],
    readonly mode: string,
  ) {
    for (const name of names) {
      const store = this.db.store(name);
      this.rollback.set(name, store.snapshot());
    }
    queueMicrotask(() => this.drain());
  }

  objectStore(name: string): FakeStoreHandle {
    if (!this.rollback.has(name)) throw new Error(`NotFoundError: "${name}" is not in this transaction.`);
    return new FakeStoreHandle(this, this.db.store(name), name);
  }

  enqueue(work: () => void): void {
    this.queue.push(work);
  }

  abort(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    for (const [name, rows] of this.rollback) this.db.store(name).restore(rows);
    this.error = error ?? new Error('AbortError');
    this.onabort?.();
  }

  private drain(): void {
    while (!this.settled && this.queue.length > 0) {
      const work = this.queue.shift();
      work?.();
    }
    if (this.settled) return;
    this.settled = true;
    this.oncomplete?.();
  }
}

class FakeStoreHandle {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly store: FakeObjectStore,
    readonly name: string,
  ) {}

  put(value: Record_): FakeRequest<string> {
    const request = new FakeRequest<string>();
    this.tx.enqueue(() => {
      // A refused write aborts the whole transaction, which rolls back every
      // store it touched — §14's "do not destroy the existing save".
      if (currentFailure !== null) {
        this.tx.abort(currentFailure);
        return;
      }
      const key = String(value[this.store.keyPath]);
      this.store.rows.set(key, value);
      request.result = key;
    });
    return request;
  }

  get(key: string): FakeRequest<Record_ | undefined> {
    const request = new FakeRequest<Record_ | undefined>();
    this.tx.enqueue(() => {
      request.result = this.store.rows.get(key);
    });
    return request;
  }

  getAll(): FakeRequest<Record_[]> {
    const request = new FakeRequest<Record_[]>();
    this.tx.enqueue(() => {
      request.result = [...this.store.rows.values()];
    });
    return request;
  }

  delete(key: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.tx.enqueue(() => {
      this.store.rows.delete(key);
      request.result = undefined;
    });
    return request;
  }
}

/**
 * The write failure every store in the fake reports, or null.
 *
 * Module-level rather than per-database because a quota is a property of the
 * browser's disk, not of one database — and because the repository holds its
 * own connection, so a test cannot reach in and set a flag on it.
 */
let currentFailure: Error | null = null;

/** Make every subsequent write fail with `error`, or stop doing so with null. */
export function failWrites(error: Error | null): void {
  currentFailure = error;
}

class FakeDatabase {
  readonly stores = new Map<string, FakeObjectStore>();
  closed = false;

  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (name: string) => this.stores.has(name) };
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
    const store = new FakeObjectStore(options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  store(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (store === undefined) throw new Error(`NotFoundError: no object store "${name}".`);
    return store;
  }

  transaction(names: string[] | string, mode: string): FakeTransaction {
    if (this.closed) throw new Error('InvalidStateError: the database is closed.');
    return new FakeTransaction(this, typeof names === 'string' ? [names] : names, mode);
  }

  close(): void {
    this.closed = true;
  }
}

/** A whole browser's worth of IndexedDB, for one test. */
export class FakeIndexedDb {
  private readonly databases = new Map<string, FakeDatabase>();

  /** Refuse to open at all — private browsing, in one flag. */
  openFails = false;

  /** Report `blocked` rather than opening — another tab on an old schema. */
  openBlocks = false;

  open(name: string, _version?: number): FakeOpenRequest {
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      if (this.openFails) {
        request.error = new Error('InvalidStateError: storage is not available.');
        request.onerror?.();
        return;
      }
      if (this.openBlocks) {
        request.onblocked?.();
        return;
      }
      const existing = this.databases.get(name);
      // A database that was closed is reopened over the same stores, which is
      // what makes a second `open` a second session against the same disk.
      const db = existing ?? new FakeDatabase();
      const fresh = existing === undefined;
      this.databases.set(name, db);
      db.closed = false;
      request.result = db as unknown as IDBDatabase;
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }

  /** The repository takes an `IDBFactory`; this is the one line that says so. */
  asFactory(): IDBFactory {
    return this as unknown as IDBFactory;
  }

  /** How many rows a store holds, without going through the repository. */
  rowCount(database: string, store: string): number {
    return this.databases.get(database)?.stores.get(store)?.rows.size ?? 0;
  }

  /** One stored row, for a test that wants to look at what was written. */
  row(database: string, store: string, key: string): unknown {
    return this.databases.get(database)?.stores.get(store)?.rows.get(key);
  }
}

class FakeOpenRequest {
  result!: IDBDatabase;
  error: Error | null = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}
