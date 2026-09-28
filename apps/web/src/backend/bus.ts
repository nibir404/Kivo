/** The browser backend's event stream — what the daemon sends on /api/events (project switches, file changes). */

export type BackendEvent = { t: string; [k: string]: unknown }

const listeners = new Set<(e: BackendEvent) => void>()

export const bus = {
  emit(e: BackendEvent) {
    for (const l of listeners) l(e)
  },
  listen(fn: (e: BackendEvent) => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
}
