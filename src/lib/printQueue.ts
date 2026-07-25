/**
 * Serializes all receipt / test print jobs (built-in and Bluetooth) so only one
 * transport operation runs at a time.
 *
 * Hard timeouts: a hung native SDK call must not leave staff staring at a spinner.
 */

const LOCK_WAIT_MS = 12_000;
const JOB_TIMEOUT_MS = 15_000;

let queueTail: Promise<unknown> = Promise.resolve();

function timeoutError(code: string, message: string): Error & {code: string} {
  const err = new Error(message) as Error & {code: string};
  err.code = code;
  return err;
}

function rejectAfter(ms: number, code: string, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(timeoutError(code, message)), ms);
  });
}

/** Break a stuck chain so the next withPrintLock can proceed. */
export function resetPrintQueue(): void {
  queueTail = Promise.resolve();
}

export async function withPrintLock<T>(job: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });

  const previous = queueTail;
  queueTail = previous.then(
    () => gate,
    () => gate,
  );

  try {
    await Promise.race([
      previous.then(
        () => undefined,
        () => undefined,
      ),
      rejectAfter(LOCK_WAIT_MS, 'PRINT_FAILED', 'Printer is busy. Try again.'),
    ]);
  } catch (err) {
    resetPrintQueue();
    release();
    throw err;
  }

  try {
    return await Promise.race([
      job(),
      rejectAfter(
        JOB_TIMEOUT_MS,
        'PRINT_FAILED',
        'Print timed out waiting for the printer',
      ),
    ]);
  } catch (err) {
    resetPrintQueue();
    throw err;
  } finally {
    release();
  }
}
