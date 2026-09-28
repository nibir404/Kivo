/** One browser-backend route: method, exact path, handler. */
export type Route = [method: string, path: string, handler: (req: Request, url: URL) => Promise<Response>]
