/** Errors that map to RFC 9457 problem+json responses. Throw these from handlers. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, detail?: unknown) =>
  new AppError(400, 'bad_request', message, detail);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, detail?: unknown) => new AppError(409, 'conflict', message, detail);
export const unprocessable = (message: string, detail?: unknown) =>
  new AppError(422, 'unprocessable', message, detail);
export const upstream = (message: string, detail?: unknown) =>
  new AppError(502, 'upstream_error', message, detail);

/** Assert a row exists, otherwise 404. */
export function must<T>(row: T | undefined | null, what = 'Resource'): T {
  if (row === undefined || row === null) throw notFound(what);
  return row;
}
