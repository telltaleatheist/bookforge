'use strict';
/**
 * clipforge-enhance — the enhancement round-trip and its audits, as clipforge verbs (2026-09-23).
 *
 * Owen: "make sure we're integrating our useful scripts into clipforge, so we can use them later". These are the
 * tools the deathstalker + mistborn Adobe/Premiere rebuild was made with. The scripts live in the training repo
 * (orpheus-finetune/pipeline/enhance, pipeline/rvc/eq_master.py); each verb here is a spec: which script, which
 * flags are required, which pass through, and what a run must leave behind to count as done. One runner, no
 * per-verb spawning code - a flag the spec does not list is REFUSED, never silently dropped (the heading-regex
 * lesson of 2026-09-23: clipforge slice dropped --exclude-text-regex for eleven days).
 *
 * The pipeline, in order:
 *   enhance-upload    books.json -> non-dialogue regions -> <prefix>_partNN.wav (<= 59 min) + adobe_map.json
 *   split-parts       one master -> ~N-minute parts cut at the quietest point near each mark + parts.json
 *   denoise-dir       RoFormer DENOISE (aufr33 "dry") over every wav in a folder, lengths kept exact (WSL)
 *   ... Adobe Podcast online or Premiere Enhance Speech, by hand ...
 *   join-parts        returned parts -> one master, duration checked against the source
 *   eq-match          a master's speech spectrum matched to a reference set, block-wise, sample-exact
 *   enhance-reinsert  returned upload parts -> each book's own timeline (lag-checked), so the VTT still fits
 *   invented          sounds the enhancer ADDED to pauses (export louder than its own input) -> the sentences
 *   openers           epigraphs + chapter-start cues (+ enhancer part seams) -> cue ids to exclude
 *   cue-ids           number an un-numbered VTT so slice --exclude-cue-ids can match it
 * Then the usual: slice (--exclude-cue-ids @...), cut-audit, merge-tiers, gate, bed. Field notes 4n.87-4n.90.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SPECS = {
  'enhance-upload': {
    script: 'pipeline/enhance/build_adobe_upload.py', what: 'non-dialogue regions of every book -> <=59-min upload parts + map',
    required: ['books-json', 'out'],
    flags: ['books', 'heading-regex', 'prefix', 'part-max-min', 'gap-s', 'lead-s', 'sep-s', 'reg-max-s', 'min-start'],
    bools: ['dry-run'], done: (a) => path.join(a.out, 'adobe_map.json'),
    help: [
      '  --books-json <file>   {"<book>": [master, vtt, dialogue_ids_file_or_null], ...}; file order = upload order',
      '  --out <dir>           <prefix>_partNN.wav + adobe_map.json (book, master, src_start/end, part, offset, length)',
      '  --prefix ds_adobe     part names;  --part-max-min 59;  --min-start 300 (drops intros and front matter)',
      '  --heading-regex <f>   headings/front matter are left out, the slicer\'s own --exclude-text-regex file',
      '  --dry-run             count hours and parts, write only the map',
      '  Parts are cut only inside the 2 s separators between regions; regions longer than 15 min are split',
      '  inside a pause. Upload every part with ONE setting (the 2026-09-22 deathstalker run: Enhance v2, speech 70 %).',
    ],
  },
  'enhance-reinsert': {
    script: 'pipeline/enhance/reinsert_adobe.py', what: 'returned upload parts -> each book\'s own timeline',
    required: ['map', 'returns', 'book', 'out'], flags: ['prefix'], done: (a) => a.out,
    help: [
      '  --map adobe_map.json  --returns <dir holding <prefix>_partNN-<anything>.wav>  --book <id>  --out <flac>',
      '  Each region is cut from the return at its mapped offset, its position refined by envelope cross-correlation',
      '  against the upload (+-60 ms), and written at src_start on a silent copy of the master timeline. Anything not',
      '  uploaded (dialogue, headings, parts not yet back) is digital zero - the slicer cannot use it.',
    ],
  },
  'split-parts': {
    script: 'pipeline/enhance/split_parts.py', what: 'a master -> parts cut at quiet points + parts.json',
    positional: ['master', 'out'], flags: ['part-min', 'search-s'], done: (a) => path.join(a.out, 'parts.json'),
    help: [
      '  --master <audio>  --out <dir>  [--part-min 30] [--search-s 45]',
      '  Each cut lands on the quietest 20 ms frame within +-search-s of the mark; parts sum to the master sample-exact.',
      '  Mind the WAV limit: a WAV cannot pass 4 GB (44.1 kHz 16-bit mono = 12.5 h). A 24-bit 9 h WAV wrapped its',
      '  length field and read back as 8.28 h on 2026-09-23. Use FLAC for anything long.',
    ],
  },
  'join-parts': {
    script: 'pipeline/enhance/concat_parts.py', what: 'returned parts -> one master, duration-checked',
    positional: ['parts-json', 'parts-dir', 'out'], done: (a) => a.out,
    help: [
      '  --parts-json <parts.json from split-parts>  --parts-dir <dir with the returned part files>  --out <flac>',
      '  Every part must be within 1 ms of its source duration and the whole within 10 ms, or it exits non-zero.',
    ],
  },
  'eq-match': {
    script: 'pipeline/rvc/eq_master.py', what: 'match a master\'s speech spectrum to a reference, sample-exact',
    required: ['master', 'out'], flags: ['ref', 'curve', 'block-s', 'overlap-s', 'strength', 'max-db', 'headroom-db'],
    done: (a) => a.out,
    help: [
      '  --master <audio>  --out <flac>  --ref <dir of reference wavs>  [--strength 1.0] [--max-db 10] [--block-s 540]',
      '  The mistborn rule (2026-09-23, Owen: "EQ sounds fine"): the reference is 12 x 30 s from EACH book\'s RAW master,',
      '  so every book lands on the set\'s own mean tone. Premiere Enhance darkens the top end by 2-8 dB; this puts it',
      '  back. Zero-phase FIR per block, loudness-neutral, clamped.',
    ],
  },
  'invented': {
    script: 'pipeline/enhance/find_invented.py', what: 'sounds an enhancer added to pauses -> the sentences touching them',
    required: ['pairs', 'offsets', 'book', 'out'], flags: ['max-listen'],
    then: (a) => a.vtt ? ['pipeline/enhance/invented_to_cues.py', ['--book', a.book, '--vtt', a.vtt, '--dir', a.out]] : null,
    extra: ['vtt'], done: (a) => path.join(a.out, a.book + '_invented.json'),
    help: [
      '  --pairs "<input.wav>|<export.wav>[,...]"  --offsets <book-timeline start (s) of each pair, comma list>',
      '  --book <id>  --out <dir>  [--vtt <book vtt>: also map every event to cues and ADD them to <book>_exclude_ids.txt]',
      '  A 10 ms frame is invented when the INPUT is quiet (< speech - 40 dB) and the EXPORT is > 20 dB above it and',
      '  above speech - 45 dB; runs >= 80 ms are events. <book>_invented_listen.wav plays input then export for each.',
      '  It caught the "Breeze shook his head" artifact exactly (4n.90). Both sentences around each event go.',
    ],
  },
  'openers': {
    script: 'pipeline/enhance/openers.py', what: 'epigraphs + chapter starts (+ enhancer seams) -> cue ids to exclude',
    required: ['book', 'vtt', 'master', 'out'], flags: ['parts', 'window'], done: (a) => path.join(a.out, a.book + '_exclude_ids.txt'),
    help: [
      '  --book <id>  --vtt <vtt>  --master <audio on the vtt timeline>  --out <dir>  [--parts <parts.json>] [--window 12]',
      '  A chapter-start cue is 3+ ALL-CAPS words after a chapter number or at the start of the cue; its epigraph is the',
      '  cues back to the chapter break, which is found in the AUDIO (the longest pause ending at a cue onset). With',
      '  --parts, every cue within 2 s before / 15 s after each part join goes too (the enhancer\'s file-start artifact).',
      '  Built for Sanderson\'s epigraphs; check the per-chapter report before trusting it on another book.',
    ],
  },
  'cue-ids': {
    script: 'pipeline/enhance/add_cue_ids.py', what: 'number an un-numbered VTT (for --exclude-cue-ids)',
    positional: ['in', 'out'], done: (a) => a.out,
    help: [
      '  --in <vtt>  --out <vtt>',
      '  slice --exclude-cue-ids matches the identifier line of each cue; a library VTT without one matches NOTHING,',
      '  silently. The numbering is the counter every exclusion tool uses, so their ids address these cues.',
    ],
  },
  'denoise-dir': {
    script: 'pipeline/enhance/roformer_dir.py', what: 'RoFormer denoise every wav in a folder (WSL separator env)',
    positional: ['in', 'out', 'tmp'], wsl: true, done: (a) => a.out,
    help: [
      '  --in <dir of 44.1 kHz wavs>  --out <dir>  --tmp <dir>  [--wsl-python <separator env python>]',
      '  denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt, the "(dry)" stem - a MASK model (it only keeps or lowers',
      '  what is there; it never invents). Outputs are padded/trimmed to the exact input length (fails past 10 ms).',
      '  Resumable per file. 3090 Ti ~9.7x realtime. Take the shared GPU lock first; nothing else on the card.',
    ],
  },
};

function toWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path.resolve(p));
  return m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/') : p;
}

function install(ctx) {
  const { resolveTrainingRoot, resolveTrainingPython, spawnTraining } = ctx;
  const verbs = {};
  for (const [verb, spec] of Object.entries(SPECS)) {
    verbs[verb] = async function (args) {
      const usage = ['clipforge ' + verb + ' - ' + spec.what + '  (' + spec.script + ')', '', ...spec.help].join('\n');
      if (args.help) { console.log(usage); return; }
      const known = new Set([...(spec.required || []), ...(spec.flags || []), ...(spec.bools || []), ...(spec.positional || []),
        ...(spec.extra || []), 'python', 'training-root', 'wsl-python', 'help', '_']);
      const unknown = Object.keys(args).filter((k) => !known.has(k));
      if (unknown.length) throw new Error(verb + ': unknown flag(s) --' + unknown.join(', --') + ' (see: clipforge ' + verb + ' --help)');
      for (const k of [...(spec.required || []), ...(spec.positional || [])]) {
        if (args[k] === undefined || args[k] === true) throw new Error(verb + ': --' + k + ' is required (see: clipforge ' + verb + ' --help)');
      }
      const root = resolveTrainingRoot(args);
      const script = path.join(root, ...spec.script.split('/'));
      if (!fs.existsSync(script)) throw new Error(verb + ': script not found: ' + script);
      const argv = [];
      for (const k of spec.positional || []) argv.push(String(args[k]));
      for (const k of [...(spec.required || []), ...(spec.flags || [])]) {
        if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
      }
      for (const k of spec.bools || []) if (args[k]) argv.push('--' + k);
      if (spec.wsl) {
        const py = String(args['wsl-python'] || '/home/telltale/anaconda3/envs/separator/bin/python');
        const wargs = ['-e', py, toWsl(script), ...argv.map((v) => (/^[A-Za-z]:[\\/]/.test(v) ? toWsl(v) : v))];
        console.log('[' + verb + '] wsl ' + wargs.join(' '));
        const code = await new Promise((res, rej) => { const c = spawn('wsl', wargs, { stdio: 'inherit' }); c.on('error', rej); c.on('close', res); });
        if (code !== 0) throw new Error(verb + ': exited ' + code);
      } else {
        await spawnTraining(resolveTrainingPython(args, verb), script, argv, path.dirname(script), verb);
      }
      const then = spec.then && spec.then(args);
      if (then) await spawnTraining(resolveTrainingPython(args, verb), path.join(root, ...then[0].split('/')), then[1], path.dirname(script), verb);
      const done = spec.done && spec.done(args);
      if (done && !fs.existsSync(path.resolve(String(done)))) throw new Error(verb + ': produced no ' + done + ' - it did NOT finish');
      if (done) console.log('[' + verb + '] -> ' + done);
    };
  }
  return verbs;
}

module.exports = { install, SPECS };
