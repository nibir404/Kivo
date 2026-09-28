import type { Endpoint, ServiceSpec } from "@kivo/core/types"
import type { WsContext } from "./model"

/** Facts several workspaces read from the same project. All derived; nothing here is invented. */

export interface ServiceEndpoint extends Endpoint {
  service: ServiceSpec
}

export function endpoints(ctx: WsContext): ServiceEndpoint[] {
  return ctx.services.flatMap((service) => service.api.endpoints.map((e) => ({ ...e, service })))
}

/** Routes that are meant to be reachable without a session. */
const PUBLIC_BY_DESIGN = /(login|signin|sign-in|register|signup|sign-up|refresh|token|reset|forgot|verify|health|docs|openapi|webhook)/i

export const isPublicByDesign = (path: string) => PUBLIC_BY_DESIGN.test(path)

export const mutating = (e: Endpoint) => e.method !== "GET"

export function datastores(ctx: WsContext) {
  return ctx.nodes.filter((n) => n.kind === "database" || n.kind === "cache" || n.kind === "queue")
}

/** Who talks to a node, from the system graph. */
export function usedBy(ctx: WsContext, id: string) {
  return ctx.edges
    .filter((e) => e.target === id)
    .map((e) => ctx.nodes.find((n) => n.id === e.source)?.label ?? e.source)
}

export const detected = (ctx: WsContext, ...tech: string[]) => ctx.analysis.detections.filter((d) => tech.includes(d.tech))

export const hasTech = (ctx: WsContext, ...tech: string[]) => detected(ctx, ...tech).length > 0

/** Service directories in the workspace, e.g. services/auth. */
export function serviceDir(ctx: WsContext, s: ServiceSpec) {
  const dir = `services/${s.id}/`
  return ctx.files.some((f) => f.startsWith(dir)) ? dir : undefined
}
