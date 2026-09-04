# narrator — the BookForge-owned replacement for ebook2audiobook

Status: PROPOSAL (2026-09-04). Nothing here is built. Name is a placeholder.

## Why

ebook2audiobook was useful when it managed XTTS for us. Today Orpheus is the whole
pipeline, and the fork is 155 commits / +11,118 lines past upstream: the engine
(`orpheus.py`, 5,507 lines vs 706 upstream), the parallel worker layer
(`bookforge_ext/parallel`, 3,015 lines) and 35 of `core.py`'s functions are ours.
What upstream still provides is three things — stanza sentence segmentation under our
chunk packer, the assembly recipe, and the VTT — and it costs us three checkouts
synced by git, a fork that can never merge upstream, and gradio/stanza/calibre
weight in every env. Calibre is never used: by the time text reaches the engine it is
an EPUB from Foundry, every time.

## Non-negotiable contracts (what other pieces rely on)

These are the seams the new module must honour byte-for-byte on day one, because the
app, the CLI, Studio, the training tools and the streaming server all read them:

1. **The headless door.** `parallel-tts-bridge.ts`, `reassembly-bridge.ts`,
   `correct-sentences-bridge.ts`, `book-render-service.ts` and `cli/bookforge-tts.py`
   spawn `app.py --headless` with ~40 flags (`--prep_only`, `--worker_mode`,
   `--sentence_start/end`, `--assemble_only`, `--sentences_dir`, `--session`,
   `--resume_session`, `--list_sessions`, `--sentence_indices`,
   `--sentence_overrides`, `--num_takes`, `--take_temperatures`,
   `--orpheus_model_dir/--orpheus_base_dir/--orpheus_adapter_dir`,
   `--post_render_filter`, …) plus `ORPHEUS_*` env caps.
2. **The session layout.** `sessions/<lang>/ebook-<uuid>/<hash>/chapters/sentences/*.flac`
   and its JSON sidecars. Resume, the project sentence cache, Studio's per-sentence
   retakes, clip/cut/training tools and the reassembly bridge all walk it.
3. **The worker progress lines** (`worker_core.py` format) — the bridges' regexes and
   the watchdog read them; the MLX heartbeat line is additive-compatible by design.
4. **The streaming worker protocol** — `orpheus_stream.py`'s stdin/stdout JSON lines,
   including `batch_chunk` / `batch_item{streamed}` for fast start.
5. **The VTT.** Cue text = the exact chunk text as rendered, cues in sentence order,
   sidecar binding beside the m4b. (Measured 2026-09-04: e2a writes NO cue identifiers
   and NO `NOTE` blocks; an earlier draft of this line said otherwise.) Training and
   debugging read it as the contract between sentence index, rendered file, text and time.
6. **Guard events** — `[ORPHEUS][ORPHEUS_GUARD_EVENT] {json}` lines the bridge parses
   into the reject dir.
7. **Voice caps** — `orpheusVoiceCapsForModel` → env / `register_voice_caps`
   (`VOICE_CAP_SOURCES` keys) unchanged.

## Shape

One Python package in the BookForge repo — `python/narrator/` — installed editable
into the two Orpheus envs (WSL `orpheus_tts`, Mac `ebook2audiobook-orpheus`). ONE
checkout per machine: WSL imports the package over `/mnt/c/.../bookforge/python`
(code only — sessions and scratch stay on ext4 as today). No more e2a checkouts, no
more `cp`/CRLF trap, no more "which checkout is stale".

```
python/narrator/
  manifest.py    THE render manifest — the one source of truth (see below)
  text/          EPUB → chapters → sentences → chunks (the packer, ported from core.py)
  engine/        OrpheusEngine: vLLM + MLX backends, caps registry, LoRA adapters,
                 EOS boost/floor, truncation guards, rate ratchet, batched decode,
                 generate_batch_stream + the windowed SNAC decoder, fastpath
  render/        session store (layout v1 = today's), workers, resume, retakes,
                 progress protocol   (port of bookforge_ext/parallel + worker_core)
  assemble/      per-chapter parallel AAC, stream-copy concat, remux with chapter
                 atoms + cover, transcript embed, VTT from sample counts, gap
                 realization, duration guards
  serve/         the streaming server (orpheus_stream.py moves here, same protocol)
  compat/app.py  accepts today's --headless flags and routes them; retired flag by
                 flag once each bridge is modernized
  cli.py         python -m narrator prep|render|assemble|serve|retake|sessions
  tests/         the e2a tools/test_*.py move here + golden-book parity fixtures
```

**The render manifest** is the design's centre. Prep writes it; render, assembly, the
VTT, resume, retakes and the training exporters all READ it and never re-derive it:

```
{ version, book: {epubPath, sha}, voice, caps: {maxChars, ...},
  chapters: [{index, title, chunks: [{index, text, kind: prose|heading|item,
              gapBefore, gapAfter, file: "chapters/sentences/<index>.flac" | null,
              samples: <int|null>, take: <n>}]}] }
```

Cue times are a running sum of `samples` (from each FLAC's STREAMINFO — exact, no
ffprobe) plus the realized gaps. The concat list for the encoder is generated from
the same rows. That is what makes the VTT and the audio unable to disagree, which is
a stronger guarantee than today.

**The engine** keeps every behaviour it has now; it loses `TTSUtils`/`TTSRegistry`,
the e2a session dict and `_save_audio`, and gains a small `SentenceSink` interface
(write a rendered chunk + its sample count into the manifest). `generate_batch_stream`
and the caps registry are already shaped for this.

**Assembly** encodes each chapter as its own AAC in parallel (16 wide here; `aac_at`
on the Mac), stream-copies the chapters together, and remuxes once with chapter
atoms and cover. Later: encode a chapter the moment its last chunk lands, so the
end-of-job assembly becomes a concat and a remux. Chapter boundaries carry ≥0.5 s of
silence, so AAC's ~21 ms priming at a join is inaudible; the duration guards (post
Witnesses / Nuremberg) move to per-chapter checks.

## What is deleted

gradio, calibre, stanza (after step 4 decides), XTTS/F5/Voxtral/bark/vits/tacotron/
fairseq engines, TTSManager/registry, device_installer (the component system owns
envs), argos translation, voice_extractor, the 63 upstream `core.py` functions not
on the headless path, `lib/conf.py`'s UI-era settings (the CUDA/WSL env block moves
into `engine/`).

## Migration — each step shippable, each parity-tested

0. **Golden set.** Three books rendered with today's e2a (short; long; headings-heavy):
   chunk lists, session dirs, VTTs, m4b durations, guard events → fixtures.
1. **assemble/** replaces `--assemble_only` (reassembly bridge + CLI) reading the SAME
   session dir. Parity: identical cue text and count, cue times within 1 ms (then
   exact), equal m4b duration and chapter count. Biggest visible payoff (Mutineer
   8 min → <1 min), lowest risk.
2. **engine/ + serve/** move together (they are one import). Parity: vLLM is
   deterministically seeded per batch composition, so a fixed batch must produce
   byte-identical FLACs; streaming server smoke on both machines.
3. **render/** ports the worker layer, keeping session layout v1. Parity: resume an
   existing e2a session dir untouched; progress lines identical.
4. **text/** ports the packer (stanza stays until parity is shown on the golden set;
   diffs are ear-checked, not just diffed — chunk boundaries change the read).
5. **Cut over**: `getDefaultE2aPath()` → the package; delete the WSL and Mac e2a
   checkouts; `pip install -e` in both envs. Then retire compat flags one by one.

## Risks

- The session layout has many implicit readers (`grep chapters/sentences`); step 3
  must enumerate them before changing a byte.
- Two Orpheus envs are hand-built (memory: torch pins, vLLM 0.7.3, mlx); the package's
  `pyproject` must pin what those envs already have, not what pip prefers.
- The packer is the one piece whose "parity" is partly a judgment (2026-08-27
  headings, 2026-08-29 list items, min-chars floor); keep it last.

## Managed WSL engine (Windows) — BookForge provisions the GPU environment itself

Orpheus on Windows needs WSL2 for vLLM with CUDA graphs (native Windows is eager-only,
~6x slower). Today that means a hand-built Ubuntu, a hand-built conda env and a git
checkout the user maintains. With narrator as our own package, the WSL side becomes
an ARTIFACT BookForge installs, versions, updates and removes — like the conda-pack
components in Settings → Add-ons, but for a whole distro.

**A dedicated distro, not the user's.** `wsl --import bookforge-orpheus <dir> image.tar`
from an image we build. Isolated from any Ubuntu the user has; `wsl --terminate
bookforge-orpheus` kills only ours (today a wedge means `wsl --shutdown` for
everything — see wsl-wedge-proofing); `wsl --unregister` is a clean uninstall.
The image carries a plain venv at a fixed path (no conda, no `bash -ic`, no
`conda run`): `wsl.exe -d bookforge-orpheus --exec /opt/orpheus/bin/python -m narrator …`.
The narrator package itself is imported from the Windows checkout over `/mnt/c`, so
app updates never need a new image — only torch/vLLM pin changes do.

**Building the image** is a script, not a ritual: a Dockerfile (Ubuntu base + the
pinned wheels: torch 2.5.1+cu121, vLLM 0.7.3, numpy 1.26.4, snac, soundfile…) →
`docker export` → tar → zstd, versioned `orpheus-wsl-vN`. Same hosting as the Windows
env (GitHub Releases, split under the 2 GiB cap, sha-verified, resumable). ~3-4 GB
compressed, ~10-15 GB on disk; say so in the UI. The self-test that gates "ready":
`nvidia-smi` inside the distro, `import vllm`, and a one-sentence render that must
log CUDA graph capture (the exact line in CLAUDE.md's troubleshooting section).

**What BookForge drives, in order** (Settings → Add-ons → "Orpheus GPU engine (WSL)"):
1. Preflight, loud on failure: Windows 11 / 10 21H2+, an NVIDIA Windows driver
   (WSL gets libcuda from it — no CUDA toolkit in the distro), virtualization enabled
   (detectable via `wsl --status`; a BIOS toggle we can only name, not flip), disk.
2. Enable WSL if absent: `wsl --install --no-distribution` under a UAC prompt; this
   one step can need a REBOOT, and the installer must say "reboot, then press
   Install again" rather than pretend. On most Windows 11 machines WSL is already
   present and this step is a no-op.
3. Download + import the image; write nothing to the user's `.wslconfig` unless they
   opt in (it is global to all distros — the memory cap story).
4. Self-test; register the component with its version; the existing
   `spawnWithWslSupport` / path-rewriting machinery targets the new distro name.
5. Updates: compare the installed image version to the catalog; re-import on bump
   (sessions and models live outside the distro — models stay in the Windows
   orpheus-models dir, sessions on the distro's ext4 scratch that a re-import
   recreates).

**Honest limits.** NVIDIA only (vLLM on ROCm-in-WSL is not a real target); the
first-ever WSL enable needs admin and possibly a reboot; corporate policy can block
WSL; a machine with virtualization off in firmware cannot be fixed from software.
Each of those becomes a named preflight failure, never a silent fallback to the slow
native path — that path stays available as an EXPLICIT choice ("no GPU engine").

**The alternative worth keeping on the table: no WSL at all.** NOT vLLM — its
Windows wheel is a broken community build and CUDA graphs do not work through it
(Owen, 2026-09-04; that is the whole reason for WSL). llama.cpp is a different
engine: its own C++/CUDA backend with its own graph capture, no PyTorch, no vLLM,
and it runs Orpheus as GGUF natively on Windows and loads GGUF LoRA adapters at
runtime. UNMEASURED here — treat every throughput claim as a hypothesis until one
chapter has been rendered with it on this machine. If it works: zero-setup for
users, good for streaming/single listener. The cost is batch throughput for whole-book renders (no continuous
batching like vLLM) and a second engine backend to keep at parity with vLLM/MLX
(caps, EOS boost/floor, guards, SNAC decode). Decide by measuring one book's render
time on llama.cpp vs vLLM before choosing; the managed-WSL design above is what
keeps vLLM's throughput for the render box, and the two are not mutually exclusive
(WSL when available, llama.cpp otherwise).

## Multi-engine direction (Owen, 2026-09-04, relayed by the orpheus-training session)

narrator must be able to run other LLM-codec TTS engines, not only Orpheus. Named
targets: **Maya1** (Maya Research; 3B Llama-style + SNAC 24 kHz; Apache-2.0; emotion
tags + voice-description prompt) and **Llasa-8B** (HKUST; Llama-3.1-8B + X-codec2:
ONE codebook of 65,536, 50 tokens/s, 16 kHz output; 1B/3B siblings).

What varies per engine and therefore sits behind an interface in `engine/`:

1. **Codec** — SNAC (3 RVQ levels, 7 tokens per ~12 Hz frame, 24 kHz) vs X-codec2
   (1 stream, 50 Hz, 16 kHz): token->audio decode, frame arithmetic, sample rate. The
   windowed streaming decoder is codec-specific.
2. **Prompt format** — Orpheus/Maya voice-token framing (`[SOH] "voice: text" [EOT]
   [EOH][SOAI][SOS] audio [EOS][EOAI]`) vs Llasa's text + optional reference-audio-
   token prompt for zero-shot cloning.
3. **Stop handling** — audio-token cap (Orpheus 3700 = 44 s; X-codec2 ~4000 = 80 s),
   EOS boost/floor levers, repetition-penalty scope: engine-specific numbers, never
   constants in the scheduler or the bridges.
4. **Chunk sizing** — maxChars / maxCharsPerSec are per-model already; the
   seconds-per-token conversion is per-codec.
5. **Voice identity** — fine-tuned voice token (Orpheus) vs reference clip (Llasa
   zero-shot) vs description prompt (Maya1): three different "voice" objects.
6. **Serving** — vLLM serves all three Llama-style backbones, but the logits
   processors and the decode step differ per engine.

The per-voice tuning catalog (`orpheus-models.json`) and the ladder/caps machinery
key on **(engine, voice)**, not voice alone.

Sequencing: the Orpheus port in `engine/` lands first as a faithful port (step 2).
The interface is extracted AFTER the orpheus-training session reports its Llasa-8B
zero-shot render (prompt format, token rates, decode path measured on the
deathstalker reference), so the seams are shaped by two real engines, not one.
Nothing in the manifest, session layout, VTT or assembly contracts depends on the
engine; `sampleRate` is already a manifest field for this reason.

### Llasa-8B measurements (orpheus-training session, 2026-09-04; full notes in
`E:\training\_campaigns\2026-09-01-cod-full-rebuild\llasa\LLASA_NOTES.md`)

- Codec X-codec2: single codebook 65,536, 16 kHz mono float out, measured 49.07 audio
  tokens/s (nominal 50); decode = X-codec2 decoder over the token list, NO trim
  convention (unlike SNAC's +75 samples per window).
- Prompt: Llama-3.1 chat framing; speech tokens are ordinary vocabulary entries
  `<|s_N|>` plus a few special tokens (ids/order in the notes). Training rows start with
  ONE BOS 128000 - mlx-lm's loader adds its own (trainer trap).
- Zero-shot cloning: the reference clip is embedded as its X-codec2 tokens after the
  reference transcript (12 s clip = 552 tokens). So "voice" = reference clip + transcript.
- Stop invariant is TOTAL SEQUENCE LENGTH (trained window 2048): chunks over ~2200
  total tokens stop early with a CLEAN EOS and silently drop the remaining text (never
  a loop). Ladder: 1500 chars 3/3 failed, 750 chars 5/6 failed, 375 chars 12/12 clean.
  => the chunk-sizing cap for this engine is tokens-in-window (prompt + reference +
  audio), not chars/sec; the manifest's caps object must be per (engine, voice).
- EOS fires reliably unaided: no boost/floor needed (Orpheus-specific levers stay
  behind the Orpheus backend).
- Serving: plain Llama causal LM with an extended vocab; TokensPrompt in, ids out,
  decode outside; transformers bf16 single-stream 20 tok/s (0.38x realtime, 19 GB).
- License CC BY-NC 4.0 (personal use here; Owen: not a blocker).
- Fine-tune prepared on the Mac (MLX bf16, LoRA r32 attn+MLP, 20.6 GB peak, 3.1 s/it)
  but NOT run: Owen wants Higgs auditioned first; Higgs notes follow, and the engine
  interface is extracted after BOTH are in hand.
