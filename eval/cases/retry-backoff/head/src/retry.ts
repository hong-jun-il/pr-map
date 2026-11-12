import { sleep } from "./sleep";

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 200;

export function isRetryable(err: unknown): boolean {
  return err instanceof Error && err.name !== "AbortError";
}

export async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}
