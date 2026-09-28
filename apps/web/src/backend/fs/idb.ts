/**
 * A tiny IndexedDB key-value store for the browser backend: the project list, folder handles
 * (structured-cloneable, so a picked folder is remembered across visits) and the demo's files.
 */

const DB = "kivo"
const STORE = "kv"
let db: Promise<IDBDatabase> | null = null

function open() {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable"))
  })
  return db
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await open()
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export const idb = {
  get: <T>(key: string) => tx<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (key: string, value: unknown) => tx("readwrite", (s) => s.put(value, key)).then(() => undefined),
  del: (key: string) => tx("readwrite", (s) => s.delete(key)).then(() => undefined),
}
