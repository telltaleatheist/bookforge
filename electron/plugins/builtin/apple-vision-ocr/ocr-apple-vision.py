#!/usr/bin/env python3
"""
Apple Vision OCR wrapper for BookForge.

Uses the `ocrmac` package which wraps Apple's VNRecognizeTextRequest via PyObjC.
Install: pip install ocrmac Pillow

Usage:
  Single image:
    python ocr-apple-vision.py --image <path> [--level fast|accurate]

  Batch mode (persistent process, reads paths from stdin):
    python ocr-apple-vision.py --batch [--level fast|accurate]
    Then send one image path per line on stdin.
    Outputs one JSON object per line on stdout (newline-delimited JSON).
    Send empty line or EOF to exit.

Output: JSON to stdout with { text, confidence, textLines }
Errors: stderr
"""

import argparse
import json
import sys
import os


def _init():
    """Import heavy dependencies once."""
    global ocrmac_mod, Image
    from ocrmac import ocrmac as _ocrmac
    from PIL import Image as _Image
    ocrmac_mod = _ocrmac
    Image = _Image


def recognize(image_path: str, level: str = "accurate") -> dict:
    """Run Apple Vision OCR on an image and return structured results."""
    if not os.path.exists(image_path):
        return {"error": f"Image file not found: {image_path}", "text": "", "confidence": 0, "textLines": []}

    # Get image dimensions for converting normalized coords to absolute pixels
    with Image.open(image_path) as img:
        img_width, img_height = img.size

    recognition_level = "accurate" if level != "fast" else "fast"

    # Run OCR
    # ocrmac.OCR returns list of (text, confidence, (x, y, w, h))
    # where coordinates are normalized 0-1, origin at bottom-left
    annotations = ocrmac_mod.OCR(
        image_path,
        recognition_level=recognition_level
    ).recognize()

    text_lines = []
    all_text_parts = []
    total_confidence = 0.0

    for text, confidence, bbox in annotations:
        # bbox is (x, y, w, h) normalized, origin bottom-left
        # Convert to absolute pixel coords [x1, y1, x2, y2] with origin top-left
        nx, ny, nw, nh = bbox

        x1 = int(nx * img_width)
        # Flip Y axis: bottom-left origin -> top-left origin
        y1 = int((1.0 - ny - nh) * img_height)
        x2 = int((nx + nw) * img_width)
        y2 = int((1.0 - ny) * img_height)

        text_lines.append({
            "text": text,
            "confidence": round(confidence, 4),
            "bbox": [x1, y1, x2, y2]
        })

        all_text_parts.append(text)
        total_confidence += confidence

    avg_confidence = total_confidence / len(text_lines) if text_lines else 1.0

    return {
        "text": "\n".join(all_text_parts),
        "confidence": round(avg_confidence, 4),
        "textLines": text_lines
    }


def run_batch(level: str) -> None:
    """Batch mode: read image paths from stdin, output JSON per line."""
    # Signal ready after imports are done
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            break

        try:
            result = recognize(image_path, level)
        except Exception as e:
            result = {"error": str(e), "text": "", "confidence": 0, "textLines": []}

        print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Apple Vision OCR for BookForge")
    parser.add_argument("--image", help="Path to image file (single mode)")
    parser.add_argument("--batch", action="store_true",
                        help="Batch mode: read image paths from stdin, one per line")
    parser.add_argument("--level", choices=["fast", "accurate"], default="accurate",
                        help="Recognition level (default: accurate)")
    args = parser.parse_args()

    # Import heavy deps once
    try:
        _init()
    except ImportError as e:
        print(f"Error: {e}. Install with: pip install ocrmac Pillow", file=sys.stderr)
        sys.exit(1)

    if args.batch:
        run_batch(args.level)
    elif args.image:
        result = recognize(args.image, args.level)
        print(json.dumps(result))
    else:
        parser.error("Either --image or --batch is required")


if __name__ == "__main__":
    main()
