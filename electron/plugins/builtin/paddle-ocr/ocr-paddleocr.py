#!/usr/bin/env python3
"""
PaddleOCR wrapper for BookForge.

Uses PaddlePaddle's PaddleOCR for text recognition and optional layout detection.
Install: pip install paddleocr paddlepaddle

Usage:
  python ocr-paddleocr.py --image <path> [--version PP-OCRv5] [--language en] [--layout]

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


def recognize(image_path: str, ocr_version: str = "PP-OCRv4",
              language: str = "en", with_layout: bool = False) -> dict:
    """Run PaddleOCR on an image and return structured results."""
    try:
        from paddleocr import PaddleOCR
    except ImportError:
        print("Error: paddleocr package not installed. Install with: pip install paddleocr paddlepaddle",
              file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(image_path):
        print(f"Error: Image file not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    # Initialize PaddleOCR
    # show_log=False suppresses model download progress in production
    ocr = PaddleOCR(
        ocr_version=ocr_version,
        lang=language,
        show_log=False,
        use_angle_cls=True,
    )

    # Run OCR prediction
    result = ocr.predict(image_path)

    text_lines = []
    all_text_parts = []
    total_confidence = 0.0

    # PaddleOCR predict() returns a generator of page results
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

            # rec_boxes are already absolute pixel coords [x_min, y_min, x_max, y_max]
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

    # Layout detection if requested
    if with_layout:
        layout_blocks = detect_layout(image_path, language)
        if layout_blocks:
            output["layoutBlocks"] = layout_blocks

    return output


def detect_layout(image_path: str, language: str = "en") -> list:
    """Run PaddleOCR layout detection and return Surya-compatible blocks."""
    try:
        from paddleocr import PPStructure
    except ImportError:
        print("Warning: PPStructure not available for layout detection", file=sys.stderr)
        return []

    try:
        engine = PPStructure(
            lang=language,
            show_log=False,
            table=False,       # Skip table structure recognition for speed
            ocr=False,         # We only want layout, OCR is done separately
        )

        result = engine(image_path)
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

        # Sort by reading order (top-to-bottom, left-to-right)
        blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
        for i, block in enumerate(blocks):
            block["position"] = i

        return blocks
    except Exception as e:
        print(f"Warning: Layout detection failed: {e}", file=sys.stderr)
        return []


def main():
    parser = argparse.ArgumentParser(description="PaddleOCR for BookForge")
    parser.add_argument("--image", required=True, help="Path to image file")
    parser.add_argument("--version", default="PP-OCRv4",
                        choices=["PP-OCRv5", "PP-OCRv4", "PP-OCRv3"],
                        help="OCR version (default: PP-OCRv4)")
    parser.add_argument("--language", default="en",
                        help="Language code (default: en)")
    parser.add_argument("--layout", action="store_true",
                        help="Enable layout detection")
    args = parser.parse_args()

    result = recognize(args.image, args.version, args.language, args.layout)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
