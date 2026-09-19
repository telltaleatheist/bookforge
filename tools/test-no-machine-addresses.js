#!/usr/bin/env node
/**
 * KEEPER — the public repo carries no machine name, address or home path.
 *
 * THE RULING (Owen, 2026-09-18): *"The repo is public and I don't want anything
 * to make it out on the internet if it doesn't belong there — passwords, file
 * paths, etc."*
 *
 * THE MECHANISM. A machine's name or address is a fact OWNED BY THAT MACHINE'S
 * CONFIG — the server registry `<userData>/crucible-servers.json`, the library
 * root, an env var, a deploy `.env`. It is never owned by source, and never by
 * a doc a stranger reads. A hard-coded list of hostnames in source is the
 * one-fact-two-owners shape: it goes stale the day DHCP moves a box, and in a
 * public repo it also publishes the operator's network to everyone who clones.
 * So this keeper greps every tracked text file and FAILS BY NAME, listing
 * file:line for every hit.
 *
 * ── What is deliberately NOT banned ────────────────────────────────────────
 *
 * `owenmorgan` on its own is the project's HUGGING FACE ACCOUNT — a published
 * package-registry identity that the download URLs in `electron/data/*.json`
 * must carry verbatim or the app cannot fetch a model. It is on the internet by
 * design. What must not ship is the operator's DNS: the `owenmorgan.com` tailnet
 * domain and the host labels under it, plus `owenmorgan@` as a login. Those are
 * the two shapes below.
 *
 * ── Why this file excludes itself ──────────────────────────────────────────
 *
 * Its own pattern table spells every banned string, so a grep over all tracked
 * files would always find itself. It is excluded BY NAME (SELF below) rather
 * than by obfuscating the table, because a keeper whose patterns you cannot
 * read is a keeper nobody can audit.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

/** This file. Excluded from the sweep — see the header. */
const SELF = 'tools/test-no-machine-addresses.js';

/**
 * Every banned shape, with the reason it is banned. The IP shapes are written
 * as ADDRESSES (a final octet is required) rather than as bare prefixes, so a
 * version string like `babel-loader-10.0.0.tgz` in `package-lock.json` is not
 * mistaken for a host on the operator's LAN.
 */
const BANNED = [
  { id: 'tailnet-domain', re: /owenmorgan\.com/gi,
    why: "the operator's tailnet domain — a server's address belongs in the server registry, not in source" },
  { id: 'tailnet-login', re: /owenmorgan@/gi,
    why: "a login on the operator's machines" },
  { id: 'host-pc', re: /owens-pc/gi, why: "the operator's PC" },
  { id: 'host-mac', re: /owens-mac-studio/gi, why: "the operator's Mac Studio" },
  { id: 'host-kylie', re: /kylies-pc/gi, why: 'a machine on the operator\'s LAN' },
  { id: 'host-nas', re: /\btitan\b/gi, why: "the operator's NAS (word-bounded, so `titanium` is fine)" },
  { id: 'lan-ip', re: /\b192\.168\.\d{1,3}\.(?:\d{1,3}|x\b)/gi,
    why: 'a private LAN address — use the RFC 5737 documentation range 192.0.2.x' },
  { id: 'tailnet-ip', re: /\b100\.64\.\d{1,3}\.\d{1,3}\b/g,
    why: 'a tailnet (CGNAT) address' },
  { id: 'rfc1918-10', re: /\b10\.0\.0\.\d{1,3}\b/g,
    why: 'a private LAN address — use the RFC 5737 documentation range 192.0.2.x' },
  // A HOME DIRECTORY IN EVERY SPELLING THE REPO USES: `/home/telltale`,
  // `/Users/telltale`, `C:\Users\tellt`, the doubled backslashes of a JS string
  // literal, the escaped slashes of a regex literal, and the
  // `\\wsl$\Ubuntu\home\telltale` UNC form Windows uses for the guest's disk.
  //
  // It is matched as a PATH rather than as the bare account name on purpose:
  // `telltale` is also an ordinary English word, and it occurs in the book text
  // the golden fixtures record. The account name on its own is caught where it
  // means something — a path, or a login (`telltale@`).
  { id: 'home-path', re: /[\\/]{1,2}(?:home|Users)[\\/]{1,2}tellt/gi,
    why: "the operator's home directory (both `tellt` and `telltale`)" },
  { id: 'ssh-login', re: /telltale@/gi, why: "a login on the operator's machines" },
  { id: 'nas-drive', re: /Z:[\\/]{1,2}bookforge/gi, why: "the operator's mapped NAS share" },
  { id: 'nas-volume', re: /\/Volumes\/iO\b/gi, why: "the operator's NAS volume on the Mac" },
  // Credential shapes. `Bearer` requires a literal token after it, so
  // `Authorization: Bearer ${token}` — code, not a secret — is not a hit.
  { id: 'token-hf', re: /\bhf_[A-Za-z0-9]{20,}/g, why: 'a HuggingFace token' },
  { id: 'token-gh', re: /\bghp_[A-Za-z0-9]{20,}/g, why: 'a GitHub token' },
  { id: 'token-sk', re: /\bsk-[A-Za-z0-9]{20,}/g, why: 'an API secret key' },
  { id: 'token-bearer', re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, why: 'a bearer token' },
];

/**
 * THE ONE DECLARED ALLOWANCE, and what it would take to remove it.
 *
 * `electron/data/higgs-models.json` names each fine-tune's MERGED DIRECTORY per
 * arm, and the `wsl` entry is required by `refuseMisshapedCheckpointPath` in
 * `electron/higgs-models.ts` to be an absolute path INSIDE THE GUEST — the
 * weights are 8.5 GB and must not sit behind the 9p mount. The catalog's own
 * comment already calls the equivalent `darwin` shape ("an absolute
 * /Users/<user>/… in a REPO-TRACKED catalog") the failure the catalog exists to
 * prevent; the `wsl` arm escaped that rule only because "the guest has a fixed
 * home", which is true of ONE guest. So these are the same defect, and they are
 * live values: changing them here stops a render on the machine that has the
 * weights.
 *
 * Removing this allowance means giving the `wsl` arm the treatment `darwin`
 * already has — store `higgs_v3_merged/<dir>` and resolve the guest root per
 * machine at document-write time — which changes narrator's voice-document
 * contract and is a cross-repo change with an in-app test behind it. It is NOT
 * this keeper's to do quietly, so it is named here instead of hidden.
 *
 * Matched on LINE CONTENT, not line number, so the allowance survives edits
 * above it and still fails on any new shape.
 */
const ALLOWED = [
  { file: 'electron/data/higgs-models.json', contains: '/home/telltale/higgs_v3_merged/' },
  // The four assertions in the catalog's keeper that bind to the live value
  // above. Its other fixtures use a neutral guest home.
  { file: 'tools/test-higgs-engine.js', contains: '/home/telltale/higgs_v3_merged/ds_v8_rvcbed1_3658_prod' },
];

/** Extensions that are never text. A NUL byte sniff catches the rest. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.webp', '.svgz',
  '.wav', '.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.mp4', '.mov',
  '.zip', '.gz', '.tgz', '.7z', '.xz', '.bz2', '.tar',
  '.pdf', '.epub', '.mobi', '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.node', '.bin', '.pyc', '.db', '.sqlite',
]);

function trackedFiles() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], {
    encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function readText(rel) {
  const abs = path.join(REPO, rel);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    // A tracked path that is not on disk means the sweep is reading a different
    // tree than git is describing — say so rather than skipping it silently.
    throw new Error(`test-no-machine-addresses: tracked file is unreadable: ${rel} (${e.message})`);
  }
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf-8');
}

function main() {
  const files = trackedFiles();
  const hits = [];
  let scanned = 0;

  for (const rel of files) {
    if (rel === SELF) continue;
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const text = readText(rel);
    if (text === null) continue;
    scanned++;
    const lines = text.split('\n');
    const allowed = ALLOWED.filter((a) => a.file === rel);
    for (const rule of BANNED) {
      for (let i = 0; i < lines.length; i++) {
        if (allowed.some((a) => lines[i].includes(a.contains))) continue;
        rule.re.lastIndex = 0;
        const m = rule.re.exec(lines[i]);
        if (m) hits.push({ rel, line: i + 1, id: rule.id, why: rule.why, text: m[0] });
      }
    }
  }

  if (hits.length) {
    const byId = new Map();
    for (const h of hits) byId.set(h.id, (byId.get(h.id) ?? 0) + 1);
    console.error(`FAIL — ${hits.length} machine name/address/home-path hit(s) in ${new Set(hits.map(h => h.rel)).size} tracked file(s), across ${scanned} scanned:\n`);
    for (const h of hits) {
      console.error(`  ${h.rel}:${h.line}  [${h.id}] ${JSON.stringify(h.text)} — ${h.why}`);
    }
    console.error('\nby shape:');
    for (const [id, n] of [...byId].sort((a, b) => b[1] - a[1])) console.error(`  ${id.padEnd(16)} ${n}`);
    console.error('\nA machine name or address is owned by that machine\'s config, never by source or by a doc a stranger reads.');
    process.exit(1);
  }

  console.log(`ok — ${scanned} tracked text files carry no machine name, address, home path or credential`);
}

main();
