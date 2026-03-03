#!/usr/bin/env python3
"""
PaddleOCR wrapper for BookForge.

Uses PaddlePaddle's PaddleOCR for text recognition and optional layout detection.
Install: pip install paddleocr paddlepaddle

Usage:
  Single image:
    python ocr-paddleocr.py --image <path> [--version PP-OCRv5] [--language en] [--layout]

  Batch mode (persistent process, reads paths from stdin):
    python ocr-paddleocr.py --batch [--version PP-OCRv4] [--language en] [--layout]
    Then send one image path per line on stdin.
    Outputs one JSON object per line on stdout (newline-delimited JSON).
    Send empty line or EOF to exit.

Output: JSON to stdout with { text, confidence, textLines, layoutBlocks? }
Errors: stderr

Note: PaddleOCR downloads models on first run (~150MB). This is normal.
"""

import argparse
import json
import sys
import os
import warnings

# Suppress verbose logging from PaddlePaddle
os.environ["GLOG_minloglevel"] = "2"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
# Limit internal thread count to reduce segfault risk on macOS
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("FLAGS_num_threads", "4")
warnings.filterwarnings("ignore")

# Map PaddleOCR layout labels to Surya-compatible labels
LAYOUT_LABEL_MAP = {
    "text": "Text",
    "title": "Title",
    "figure": "Figure",
    "figure_caption": "Caption",
    "table": "Table",
    "table_caption": "Caption",
    "header": "PageHeader",
    "footer": "PageFooter",
    "reference": "Footnote",
    "equation": "Formula",
    "list": "ListItem",
    "abstract": "Text",
    "content": "Text",
    "seal": "Picture",
    "logo": "Picture",
}

# Module-level references initialized once
_ocr_engine = None
_layout_engine = None


def _init_ocr(ocr_version: str, language: str):
    """Initialize the PaddleOCR engine once."""
    global _ocr_engine
    from paddleocr import PaddleOCR
    import inspect

    kwargs = dict(ocr_version=ocr_version, lang=language)
    sig_params = inspect.signature(PaddleOCR.__init__).parameters

    # PaddleOCR 3.x: disable expensive preprocessing (saves ~15s/page)
    for param, value in [
        ("use_doc_orientation_classify", False),
        ("use_doc_unwarping", False),
        ("use_textline_orientation", False),
    ]:
        if param in sig_params:
            kwargs[param] = value

    # PaddleOCR 2.x params (removed in 3.x)
    if "show_log" in sig_params:
        kwargs["show_log"] = False
    if "use_angle_cls" in sig_params:
        kwargs["use_angle_cls"] = True

    _ocr_engine = PaddleOCR(**kwargs)


def _init_layout(language: str):
    """Initialize the layout engine once."""
    global _layout_engine
    try:
        # PaddleOCR 3.x uses LayoutDetection (PPStructure was removed)
        from paddleocr import LayoutDetection
        _layout_engine = LayoutDetection(model_name='PP-DocLayout-L')
    except ImportError:
        try:
            # PaddleOCR 2.x fallback
            from paddleocr import PPStructure
            import inspect
            kwargs = dict(lang=language, table=False, ocr=False)
            sig_params = inspect.signature(PPStructure.__init__).parameters
            if "show_log" in sig_params:
                kwargs["show_log"] = False
            _layout_engine = PPStructure(**kwargs)
        except Exception as e:
            print(f"Warning: Layout engine init failed: {e}", file=sys.stderr)
            _layout_engine = None
    except Exception as e:
        print(f"Warning: Layout engine init failed: {e}", file=sys.stderr)
        _layout_engine = None


def _extract_from_result(page_result) -> tuple:
    """Extract rec_texts, rec_scores, rec_boxes from a Result object.

    PaddleOCR 3.x returns Result objects with a .json property:
      r.json = { "res": { "rec_texts": [...], "rec_scores": [...], "rec_boxes": [...] } }
    PaddleOCR 2.x returned objects with direct attributes.
    """
    # PaddleOCR 3.x: Result objects have a .json property (dict)
    if hasattr(page_result, 'json'):
        data = page_result.json
        if isinstance(data, dict):
            # In 3.x, results are nested under 'res'
            res = data.get('res', data)
            if isinstance(res, dict) and 'rec_texts' in res:
                return (
                    res.get('rec_texts', []),
                    res.get('rec_scores', []),
                    res.get('rec_boxes', []),
                )

    # PaddleOCR 2.x fallback: direct attributes
    if hasattr(page_result, 'rec_texts'):
        return (
            getattr(page_result, 'rec_texts', []),
            getattr(page_result, 'rec_scores', []),
            getattr(page_result, 'rec_boxes', []),
        )

    return ([], [], [])


def recognize(image_path: str, with_layout: bool = False) -> dict:
    """Run PaddleOCR on an image using the pre-initialized engine."""
    if not os.path.exists(image_path):
        return {"error": f"Image file not found: {image_path}", "text": "", "confidence": 0, "textLines": []}

    result = _ocr_engine.predict(image_path)

    text_lines = []
    all_text_parts = []
    total_confidence = 0.0

    for page_result in result:
        if page_result is None:
            continue

        rec_texts, rec_scores, rec_boxes = _extract_from_result(page_result)

        if not rec_texts:
            continue

        for i in range(len(rec_texts)):
            text = rec_texts[i] if i < len(rec_texts) else ""
            score = float(rec_scores[i]) if i < len(rec_scores) else 0.0
            box = rec_boxes[i] if i < len(rec_boxes) else None

            if not text.strip():
                continue

            bbox = [0, 0, 0, 0]
            if box is not None:
                bbox = [int(box[0]), int(box[1]), int(box[2]), int(box[3])]

            text_lines.append({
                "text": text,
                "confidence": round(score, 4),
                "bbox": bbox
            })

            all_text_parts.append(text)
            total_confidence += score

    avg_confidence = total_confidence / len(text_lines) if text_lines else 1.0

    output = {
        "text": "\n".join(all_text_parts),
        "confidence": round(avg_confidence, 4),
        "textLines": text_lines
    }

    if with_layout and _layout_engine is not None:
        layout_blocks = detect_layout(image_path)
        if layout_blocks:
            output["layoutBlocks"] = layout_blocks

    return output


def detect_layout(image_path: str) -> list:
    """Run layout detection using the pre-initialized engine."""
    if _layout_engine is None:
        return []

    try:
        # Detect API version by checking for predict() method (3.x)
        if hasattr(_layout_engine, 'predict'):
            return _detect_layout_v3(image_path)
        else:
            return _detect_layout_v2(image_path)
    except Exception as e:
        print(f"Warning: Layout detection failed: {e}", file=sys.stderr)
        return []


def _detect_layout_v3(image_path: str) -> list:
    """Layout detection using PaddleOCR 3.x LayoutDetection.predict()."""
    result = _layout_engine.predict(image_path)
    if not result:
        return []

    blocks = []
    for r in result:
        data = r.json
        res = data.get('res', data)
        box_list = res.get('boxes', [])

        for i, box_info in enumerate(box_list):
            label_raw = box_info.get("label", "text").lower()
            label = LAYOUT_LABEL_MAP.get(label_raw, "Text")
            coord = box_info.get("coordinate", [0, 0, 0, 0])
            confidence = box_info.get("score", 0.9)

            blocks.append({
                "bbox": [int(coord[0]), int(coord[1]), int(coord[2]), int(coord[3])],
                "polygon": [],
                "label": label,
                "confidence": round(float(confidence), 4),
                "position": i
            })

    blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
    for i, block in enumerate(blocks):
        block["position"] = i

    return blocks


def _detect_layout_v2(image_path: str) -> list:
    """Layout detection using PaddleOCR 2.x PPStructure."""
    result = _layout_engine(image_path)
    if not result:
        return []

    blocks = []
    for i, region in enumerate(result):
        label_raw = region.get("type", "text").lower()
        label = LAYOUT_LABEL_MAP.get(label_raw, "Text")
        bbox = region.get("bbox", [0, 0, 0, 0])
        confidence = region.get("score", 0.9)

        blocks.append({
            "bbox": [int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])],
            "polygon": [],
            "label": label,
            "confidence": round(float(confidence), 4),
            "position": i
        })

    blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
    for i, block in enumerate(blocks):
        block["position"] = i

    return blocks


def run_batch(with_layout: bool) -> None:
    """Batch mode: read image paths from stdin, output JSON per line."""
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            break

        try:
            result = recognize(image_path, with_layout)
        except Exception as e:
            result = {"error": str(e), "text": "", "confidence": 0, "textLines": []}

        print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description="PaddleOCR for BookForge")
    parser.add_argument("--image", help="Path to image file (single mode)")
    parser.add_argument("--batch", action="store_true",
                        help="Batch mode: read image paths from stdin, one per line")
    parser.add_argument("--version", default="PP-OCRv4",
                        choices=["PP-OCRv5", "PP-OCRv4", "PP-OCRv3"],
                        help="OCR version (default: PP-OCRv4)")
    parser.add_argument("--language", default="en",
                        help="Language code (default: en)")
    parser.add_argument("--layout", action="store_true",
                        help="Enable layout detection")
    args = parser.parse_args()

    # Initialize engines once (heavy imports + model loading)
    try:
        _init_ocr(args.version, args.language)
    except ImportError as e:
        print(f"Error: {e}. Install with: pip install paddleocr paddlepaddle", file=sys.stderr)
        sys.exit(1)

    if args.layout:
        _init_layout(args.language)

    if args.batch:
        run_batch(args.layout)
    elif args.image:
        result = recognize(args.image, args.layout)
        print(json.dumps(result))
    else:
        parser.error("Either --image or --batch is required")


if __name__ == "__main__":
    main()
