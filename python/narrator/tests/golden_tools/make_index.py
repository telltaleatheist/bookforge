"""Write C:\\tmp\\narrator-golden\\index.json (CONTRACTS.md 'Golden fixtures').

Top-level keys are the slugs, as CONTRACTS.md specifies ("maps slug -> {...}").
Non-slug metadata lives under "_meta" so a consumer can iterate the slugs.
"""
import json, os

G = r'C:\tmp\narrator-golden'

# THE CHECKOUT IS FOUND, NOT SPELLED OUT. This file sits at
# <repo>/python/narrator/tests/golden_tools/, so the repo is four levels up —
# true in the main checkout and in every worktree. It used to be an absolute
# path under one account, which named a directory that exists on one machine
# and, in a public repo, published that machine's layout.
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    os.pardir, os.pardir, os.pardir, os.pardir))

# THE LIBRARY IS NAMED BY THE MACHINE THAT HAS IT. `sourceProcessDir` and
# `sourceShippedM4b` below are PROVENANCE — where each fixture was cut from —
# and the library's root is a fact about where you mounted it, not about the
# repo. No default: a wrong root would record provenance that points nowhere.
LIBRARY = os.environ.get('BOOKFORGE_LIBRARY', '').strip()
if not LIBRARY:
    raise SystemExit(
        'BOOKFORGE_LIBRARY is not set. It is the root of the BookForge library the\n'
        'golden fixtures were cut from (the drive or share holding projects/), and\n'
        'this tool records it as each fixture\'s provenance. Set it and re-run.')


def lib(*parts):
    """A path inside the library, spelled with this machine's separator."""
    return os.path.join(LIBRARY, *parts)

SLUGS = {
    'kershaw': {
        'sessionDir': 'ebook-ccd14111-da29-4fb0-a489-a19a0f126bac',
        'hash': '645fe7068635f759cbda0b8a6d3a348d',
        'sentencesSub': 'chapters/sentences',
        'chapters': 'auto',
        'sourceProcessDir': lib("projects", "Working_Towards_The_Fuhrer_-_Ian_Kershaw_(1993)", "stages", "03-tts", "sessions", "en", "ebook-ccd14111-da29-4fb0-a489-a19a0f126bac", "645fe7068635f759cbda0b8a6d3a348d"),
        'sourceShippedM4b': lib("projects", "Working_Towards_The_Fuhrer_-_Ian_Kershaw_(1993)", "output", "Working Towards The Fuhrer. Kershaw, Ian. (1993).m4b"),
        'totalSentences': 133, 'renderedChunks': 133, 'coveredChunks': 133,
        'totalChapters': 1, 'coveredChapters': 1, 'partial': False,
        'referenceNote': ('Regenerated. The shipped m4b was assembled from a deleted '
                          'output/.gap-step_* dir of silence-padded copies (8.545 s longer); '
                          'the shipped .m4b.vtt is an ffmpeg mov_text round-trip, not e2a output.'),
    },
    'blacksun': {
        'sessionDir': 'ebook-ce93d332-1c6a-47b1-86f2-6dec63306486',
        'hash': 'febf51344d17f8fb91d23d60f05b0467',
        'sentencesSub': 'chapters/sentences',
        'chapters': 'auto',
        'sourceProcessDir': lib("projects", "Black_Sun_-_Aryan_Cults,_Esoteric_Nazism,_and_the_Politics_of_Identity_-_Nicholas_Goodrick-Clarke_(2009)", "stages", "03-tts", "sessions", "en", "ebook-ce93d332-1c6a-47b1-86f2-6dec63306486", "febf51344d17f8fb91d23d60f05b0467"),
        'sourceShippedM4b': lib("projects", "Black_Sun_-_Aryan_Cults,_Esoteric_Nazism,_and_the_Politics_of_Identity_-_Nicholas_Goodrick-Clarke_(2009)", "output", "Black Sun - Aryan Cults, Esoteric Nazism, and the Politics of Identity. Goodrick-Clarke, Nicholas. (2009).m4b"),
        'totalSentences': 2358, 'renderedChunks': 512, 'coveredChunks': 397,
        'totalChapters': 18, 'coveredChapters': 3, 'partial': True,
        'referenceNote': ('PARTIAL SESSION: 512 of 2358 chunks rendered, so only the completed '
                          'prefix (chapters 1-3, 397 chunks) is assemblable - use --chapters auto. '
                          'The shipped m4b is an older, complete, 2358-chunk render and is NOT '
                          'this session. No cover.jpg exists although session-state says '
                          '"cover": true, so the reference m4b has no cover stream.'),
    },
    'mutineer': {
        'sessionDir': 'ebook-88c038b1-cfa1-425b-9226-af6ff456b029',
        'hash': '26f7053065303c4008bfc02aa51fe83c',
        'sentencesSub': 'chapters/sentences-denoised',
        'chapters': 'auto',
        'sourceProcessDir': lib("projects", "Mutineer_s_Moon_-_David_Weber_(2020)", "stages", "03-tts", "sessions", "en", "ebook-88c038b1-cfa1-425b-9226-af6ff456b029", "26f7053065303c4008bfc02aa51fe83c"),
        'sourceShippedM4b': lib("projects", "Mutineer_s_Moon_-_David_Weber_(2020)", "output", "Mutineer's Moon (Dahak Book 1). Weber, David. (1991).m4b"),
        'totalSentences': 1400, 'renderedChunks': 1400, 'coveredChunks': 1400,
        'totalChapters': 25, 'coveredChapters': 25, 'partial': False,
        'referenceNote': ('Assembled from chapters/sentences-denoised - the dir e2a actually used '
                          '(1240 of 1400 chunks differ in length from chapters/sentences; the raw '
                          'dir is 26.3 s longer over the book). Regenerated with --no_split: '
                          'without it e2a splits at default_output_split_hours and every part '
                          'exports to the same final_name, so part 2 overwrites part 1 and the '
                          'm4b becomes the book\'s tail (14281 s, starting at Chapter Sixteen).'),
    },
}

index = {
    '_meta': {
        'note': ('Local binary copies of the golden e2a sessions. NOT committed. '
                 'Tests read NARRATOR_GOLDEN_LOCAL (default C:\\tmp\\narrator-golden) '
                 'and SKIP when it is absent. Committed text fixtures are in '
                 'python/narrator/tests/golden/<slug>/.'),
        'e2aCommit': '9daab0ba9360b4e9e8d538bd6da9b713fed2de21',
        'builtBy': 'builder G, 2026-09-04',
        'assembleCommand': ('app.py --headless --assemble_only --skip_deps --no_split '
                            '--tts_engine xtts --session <uuid> --session_dir <localSessionDir> '
                            '[--chapters auto] [--sentences_dir <sentencesDir>] '
                            '--output_dir <out>   (env: E2A_TMP_DIR, PYTHONIOENCODING=utf-8)'),
        'slugs': sorted(SLUGS),
    },
}

for slug, cfg in SLUGS.items():
    base = os.path.join(G, slug)
    process_dir = os.path.join(base, cfg['sessionDir'], cfg['hash'])
    entry = {
        # The four keys CONTRACTS.md names, plus the sentences dir the
        # reference was assembled FROM (a parity input) and `chapters`.
        'localProcessDir': process_dir,
        'sentencesDir': os.path.join(process_dir, cfg['sentencesSub'].replace('/', os.sep)),
        'referenceM4b': os.path.join(base, 'reference.m4b'),
        'referenceVtt': os.path.join(base, 'reference.vtt'),
        'sourceProcessDir': cfg['sourceProcessDir'],
        'chapters': cfg['chapters'],
        # Extras.
        'sentencesDirRelative': cfg['sentencesSub'],
        'localSessionDir': os.path.join(base, cfg['sessionDir']),
        'sessionId': cfg['sessionDir'][len('ebook-'):],
        'shippedM4b': os.path.join(base, 'shipped.m4b'),
        'shippedVtt': os.path.join(base, 'shipped.m4b.vtt'),
        'sourceShippedM4b': cfg['sourceShippedM4b'],
        'fixture': os.path.join(REPO, 'python', 'narrator', 'tests', 'golden', slug),
        'totalSentences': cfg['totalSentences'],
        'renderedChunks': cfg['renderedChunks'],
        'coveredChunks': cfg['coveredChunks'],
        'totalChapters': cfg['totalChapters'],
        'coveredChapters': cfg['coveredChapters'],
        'partial': cfg['partial'],
        'referenceRegenerated': True,
        'referenceNote': cfg['referenceNote'],
    }
    for key in ('localProcessDir', 'sentencesDir', 'referenceM4b', 'referenceVtt',
                'localSessionDir', 'fixture'):
        if not os.path.exists(entry[key]):
            raise FileNotFoundError('%s: %s missing at %s' % (slug, key, entry[key]))
    n = len([f for f in os.listdir(entry['sentencesDir']) if f.endswith('.flac')])
    if n != cfg['renderedChunks']:
        raise ValueError('%s: %d FLACs in %s, expected %d'
                         % (slug, n, entry['sentencesDir'], cfg['renderedChunks']))
    index[slug] = entry

with open(os.path.join(G, 'index.json'), 'w', encoding='utf-8') as f:
    json.dump(index, f, indent=2)
    f.write('\n')

print('wrote', os.path.join(G, 'index.json'))
for slug in index['_meta']['slugs']:
    e = index[slug]
    print('  %-9s %4d/%-4d chunks  %2d/%-2d chapters  from %s'
          % (slug, e['coveredChunks'], e['totalSentences'],
             e['coveredChapters'], e['totalChapters'], e['sentencesDirRelative']))
