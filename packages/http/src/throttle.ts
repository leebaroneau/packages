// Client-side rate-limit throttles. Two strategies, one interface:
//
//   minIntervalThrottle  - fixed spacing between request starts (simple, blunt;
//                          crm-haverford's original 1.1s Cin7 pacing)
//   slidingWindowThrottle - N-per-second + M-per-minute sliding windows
//                          (faithful to caps documented as "3/sec, 60/min";
//                          ported from the quote-webhooks Cin7 client)
//
// Both serialize acquisitions FIFO so bursty callers cannot jump the queue.

export interface Throttle {
  /** Resolves when the caller may start its request. */
  acquire(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fixed minimum gap between request starts. */
export function minIntervalThrottle(minIntervalMs: number): Throttle {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error('minIntervalThrottle: minIntervalMs must be a finite number >= 0');
  }
  let lastStartAt = 0;
  let chain: Promise<void> = Promise.resolve();
  return {
    acquire(): Promise<void> {
      const turn = chain.then(async () => {
        const wait = lastStartAt + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastStartAt = Date.now();
      });
      // Failures cannot wedge the chain: acquire itself never rejects.
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

export interface SlidingWindowOptions {
  perSecond: number;
  perMinute: number;
}

/** Sliding one-second and one-minute windows over request start times. */
export function slidingWindowThrottle({ perSecond, perMinute }: SlidingWindowOptions): Throttle {
  if (!Number.isInteger(perSecond) || !Number.isInteger(perMinute) || perSecond < 1 || perMinute < 1) {
    throw new Error('slidingWindowThrottle: perSecond and perMinute must be integers >= 1');
  }
  const starts: number[] = [];
  let chain: Promise<void> = Promise.resolve();

  function delayUntilAllowed(now: number): number {
    // Drop entries older than the minute window.
    while (starts.length && now - starts[0] >= 60_000) starts.shift();
    let delay = 0;
    const secWindow = starts.filter((t) => now - t < 1_000);
    if (secWindow.length >= perSecond) {
      delay = Math.max(delay, 1_000 - (now - secWindow[0]));
    }
    if (starts.length >= perMinute) {
      delay = Math.max(delay, 60_000 - (now - starts[0]));
    }
    return delay;
  }

  return {
    acquire(): Promise<void> {
      const turn = chain.then(async () => {
        for (;;) {
          const wait = delayUntilAllowed(Date.now());
          if (wait <= 0) break;
          await sleep(wait);
        }
        starts.push(Date.now());
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}
