import { EventEmitter } from "node:events"

/** Process-wide events pushed to the UI over /api/events (e.g. live logs from running services). */
export const bus = new EventEmitter()
bus.setMaxListeners(50)
