export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Request failed with status ${status}`);

    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}
