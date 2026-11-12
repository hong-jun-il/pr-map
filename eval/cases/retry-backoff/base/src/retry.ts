export const MAX_ATTEMPTS = 3;

export async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
