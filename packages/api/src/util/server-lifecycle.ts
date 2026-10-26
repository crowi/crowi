import type http from 'node:http';
import type Crowi from 'src/crowi';
import { createShutdownHandler, type ShutdownCrowi } from './process-boundary';

export const SERVER_DRAIN_GRACE_MS = 8_000;

/** Not exported: only the idle-connection re-close cadence. */
const IDLE_SWEEP_INTERVAL_MS = 100;

export type ServerLifecycleCrowi = ShutdownCrowi & Pick<Crowi, 'drainSideEffects'>;

export interface ServerLifecycleOptions {
  graceMs?: number;
  exit?: (code: number) => void;
}

export interface ServerLifecycle {
  attach(server: http.Server): void;
  onSignal(signal: NodeJS.Signals): Promise<void>;
}

const drainingCrowis = new WeakSet<object>();

export function isServerDraining(crowi: object): boolean {
  return drainingCrowis.has(crowi);
}

export function createServerLifecycle(crowi: ServerLifecycleCrowi, options: ServerLifecycleOptions = {}): ServerLifecycle {
  const graceMs = options.graceMs ?? SERVER_DRAIN_GRACE_MS;
  const shutdownWebSockets = createShutdownHandler(crowi, () => {});
  let server: http.Server | null = null;
  let signalled = false;

  // Resolves true when `p` settled first, false when the deadline timer won.
  const raceDeadline = async (p: Promise<unknown>, deadline: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([p.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    attach(s) {
      server = s;
      if (signalled) {
        s.close();
        s.closeIdleConnections();
      }
    },

    async onSignal(signal) {
      if (signalled) return;
      signalled = true;
      drainingCrowis.add(crowi);
      const deadline = Date.now() + graceMs;

      const current = server;
      let sweep: NodeJS.Timeout | undefined;
      let closed: Promise<void>;
      if (current) {
        closed = new Promise<void>((resolve) => {
          current.close(() => resolve());
        });
        // A keep-alive socket that was busy at close() time stays open after
        // its response until keepAliveTimeout; sweeping releases it at once.
        sweep = setInterval(() => current.closeIdleConnections(), IDLE_SWEEP_INTERVAL_MS);
      } else {
        closed = Promise.resolve();
      }

      try {
        await shutdownWebSockets(signal);
        const closedInTime = await raceDeadline(closed, deadline);
        clearInterval(sweep);
        if (!closedInTime) {
          current?.closeAllConnections();
        } else if (deadline - Date.now() > 0) {
          await raceDeadline(
            crowi.drainSideEffects().catch(() => {}),
            deadline,
          );
        }
      } finally {
        clearInterval(sweep);
        (options.exit ?? ((code: number) => process.exit(code)))(0);
      }
    },
  };
}
