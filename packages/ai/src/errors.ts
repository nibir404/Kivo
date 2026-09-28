/** An error with an HTTP status the client should see (4xx), as opposed to a crash (500). */
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
