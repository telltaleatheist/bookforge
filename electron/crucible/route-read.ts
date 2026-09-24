/**
 * READ AN ENGINE'S ROUTES BECAUSE THE QUEUE NEEDS THEM, not because a connect happened.
 *
 * ── The defect (Owen, 2026-09-24) ─────────────────────────────────────────
 *
 * BookForge started with the PC's server switched off, so the startup read asked
 * only the Mac. The PC was switched on four minutes later. The switch-on path is
 * supposed to coordinate, and coordination reads `GET /v1/capability`, which
 * fills `crucible/routes.ts`. It stopped before that read and said nothing. A
 * translate row placed on the PC was held at "has not yet read where … runs …
 * work. It asks that engine on every connect". No further connect was coming,
 * so it waited forever.
 *
 * The record's design relied on SOMEBODY ELSE reading at the right moment.
 * When that somebody fails, the row is stranded. So the one party that knows a
 * read is needed, the queue meeting an `unknown` route, now asks for it.
 *
 * ── Weather, so it gets a budget and a wait ───────────────────────────────
 *
 * A machine that was just switched on, a WSL guest still starting, a Mac on a
 * busy tailnet: these are transient, and none of them is misconfiguration. So
 * one read cycle tries until {@link ROUTE_READ_BUDGET_MS} is spent, each
 * attempt bounded by {@link ROUTE_READ_ATTEMPT_MS}, backing off between tries.
 * When the budget is spent it records WHY in the routes record
 * (`noteCrucibleRouteReadFailed`), so the held row says so, and it logs it.
 * The queue's own admission re-check keeps pumping. The next cycle starts no
 * sooner than {@link ROUTE_READ_COOLDOWN_MS} after the last one gave up, so a
 * server that is down costs one read cycle per cooldown, not one per pump.
 *
 * ── One read per server at a time ─────────────────────────────────────────
 *
 * The pump runs often, and every held row on the same server would otherwise
 * start its own read. `inFlight` makes all of them one read.
 */
import { crucibleCapabilityWithRoutes } from './engine-settings';
import { noteCrucibleRouteReadFailed } from './routes';

/** How long one read cycle keeps trying before it records a failure. */
export const ROUTE_READ_BUDGET_MS = 60_000;
/** The bound on one `GET /v1/capability`. */
export const ROUTE_READ_ATTEMPT_MS = 10_000;
/** How soon after a failed cycle the next one may start. */
export const ROUTE_READ_COOLDOWN_MS = 30_000;

const inFlight = new Map<string, Promise<void>>();
const gaveUpAt = new Map<string, number>();

type Log = (level: 'info' | 'warn', message: string) => void;

/**
 * Start a read of `server`'s routes, unless one is running or one gave up
 * within the cooldown. Never throws: its outcome lands in the routes record
 * (the routes on success, the reason on failure), and in the log.
 */
export function readCrucibleRoutes(server: string, because: string, log: Log): void {
  if (inFlight.has(server)) return;
  const last = gaveUpAt.get(server);
  if (last !== undefined && Date.now() - last < ROUTE_READ_COOLDOWN_MS) return;
  const cycle = runCycle(server, because, log).finally(() => { inFlight.delete(server); });
  inFlight.set(server, cycle);
}

async function runCycle(server: string, because: string, log: Log): Promise<void> {
  const deadline = Date.now() + ROUTE_READ_BUDGET_MS;
  let attempt = 0;
  let lastError = '';
  for (;;) {
    attempt += 1;
    try {
      // The one funnel every capability read passes through: it records the
      // routes and the served classes as it returns.
      await crucibleCapabilityWithRoutes(server, ROUTE_READ_ATTEMPT_MS);
      gaveUpAt.delete(server);
      log('info', `Read where Crucible "${server}" runs each class (${because}; attempt ${attempt}).`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    const backoff = Math.min(2_000 * 2 ** (attempt - 1), 15_000);
    if (Date.now() + backoff >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
  gaveUpAt.set(server, Date.now());
  const reason = `${attempt} attempt(s) over ${Math.round(ROUTE_READ_BUDGET_MS / 1000)} s failed; `
    + `the last said: ${lastError}`;
  noteCrucibleRouteReadFailed(server, reason);
  log('warn', `Could not read where Crucible "${server}" runs each class (${because}): ${reason}. `
    + `Asking again in ${Math.round(ROUTE_READ_COOLDOWN_MS / 1000)} s while a row still waits on it.`);
}
