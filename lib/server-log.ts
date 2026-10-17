// Routes return generic errors to clients; this keeps the cause in the Worker
// log. Record only the error type and message, never request bodies, cookies,
// or credentials.
export function logServerError(operation: string, error: unknown) {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Non-error value of type ${typeof error}`;
  console.error(`[${operation}] ${detail}`);
}
