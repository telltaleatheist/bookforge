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
    _ocr_engine = PaddleOCR(
        ocr_version=ocr_version,
        lang=language,
        show_log=False,
        use_angle_cls=True,
    )


def _init_layout(language: str):
    """Initialize the layout engine once."""
    global _layout_engine
    try:
        from paddleocr import PPStructure
        _layout_engine = PPStructure(
            lang=language,
            show_log=False,
            table=False,
            ocr=False,
        )
    except Exception as e:
        print(f"Warning: Layout engine init failed: {e}", file=sys.stderr)
        _layout_engine = None


def recognize(image_path: str, with_layout: bool = False) -> dict:
    """Run PaddleOCR on an image using the pre-initialized engine."""
    if not os.path.exists(image_path):
        return {"error": f"Image file not found: {image_path}", "text": "", "confidence": 0, "textLines": []}

    result = _ocr_engine.predict(image_path)

    text_lines = []
    all_text_parts = []
    total_confidence = 0.0

    for page_result in result:
        if not page_result or not hasattr(page_result, 'rec_texts'):
            continue

        rec_texts = page_result.rec_texts if hasattr(page_result, 'rec_texts') else []
        rec_scores = page_result.rec_scores if hasattr(page_result, 'rec_scores') else []
        rec_boxes = page_result.rec_boxes if hasattr(page_result, 'rec_boxes') else []

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
    except Exception as e:
        print(f"Warning: Layout detection failed: {e}", file=sys.stderr)
        return []


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
