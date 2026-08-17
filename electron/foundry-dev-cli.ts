/**
 * foundry-dev-cli — point a DEV run at a locally-built foundry binary.
 *
 * This is all that remains of `foundry-interim-config`, which used to hold the
 * GGUF paths BookForge passed to foundry's model stages with `--base-model`.
 * Those went when foundry started resolving its own weights, and the stages
 * themselves went in Aug 2026 — there is no model stage, no catalog and no
 * `models` command left on either side. The dev-binary nudge outlived all of it
 * because it was never interim — it is a permanent convenience for the one
 * machine that compiles foundry — and a file called "interim-config" holding
 * only a thing that is not interim is a name that lies.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where a dev checkout of foundry compiles its host binary.
 *
 * The name is the BUILD's spelling, not Node's: foundry's release-build.sh
 * writes `foundry-windows-x64.exe` (the bun target is `windows` and Windows
 * binaries carry `.exe`), while `process.platform` says `win32` and no
 * extension. The old candidates used the latter, so on Windows this prime
 * NEVER found the freshly built engine and the resolver fell through to the
 * installed component — a months-old release whose engine predates `vlm-read`,
 * which is exactly the stale binary the hosted Foundry window then spawned
 * (found live 2026-08-17, first hosted import).
 */
const DEV_BINARY_NAME = process.platform === 'win32'
  ? `foundry-windows-${process.arch}.exe`
  : `foundry-${process.platform}-${process.arch}`;
const DEV_CLI_CANDIDATES = [
  path.join('/Volumes/Callisto/Projects/foundry', 'dist', DEV_BINARY_NAME),
  path.join(os.homedir(), 'Projects', 'foundry', 'dist', DEV_BINARY_NAME),
];

/**
 * In a dev run, point `FOUNDRY_CLI_PATH` at the locally-built binary — unless
 * the developer already set it, in which case theirs wins untouched.
 *
 * This is deliberately a nudge to the ENVIRONMENT and not a third branch inside
 * `foundry-bridge.resolveFoundryPath`. The bridge's rule — env var, then the
 * installed component, and no PATH search — is a rule about not running an
 * unknown build, and it stays exactly two sources. What this does is spare the
 * owner from prefixing every `npm run electron:dev` with a path, which is the
 * kind of friction that ends with someone testing yesterday's binary.
 *
 * It logs whichever way it goes. A silent environment mutation is worse than no
 * convenience at all: the one question that matters when a run behaves oddly is
 * *which binary answered*, and it must be in the log.
 *
 * Packaged builds do not call this — there the component (or the user's own
 * FOUNDRY_CLI_PATH) is the only source, which is what shipping demands.
 */
export function primeFoundryDevCliPath(): void {
  const existing = process.env['FOUNDRY_CLI_PATH']?.trim();
  if (existing) {
    console.log(`[foundry] FOUNDRY_CLI_PATH already set: ${existing}`);
    return;
  }
  for (const candidate of DEV_CLI_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      process.env['FOUNDRY_CLI_PATH'] = candidate;
      console.log(`[foundry] dev binary: ${candidate}`);
      return;
    } catch {
      /* not this one */
    }
  }
  console.warn(
    '[foundry] No foundry binary found for development. Checked:\n'
    + DEV_CLI_CANDIDATES.map((c) => `  ${c}`).join('\n')
    + '\nBuild one with `tools/release-build.sh host` in the foundry checkout, '
    + 'or set FOUNDRY_CLI_PATH. A conversion will report this rather than falling back.'
  );
}
