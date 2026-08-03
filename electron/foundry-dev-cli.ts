/**
 * foundry-dev-cli — point a DEV run at a locally-built foundry binary.
 *
 * This is all that remains of `foundry-interim-config`, which used to hold the
 * GGUF paths BookForge passed to foundry's model stages with `--base-model`.
 * Those are gone: foundry resolves every stage's weights from its OWN catalog
 * (`foundry models pull`, huggingface.co/owenmorgan/foundry-models), so there is
 * no interim configuration left to keep. The dev-binary nudge outlived it
 * because it was never interim — it is a permanent convenience for the one
 * machine that compiles foundry — and a file called "interim-config" holding
 * only a thing that is not interim is a name that lies.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where a dev checkout of foundry compiles its host binary. */
const DEV_CLI_CANDIDATES = [
  path.join('/Volumes/Callisto/Projects/foundry', 'dist', `foundry-${process.platform}-${process.arch}`),
  path.join(os.homedir(), 'Projects', 'foundry', 'dist', `foundry-${process.platform}-${process.arch}`),
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
    + 'or set FOUNDRY_CLI_PATH. OCR will report this rather than falling back.'
  );
}
