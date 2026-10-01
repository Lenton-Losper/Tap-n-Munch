/**
 * BOUNDED FAN-OUT FOR BATCHED READS (perf/latency-sprint, 2026-10-01).
 *
 * The worker runs next to the terminal (JNB/WDH) and the database in Ireland, so every SEQUENTIAL
 * round trip costs ~200 ms while the query itself takes <1 ms. A `for (...) await` over N batches
 * is N x 200 ms; firing them together is ~1 x 200 ms.
 *
 * BOUNDED, NOT `Promise.all(items.map(...))`: a Workers invocation holds at most six simultaneous
 * open connections and queues the rest, so unbounded fan-out buys nothing past six and hides how
 * many requests one call really makes. DEFAULT_CONCURRENCY is that limit.
 *
 * ORDER IS PRESERVED: results come back in `items` order regardless of completion order, so a caller
 * that concatenated batch results in sequence gets the identical array.
 *
 * FAILURE: the first rejection rejects the whole call (as the sequential loop's first throw did);
 * no further items are STARTED after it. Items already in flight finish in the background and their
 * results are discarded -- callers here only read.
 */
export const DEFAULT_CONCURRENCY = 6

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
