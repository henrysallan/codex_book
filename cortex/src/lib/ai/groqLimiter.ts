/**
 * Shared Groq rate limiter — serialises all Groq API calls with a minimum
 * gap between them to stay safely under the 30 RPM free-tier limit.
 *
 * Used by summarize.ts and router.ts (every module that calls the Groq SDK).
 *
 * Additionally retries on 429 (rate limit) responses with exponential backoff
 * so a transient burst never causes a hard failure.
 */

// 2.5 s gap → 24 calls/min, safely under the 30 RPM limit with headroom
// for the chat router to also use Groq concurrently.
const MIN_GAP_MS = 2_500;
const MAX_RETRIES = 4;

let _queue: Promise<void> = Promise.resolve();

/**
 * Execute `fn` through a serial queue with a minimum inter-call gap.
 * If `fn` throws a 429, retries with exponential backoff.
 */
export function groqLimited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    _queue = _queue.then(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await fn();
          // Enforce minimum gap before next queued call
          await sleep(MIN_GAP_MS);
          resolve(result);
          return;
        } catch (err: unknown) {
          lastErr = err;
          const status = (err as { status?: number })?.status;
          if (status === 429 && attempt < MAX_RETRIES) {
            const delay = 2_000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
            console.warn(
              `[groqLimiter] 429 rate limit hit, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
            );
            await sleep(delay);
            continue;
          }
          break;
        }
      }
      reject(lastErr);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
