#!/usr/bin/env node
/**
 * copy-foundry-window — make foundry-app/ from a Foundry commit, then put
 * BookForge's own edits back on top. TEMPORARY: it lives only until the last
 * copy lands (docs/REORG-PLAN.md, B3). After that BookForge owns foundry-app/,
 * and this file and its patch are deleted.
 *
 *   node tools/copy-foundry-window.mjs --from <foundry repo> --sha <sha>
 *       replace foundry-app/ with that commit's app/, apply the saved edits, stage it
 *   node tools/copy-foundry-window.mjs --from <foundry repo> --save
 *       write the saved edits: what HEAD's foundry-app/ has that the copy has not
 *   node tools/copy-foundry-window.mjs --from <foundry repo> --check
 *       report whether HEAD equals the recorded copy plus the saved edits
 *
 * Reads the Foundry repo through `git archive` only, so that checkout is never
 * built, edited or moved, and line endings are git's rather than the working
 * tree's. The patch is taken and applied against blobs for the same reason:
 * core.autocrlf makes this working tree CRLF and Foundry's LF.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = 'foundry-app';
const PATCH = 'tools/foundry-window-edits.patch';
const RECORD = 'tools/foundry-window-copy.json';

/** The parts of Foundry's app/ that are Foundry's own program rather than the window BookForge hosts. */
const LEFT_BEHIND = [
  '.npmrc', // install-links, for Foundry's directory dependency on the library
  'electron/main.ts', // Foundry's standalone shell; BookForge's main is electron/main.ts
  'test', // bun tests of Foundry's own pins and shell
  'vendor', // BookForge pins its tarballs in its own vendor/
  'tools/checks',
  'tools/free-port.cjs',
  'tools/ipc-channels.js',
  'tools/ipc-channels.baseline.txt',
  'tools/package-mac.cjs',
  'tools/sync-foundry-core.cjs',
];

function die(message) {
  console.error(`copy-foundry-window: ${message}`);
  process.exit(1);
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: REPO, encoding: 'buffer', maxBuffer: 1 << 30, ...opts });
  if (result.status !== 0) die(`${command} ${args.join(' ')} failed: ${String(result.stderr).slice(0, 2000)}`);
  return result.stdout;
}
const git = (args, opts) => run('git', args, opts);
const text = (buffer) => buffer.toString('utf8').trim();

const GIT_DIR = text(git(['rev-parse', '--absolute-git-dir']));

/** That commit's app/, minus LEFT_BEHIND, at <temporary folder>/foundry-app. */
function extractCopy(from, sha) {
  const root = fs.mkdtempSync(path.join(GIT_DIR, 'foundry-window-'));
  const dir = path.join(root, WINDOW);
  fs.mkdirSync(dir);
  const tar = path.join(root, 'app.tar');
  git(['-c', 'core.autocrlf=false', '-C', from, 'archive', '--output', tar, sha, 'app']);
  run('tar', ['-xf', '../app.tar', '--strip-components=1'], { cwd: dir });
  fs.rmSync(tar);
  for (const gone of LEFT_BEHIND) fs.rmSync(path.join(dir, gone), { recursive: true, force: true });
  return root;
}

/** The tree "HEAD with foundry-app/ exactly the copy". Touches neither the index nor the working tree. */
function copyTree(from, sha) {
  const root = extractCopy(from, sha);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, 'index') };
  try {
    git(['read-tree', 'HEAD'], { env });
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', WINDOW], { env });
    git(['--git-dir', GIT_DIR, '--work-tree', root, '-c', 'core.autocrlf=false', 'add', '-f', '--', WINDOW],
      { env, cwd: root });
    return text(git(['write-tree'], { env }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function args() {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  const from = value('--from');
  if (!from) die('--from <foundry repo> is required');
  return { from, sha: value('--sha'), save: argv.includes('--save'), check: argv.includes('--check') };
}

function recordedSha() {
  return JSON.parse(fs.readFileSync(path.join(REPO, RECORD), 'utf8')).sha;
}

function save(from) {
  const tree = copyTree(from, recordedSha());
  const patch = git(['diff', '--binary', '--no-renames', tree, 'HEAD', '--', WINDOW]);
  fs.writeFileSync(path.join(REPO, PATCH), patch);
  console.log(`saved ${patch.length.toLocaleString()} bytes of edits to ${PATCH}`);
}

function check(from) {
  const root = fs.mkdtempSync(path.join(GIT_DIR, 'foundry-window-check-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, 'index') };
  try {
    git(['read-tree', copyTree(from, recordedSha())], { env });
    if (fs.statSync(path.join(REPO, PATCH)).size > 0) git(['apply', '--cached', '--binary', PATCH], { env });
    const made = text(git(['write-tree'], { env }));
    const head = text(git(['rev-parse', 'HEAD^{tree}']));
    if (made !== head) {
      const names = text(git(['diff', '--name-status', made, 'HEAD', '--', WINDOW]));
      die(`HEAD is not the copy plus the saved edits:\n${names || '(outside ' + WINDOW + ')'}`);
    }
    console.log(`foundry-app/ is ${recordedSha()} plus the saved edits`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function copy(from, sha) {
  if (text(git(['status', '--porcelain']))) die('commit or stash first: the working tree is not clean');
  const full = text(git(['-C', from, 'rev-parse', '--verify', `${sha}^{commit}`]));
  const tree = copyTree(from, full);
  // Tracked files only: node_modules, dist and the Angular cache stay where they are.
  for (const file of text(git(['ls-files', '--', WINDOW])).split('\n').filter(Boolean)) {
    fs.rmSync(path.join(REPO, file), { force: true });
  }
  // Folders the copy no longer has, now empty.
  for (const old of ['engine', 'shared', 'test', 'vendor', 'tools/checks']) {
    fs.rmSync(path.join(REPO, WINDOW, old), { recursive: true, force: true });
  }
  git(['read-tree', tree]);
  git(['checkout', '--', WINDOW]);
  fs.writeFileSync(path.join(REPO, RECORD), `${JSON.stringify({ sha: full }, null, 2)}\n`);
  git(['add', RECORD]);
  if (fs.existsSync(path.join(REPO, PATCH)) && fs.statSync(path.join(REPO, PATCH)).size > 0) {
    const applied = spawnSync('git', ['apply', '--index', '--3way', '--binary', PATCH], { cwd: REPO, encoding: 'utf8' });
    process.stdout.write(applied.stdout);
    process.stderr.write(applied.stderr);
    if (applied.status !== 0) die('the saved edits did not all apply: resolve them, commit, then run --save');
  }
  console.log(`foundry-app/ is now ${full.slice(0, 7)} plus the saved edits, staged; review and commit`);
}

const { from, sha, save: saving, check: checking } = args();
if (saving) save(from);
else if (checking) check(from);
else if (sha) copy(from, sha);
else die('say --sha <sha>, --save or --check');
