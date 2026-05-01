/** Safely extract a message string from an unknown caught value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Coerce an unknown caught value to an Error instance. */
export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
