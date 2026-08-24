/**
 * Making a Windows drive REACHABLE FROM THE GUEST before we hand the guest a
 * path on it.
 *
 * ── The law this exists for ─────────────────────────────────────────────────
 *
 * WSL2 auto-mounts FIXED drives only. In Ubuntu on this machine `ls /mnt` is
 * `c  e  wsl  wslg` — and Owen's library root is `Z:\bookforge`, where `Z:` is
 * `\\TITAN\iO`, the NAS. But `windowsToWslPath()` maps ANY drive letter to
 * `/mnt/<letter>` with no check, so a library path converts to a guest path
 * that simply does not exist.
 *
 * Orpheus is the one engine that runs in the guest, so it is the one engine
 * this reaches. A fresh render was immune and that is why it hid for days: the
 * render builds its session INSIDE WSL and is copied out afterwards. Only work
 * that points the guest BACK at the Windows-side cache is exposed — measured
 * 2026-08-19, and it killed a real narration on 2026-08-24:
 *
 *   {"success": false, "error": "Session directory not found: /mnt/z/bookforge/…"}
 *
 * ── Why mounting, and not staging or a scratch dir ──────────────────────────
 *
 * Because `--sentences_dir` is a WRITE target and the sentence store must not
 * move. `prepInfo.chaptersDirSentences` is threaded through ~14 sites and THREE
 * of them read it while the workers are still writing — the chapter closer, the
 * live rate probe, and RVC/denoise. Redirect the write and the closer decides
 * chapters are not closing, which is a WRONG answer rather than a missing one.
 * With the share mounted, `windowsToWslPath`'s existing output is simply
 * correct: nothing is staged, nothing is copied, and the store never moves.
 *
 * ── Three things that are measured, not assumed ─────────────────────────────
 *
 * 1. THE MOUNT DOES NOT SURVIVE `wsl -t`, which is a rung on wsl-lifecycle's
 *    own escalation ladder. So this is an ensure-before-every-spawn, not a
 *    one-time setup. It is cheap when the mount is already there: one
 *    `mountpoint -q`.
 *
 * 2. A SECOND MOUNT STACKS. It does not fail and does not replace — /proc/mounts
 *    goes 1 → 2 and they unmount one at a time. The `mountpoint -q` guard is
 *    therefore REQUIRED, not a nicety.
 *
 * 3. BACKSLASHES ARE HALVED ON ARGV TO `wsl.exe` — exactly one unescaping pass,
 *    applied BEFORE any bash quoting could protect them (`\\TITAN\iO` arrives as
 *    `\TITAN\iO`). Single-quoting does NOT save it. STDIN IS UNTOUCHED, so the
 *    script goes in on stdin and the device string crosses verbatim. This is why
 *    the code below looks indirect: it is dodging a documented hazard.
 *
 * And one that will mislead whoever debugs this next: a corrupted device string
 * fails as `mount(2) system call failed: Protocol wrong type for socket`, which
 * reads as a flaky share. It is not. Check the string before blaming the NAS.
 */

import { spawn } from 'child_process';
import os from 'os';
import { getWslDistro } from './e2a-paths';

/** Drive letters WSL mounts by itself. Anything else has to be asked for. */
const AUTO_MOUNTED = new Set(['c', 'e']);

/** Guest calls here are seconds of work at most; a mount that hangs is a wedge. */
const GUEST_TIMEOUT_MS = 20_000;

/**
 * Run a script in the guest AS ROOT, delivered on STDIN.
 *
 * stdin rather than argv because of hazard 3 above — this is the only delivery
 * that carries a UNC device string across intact.
 */
function runGuestScript(script: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const distro = getWslDistro();
    const args = [...(distro ? ['-d', distro] : []), '-u', 'root', 'bash', '-s'];
    let out = Buffer.alloc(0);
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, output: out.toString('utf8').replace(/\0/g, '').trim() });
    };
    try {
      const p = spawn('wsl.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } done(-1); }, GUEST_TIMEOUT_MS);
      p.stdout.on('data', (c: Buffer) => { out = Buffer.concat([out, c]); });
      p.stderr.on('data', (c: Buffer) => { out = Buffer.concat([out, c]); });
      p.on('exit', (code) => { clearTimeout(timer); done(code ?? -1); });
      p.on('error', () => { clearTimeout(timer); done(-1); });
      p.stdin.end(script);
    } catch {
      done(-1);
    }
  });
}

/**
 * The UNC share a mapped drive letter stands for, or null when the letter is
 * not a network mapping.
 *
 * `Win32_LogicalDisk.ProviderName` is the field — it is empty for a local disk
 * and the UNC for a mapping, which is exactly the question being asked.
 */
function uncBehindDrive(letter: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter.toUpperCase()}:'").ProviderName`,
    ];
    let out = '';
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const p = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } done(null); }, GUEST_TIMEOUT_MS);
      p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      p.on('exit', () => {
        clearTimeout(timer);
        const unc = out.trim();
        done(unc.startsWith('\\\\') ? unc : null);
      });
      p.on('error', () => { clearTimeout(timer); done(null); });
    } catch {
      done(null);
    }
  });
}

/** Drive letters named by these paths, lowercased, deduped. */
function driveLettersOf(paths: readonly (string | undefined)[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    const m = /^([A-Za-z]):[\\/]/.exec(p);
    if (m) set.add(m[1].toLowerCase());
  }
  return [...set];
}

/**
 * Ensure every drive these paths name is reachable in the guest.
 *
 * THROWS, by design, when a drive cannot be mounted. The alternative is what
 * happened on 2026-08-24: the spawn proceeds, and e2a reports `Session
 * directory not found: /mnt/z/…` — an error that names a path nobody chose and
 * says nothing about why it is missing. A refusal here can name the share, the
 * letter and the reason.
 */
export async function ensureWslDrivesFor(paths: readonly (string | undefined)[]): Promise<void> {
  if (os.platform() !== 'win32') return;
  for (const letter of driveLettersOf(paths)) {
    if (AUTO_MOUNTED.has(letter)) continue;
    const mnt = `/mnt/${letter}`;

    // Resolve on the WINDOWS side first, so the guest is entered exactly once.
    // The check and the mount belong in the SAME invocation: split across two,
    // with a PowerShell hop between them, the mount was observed not to take —
    // one call is both simpler and the only shape measured to work from cold.
    const unc = await uncBehindDrive(letter);
    if (!unc) {
      throw new Error(
        `WSL can't see ${letter.toUpperCase()}: — it auto-mounts fixed drives only, and `
        + `${letter.toUpperCase()}: is not a network mapping this app can mount for it either. `
        + 'Orpheus runs inside WSL, so it cannot read that drive. Move the library to a local '
        + 'drive, or map it as a network drive so it can be mounted.',
      );
    }

    // The device string never touches argv — see hazard 3. Single quotes stop
    // bash from touching it either. `mountpoint -q` first because a second
    // mount STACKS rather than failing (hazard 2).
    const mount = await runGuestScript(
      `if mountpoint -q ${mnt}; then echo ALREADY; exit 0; fi\n`
      + `mkdir -p ${mnt}\n`
      + `mount -t drvfs '${unc}' ${mnt}\n`
      + `mountpoint -q ${mnt} && echo MOUNTED\n`,
    );
    if (mount.output.includes('ALREADY')) continue;
    if (!mount.output.includes('MOUNTED')) {
      throw new Error(
        `Couldn't mount ${unc} at ${mnt} inside WSL, so Orpheus can't reach the library on `
        + `${letter.toUpperCase()}:. The guest said: ${mount.output || '(nothing)'}. `
        + 'If that mentions "Protocol wrong type for socket", the device string was mangled in '
        + 'transit rather than the share being down — check the share is still connected in '
        + 'Windows before blaming the NAS.',
      );
    }
    console.log(`[WSL-MOUNT] mounted ${unc} at ${mnt} for the guest`);
  }
}
