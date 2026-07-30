"""rubric-serve — hold the block-category adapter resident and classify pages.

    python rubric-serve.py --adapter /home/telltale/xtts_ft/rubric_v2_lora \
        [--port 8770] [--batch 4] [--max-seq-length 7168]

The model lives on the training box's GPU and the app runs on a different
machine, so classification crosses a network boundary. It is a resident service
rather than a subprocess per request because loading a 4-bit 4B model costs
~30 seconds and a book is hundreds of pages: paying that once per book is
tolerable, once per page is not.

POST /classify  {"pages": [{"system": ..., "user": ...}, ...]}
             -> {"answers": ["1 header\n2 body\n...", ...]}
GET  /health -> {"ok": true, "adapter": ..., "loaded": true}

The prompt is built by the CALLER (rubric-encoder.ts), never here. This
service knows nothing about blocks, geometry or normalizers — it is a text in,
text out wrapper. That keeps exactly one implementation of the prompt format,
which is the thing a fine-tune is most brittle about.
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE: dict = {"model": None, "tokenizer": None, "adapter": None, "lock": threading.Lock()}


def load(adapter: str, max_seq_length: int) -> None:
    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=adapter, max_seq_length=max_seq_length,
        dtype=None, load_in_4bit=True)
    FastLanguageModel.for_inference(model)
    # Decoder-only batched generation must pad on the LEFT, or the shorter
    # prompts in a batch end with pad tokens and the model continues from
    # padding instead of from the block list.
    tokenizer.padding_side = "left"
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    STATE["model"] = model
    STATE["tokenizer"] = tokenizer
    STATE["adapter"] = adapter
    print(f"[rubric] loaded {adapter}", flush=True)


def classify(pages: list[dict], batch: int) -> list[str]:
    import torch

    model, tokenizer = STATE["model"], STATE["tokenizer"]
    answers: list[str] = []
    for start in range(0, len(pages), batch):
        chunk = pages[start:start + batch]
        prompts = [
            tokenizer.apply_chat_template(
                [{"role": "system", "content": p["system"]},
                 {"role": "user", "content": p["user"]}],
                tokenize=False, add_generation_prompt=True, enable_thinking=False)
            for p in chunk
        ]
        enc = tokenizer(prompts, return_tensors="pt", padding=True,
                        add_special_tokens=False).to(model.device)
        # One answer line per block, ~8 tokens each. Size from the block count
        # the prompt actually carries so a long page is never cut off mid-answer;
        # the trailing "N blocks" of the header line is that count.
        want = 0
        for p in chunk:
            head = p["user"].split("\n", 1)[0]
            n = [int(t) for t in head.replace(",", " ").split() if t.isdigit()]
            want = max(want, n[-1] if n else 40)
        with torch.no_grad():
            out = model.generate(
                **enc, max_new_tokens=want * 10 + 48, do_sample=False,
                temperature=None, top_p=None, top_k=None,
                pad_token_id=tokenizer.pad_token_id)
        gen = out[:, enc["input_ids"].shape[1]:]
        answers.extend(tokenizer.batch_decode(gen, skip_special_tokens=True))
        print(f"[rubric]   {min(start + batch, len(pages))}/{len(pages)} pages",
              flush=True)
    return answers


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    batch = 4

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        self._send(200, {"ok": True, "adapter": STATE["adapter"],
                         "loaded": STATE["model"] is not None})

    def do_POST(self) -> None:
        if self.path != "/classify":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            pages = req.get("pages") or []
            if not isinstance(pages, list) or not pages:
                self._send(400, {"error": "pages must be a non-empty list"})
                return
            # One request at a time: the GPU is the serial resource, and
            # queueing here is honest about that rather than letting two
            # requests race into an out-of-memory.
            with STATE["lock"]:
                answers = classify(pages, req.get("batch") or self.batch)
            self._send(200, {"answers": answers})
        except Exception as exc:  # surfaced to the caller, never swallowed
            import traceback
            traceback.print_exc()
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt: str, *a) -> None:
        print(f"[rubric] {fmt % a}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--max-seq-length", type=int, default=7168)
    args = ap.parse_args()

    load(args.adapter, args.max_seq_length)
    Handler.batch = args.batch
    # 0.0.0.0: the caller is another machine on the LAN, not localhost.
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[rubric] listening on :{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
