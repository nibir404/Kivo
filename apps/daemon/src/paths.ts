import path from "node:path"

/**
 * Filesystem locations the daemon depends on. Resolved from this file rather than the working
 * directory, so the daemon behaves the same whether it's started from the repo root, from
 * apps/daemon, or by a process manager.
 */

/** apps/daemon */
export const DAEMON_ROOT = path.resolve(import.meta.dirname, "..")
/** The repository root (holds .env and, by default, .kivo-workspace). */
export const REPO_ROOT = path.resolve(DAEMON_ROOT, "../..")
/** The built web UI served by `--serve`. KIVO_WEB_DIST points it elsewhere (e.g. a packaged build). */
export const WEB_DIST = process.env.KIVO_WEB_DIST ? path.resolve(process.env.KIVO_WEB_DIST) : path.join(REPO_ROOT, "apps/web/dist")
