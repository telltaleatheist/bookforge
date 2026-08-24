/**
 * free-port — kill whatever is listening on the dev server's port, first.
 *
 * ── The consistent failure this ends (Owen, 2026-08-24) ─────────────────────
 *
 * `electron:dev` starts ng serve on 4260 and dies the moment anything already
 * holds it: *"Port 4260 is already in use"*, concurrently SIGTERMs the other
 * half, and the whole launch is over before a window exists. What holds the
 * port is never a stranger — 4260 is Foundry's own dedicated dev port — it is
 * a STALE COPY OF OURSELVES: an ng serve that outlived a crashed session, a
 * concurrently tree that half-died, a debugging session's background server
 * nobody remembered. Asking a person to hunt PIDs for a port they never chose
 * is the kind of chore this file exists to delete.
 *
 * SO THE LAUNCH FREES ITS OWN PORT. Anything listening on 4260 is a leftover
 * dev server by construction, and killing it is not a risk to reason about —
 * it is the cleanup the previous run owed and did not perform. The one thing
 * this script must never do is FAIL the launch: a port it could not free will
 * fail two commands later with ng's own perfectly clear sentence, so every
 * path here exits 0 and the worst outcome is exactly the old behaviour.
 *
 * CommonJS and dependency-free on purpose: it runs before anything is built,
 * from a package.json script, on whatever Node is present.
 */
'use strict';

const { execSync } = require('node:child_process');

const port = Number(process.argv[2] ?? '4260');
if (!Number.isInteger(port) || port <= 0) {
  console.error(`[free-port] "${process.argv[2]}" is not a port; nothing freed.`);
  process.exit(0);
}

/** The PIDs listening on the port, by the platform's own accounting. */
function listeners() {
  try {
    if (process.platform === 'win32') {
      // netstat lines: `  TCP    0.0.0.0:4260   0.0.0.0:0   LISTENING   12345`
      const out = execSync(`netstat -ano -p TCP | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const match = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line.trim());
        if (match && Number(match[1]) === port) pids.add(Number(match[2]));
      }
      return [...pids];
    }
    const out = execSync(`lsof -ti tcp:${port} -s tcp:LISTEN`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    // findstr/lsof exit non-zero when nothing matches, which is the good case.
    return [];
  }
}

for (const pid of listeners()) {
  // 0 and 4 are the kernel's own on Windows; killing them is not cleanup.
  if (!Number.isInteger(pid) || pid <= 4) continue;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    console.log(`[free-port] port ${port} was held by pid ${pid} — a stale dev server, now gone.`);
  } catch {
    console.log(`[free-port] pid ${pid} holds port ${port} and would not die; ng will say so next.`);
  }
}
