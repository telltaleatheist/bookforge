#!/usr/bin/env node
/**
 * Builds `libxml2.wasm` from the pinned libxml2 source and `shim.c`. See README.md. Nothing in
 * the app or its install runs this; they use the committed binary.
 *
 *   node vendor/libxml2-wasm/build.js <libxml2-2.11.9.tar.xz> <emsdk dir> <work dir>
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_SHA256 = '780157a1efdb57188ec474dca87acaee67a3a839c2525b2214d318228451809f';
const EMSCRIPTEN_VERSION = '6.0.13';
const VERSION = '2.11.9';
const VERSION_NUMBER = '21109';

// The libxml2 files the parser and serializer link against, and nothing else.
const SOURCES = [
  'buf', 'chvalid', 'dict', 'encoding', 'entities', 'error', 'globals', 'hash', 'HTMLparser', 'HTMLtree',
  'list', 'parser', 'parserInternals', 'SAX2', 'threads', 'tree', 'uri', 'valid', 'xmlIO', 'xmlmemory',
  'xmlsave', 'xmlstring',
];
const ON = new Set(['TREE', 'OUTPUT', 'PUSH', 'SAX1', 'VALID', 'HTML']);
const EXPORTS = ['bf_alloc', 'bf_free', 'bf_parse', 'bf_free_doc', 'bf_root', 'bf_find_body', 'bf_len', 'bf_tostring', 'bf_result_length', 'bf_parse_xml', 'bf_dump'];

const CONFIG_H = `#define HAVE_FCNTL_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STAT 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_VA_COPY 1
#define HAVE_SNPRINTF 1
#define HAVE_VSNPRINTF 1
#define VERSION "${VERSION}"
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function main() {
  const [tarball, emsdk, work] = process.argv.slice(2);
  if (!tarball || !emsdk || !work) throw new Error('usage: build.js <libxml2-2.11.9.tar.xz> <emsdk dir> <work dir>');

  const hash = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  if (hash !== SOURCE_SHA256) throw new Error(`${tarball} is ${hash}, not the pinned ${SOURCE_SHA256}`);

  fs.mkdirSync(work, { recursive: true });
  run('tar', ['-xJf', tarball, '--force-local', '-C', work]);
  const source = path.join(work, `libxml2-${VERSION}`);
  fs.writeFileSync(path.join(source, 'config.h'), CONFIG_H);

  const template = fs.readFileSync(path.join(source, 'include/libxml/xmlversion.h.in'), 'utf8');
  fs.writeFileSync(path.join(source, 'include/libxml/xmlversion.h'), template
    .replace(/@VERSION@/g, VERSION)
    .replace(/@LIBXML_VERSION_NUMBER@/g, VERSION_NUMBER)
    .replace(/@LIBXML_VERSION_EXTRA@/g, '')
    .replace(/@MODULE_EXTENSION@/g, '')
    .replace(/@WITH_([A-Z0-9_]+)@/g, (_whole, name) => (ON.has(name) ? '1' : '0')));

  const emcc = path.join(emsdk, 'upstream', 'emscripten', process.platform === 'win32' ? 'emcc.bat' : 'emcc');
  const output = path.join(__dirname, 'libxml2.wasm');
  run(emcc, [
    '-O2',
    '-DHAVE_CONFIG_H',
    `-I${source}`,
    `-I${path.join(source, 'include')}`,
    path.join(__dirname, 'shim.c'),
    ...SOURCES.map((name) => path.join(source, `${name}.c`)),
    '-sSTANDALONE_WASM',
    '--no-entry',
    '-sALLOW_MEMORY_GROWTH',
    '-sFILESYSTEM=0',
    `-sEXPORTED_FUNCTIONS=${EXPORTS.map((name) => `_${name}`).join(',')}`,
    '-o',
    output,
  ], { env: { ...process.env, EMSDK: emsdk } });

  const built = fs.readFileSync(output);
  const sha256 = crypto.createHash('sha256').update(built).digest('hex');
  console.log(`${output}: ${built.length} bytes, sha256 ${sha256}, Emscripten ${EMSCRIPTEN_VERSION}`);
}

main();
