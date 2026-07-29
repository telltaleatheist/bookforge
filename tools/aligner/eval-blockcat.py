"""eval-blockcat — score a trained block_categorize adapter on the held-out set.

    python eval-blockcat.py --adapter /home/telltale/xtts_ft/blockcat_v1_lora \
        --eval ~/training_data/block_categorize/eval.jsonl \
        --out ~/training_data/block_categorize/eval_report.json [--limit N]

eval_loss says the model is improving. It does NOT say whether `table` works, or
that `subheading` is being swallowed by `heading`. This produces the confusion
matrix that decides which books and classes still need data — which is the whole
reason the corpus was assembled for layout variety rather than volume.

Scoring is per BLOCK, not per page: a page is right or wrong in fifteen places.

Three failure modes are counted separately rather than folded into accuracy,
because they call for completely different fixes:
  - wrong category      -> needs data (or a better feature)
  - miscounted blocks   -> the model dropped or invented lines; a format failure
  - unparseable line    -> the output contract itself is not being honoured
Blocks the model never labels are scored as errors, never skipped. Silently
dropping them would let a model that answers half the page look accurate.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict

CATEGORIES = [
    "body", "title", "chapter", "heading", "subheading", "quote", "caption",
    "footnote", "header", "footer", "image", "table", "list",
]
LINE = re.compile(r"^\s*(\d+)\s+([a-z_]+)\s*$")


def parse_answer(text: str) -> tuple[dict[int, str], int]:
    """-> ({block id: category}, unparseable line count). Last line wins on
    duplicates; a repeated id is the model correcting itself mid-answer."""
    out: dict[int, str] = {}
    bad = 0
    for raw in text.strip().splitlines():
        if not raw.strip():
            continue
        m = LINE.match(raw)
        if not m:
            bad += 1
            continue
        out[int(m.group(1))] = m.group(2)
    return out, bad


def build_prompt(tokenizer, messages, template_kwargs):
    return tokenizer.apply_chat_template(
        messages[:-1], tokenize=False, add_generation_prompt=True, **template_kwargs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--eval", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--max-seq-length", type=int, default=8192)
    # Load the base at the precision the adapter TRAINED against. The 4B runs
    # are QLoRA (NF4 base); the 0.6B is plain LoRA on bf16 weights, and scoring
    # it against a quantized base measures the quantizer as much as the model.
    ap.add_argument("--no-4bit", action="store_true",
                    help="load the base in bf16 instead of NF4")
    args = ap.parse_args()

    import torch
    from unsloth import FastLanguageModel

    rows = []
    with open(args.eval, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    if args.limit:
        rows = rows[:args.limit]
    print(f"[eval] {len(rows)} pages from {args.eval}", flush=True)

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.adapter, max_seq_length=args.max_seq_length,
        dtype=None, load_in_4bit=not args.no_4bit)
    FastLanguageModel.for_inference(model)
    # Decoder-only batched generation must pad on the LEFT, or the shorter
    # prompts in a batch end with pad tokens and the model continues from
    # padding instead of from the block list.
    tokenizer.padding_side = "left"
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    template_kwargs = {"enable_thinking": False}
    confusion: Counter = Counter()          # (truth, predicted) -> n
    per_book: dict[str, Counter] = defaultdict(Counter)
    bad_lines = 0
    missing_blocks = 0                      # in truth, absent from prediction
    extra_blocks = 0                        # predicted, not in truth
    bad_category = 0                        # parsed but not a legal class
    page_exact = 0
    examples: list[dict] = []

    for start in range(0, len(rows), args.batch):
        chunk = rows[start:start + args.batch]
        prompts = [build_prompt(tokenizer, r["messages"], template_kwargs) for r in chunk]
        enc = tokenizer(prompts, return_tensors="pt", padding=True,
                        add_special_tokens=False).to(model.device)
        # Answers are "<id> <category>" per block, ~8 tokens each. Size from the
        # actual block count so a long page is never cut off mid-answer.
        want = max(len(r["messages"][2]["content"].splitlines()) for r in chunk)
        with torch.no_grad():
            out = model.generate(
                **enc, max_new_tokens=want * 10 + 48, do_sample=False,
                temperature=None, top_p=None, top_k=None,
                pad_token_id=tokenizer.pad_token_id)
        gen = out[:, enc["input_ids"].shape[1]:]
        texts = tokenizer.batch_decode(gen, skip_special_tokens=True)

        for row, text in zip(chunk, texts):
            truth, _ = parse_answer(row["messages"][2]["content"])
            pred, bad = parse_answer(text)
            bad_lines += bad
            book = row.get("book", "?")
            ok = True
            for bid, gold in truth.items():
                got = pred.get(bid)
                if got is None:
                    missing_blocks += 1
                    confusion[(gold, "<missing>")] += 1
                    per_book[book]["wrong"] += 1
                    ok = False
                    continue
                if got not in CATEGORIES:
                    bad_category += 1
                    confusion[(gold, "<illegal>")] += 1
                    per_book[book]["wrong"] += 1
                    ok = False
                    continue
                confusion[(gold, got)] += 1
                if got == gold:
                    per_book[book]["right"] += 1
                else:
                    per_book[book]["wrong"] += 1
                    ok = False
                    if len(examples) < 60:
                        examples.append({"book": book, "page": row.get("page"),
                                         "block": bid, "truth": gold, "pred": got})
            extra_blocks += len(set(pred) - set(truth))
            if ok and len(pred) == len(truth):
                page_exact += 1
        done = min(start + args.batch, len(rows))
        print(f"[eval]   {done}/{len(rows)} pages", flush=True)

    total = sum(confusion.values())
    correct = sum(n for (t, p), n in confusion.items() if t == p)

    # Per-class precision/recall/F1. Predictions of <missing>/<illegal> count
    # against recall but belong to no class's precision.
    report_classes = {}
    for cat in CATEGORIES:
        tp = confusion[(cat, cat)]
        fn = sum(n for (t, p), n in confusion.items() if t == cat and p != cat)
        fp = sum(n for (t, p), n in confusion.items() if p == cat and t != cat)
        support = tp + fn
        if not support and not fp:
            continue
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / support if support else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        report_classes[cat] = {"support": support, "precision": round(prec, 4),
                               "recall": round(rec, 4), "f1": round(f1, 4),
                               "tp": tp, "fp": fp, "fn": fn}

    confusions = sorted(((n, t, p) for (t, p), n in confusion.items() if t != p),
                        reverse=True)
    # Macro-F1 over the classes that actually occur: the corpus is 60% body, so
    # plain accuracy moves barely at all when a small class collapses entirely.
    macro_f1 = (sum(m["f1"] for m in report_classes.values()) / len(report_classes)
                if report_classes else 0.0)
    report = {
        "adapter": args.adapter,
        "pages": len(rows),
        "blocks": total,
        "block_accuracy": round(correct / total, 4) if total else 0.0,
        "macro_f1": round(macro_f1, 4),
        "page_exact_match": round(page_exact / len(rows), 4) if rows else 0.0,
        "format_failures": {"unparseable_lines": bad_lines,
                            "missing_blocks": missing_blocks,
                            "extra_blocks": extra_blocks,
                            "illegal_categories": bad_category},
        "per_class": report_classes,
        "top_confusions": [{"n": n, "truth": t, "pred": p} for n, t, p in confusions[:25]],
        "per_book": {b: {**c, "accuracy": round(c["right"] / (c["right"] + c["wrong"]), 4)}
                     for b, c in ((b, dict(c)) for b, c in per_book.items())
                     if c.get("right", 0) + c.get("wrong", 0)},
        "error_examples": examples,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)

    print(f"\n[eval] blocks={total}  block accuracy={report['block_accuracy']:.4f}"
          f"  macro-F1={report['macro_f1']:.4f}"
          f"  exact pages={report['page_exact_match']:.4f}")
    print(f"[eval] format failures: {report['format_failures']}")
    print(f"\n{'class':<14}{'support':>8}{'prec':>8}{'rec':>8}{'f1':>8}")
    for cat, m in sorted(report_classes.items(), key=lambda kv: -kv[1]["support"]):
        print(f"{cat:<14}{m['support']:>8}{m['precision']:>8.3f}{m['recall']:>8.3f}{m['f1']:>8.3f}")
    print("\ntop confusions (truth -> predicted):")
    for n, t, p in confusions[:15]:
        print(f"  {n:>6}  {t} -> {p}")
    print("\nper book:")
    for b, m in report["per_book"].items():
        print(f"  {b[:44]:<46} {m['accuracy']:.4f}  ({m['right']}/{m['right'] + m['wrong']})")
    print(f"\n[eval] wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
