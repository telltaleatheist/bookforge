#!/usr/bin/env python3
"""
Apple Vision OCR wrapper for BookForge.

Uses the `ocrmac` package which wraps Apple's VNRecognizeTextRequest via PyObjC.
Install: pip install ocrmac Pillow

Usage:
  python ocr-apple-vision.py --image <path> [--level fast|accurate]

Output: JSON to stdout with { text, confidence, textLines }
Errors: stderr
"""

import argparse
import json
import sys
import os


def recognize(image_path: str, level: str = "accurate") -> dict:
    """Run Apple Vision OCR on an image and return structured results."""
    try:
        from ocrmac import ocrmac
    except ImportError:
        print("Error: ocrmac package not installed. Install with: pip install ocrmac", file=sys.stderr)
        sys.exit(1)

    try:
        from PIL import Image
    except ImportError:
        print("Error: Pillow package not installed. Install with: pip install Pillow", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(image_path):
        print(f"Error: Image file not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    # Get image dimensions for converting normalized coords to absolute pixels
    with Image.open(image_path) as img:
        img_width, img_height = img.size

    # Map level names to Apple Vision recognition levels
    # ocrmac uses recognition_level parameter
    recognition_level = "accurate"
    if level == "fast":
        recognition_level = "fast"

    # Run OCR
    # ocrmac.OCR returns list of (text, confidence, (x, y, w, h))
    # where coordinates are normalized 0-1, origin at bottom-left
    annotations = ocrmac.OCR(
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


def main():
    parser = argparse.ArgumentParser(description="Apple Vision OCR for BookForge")
    parser.add_argument("--image", required=True, help="Path to image file")
    parser.add_argument("--level", choices=["fast", "accurate"], default="accurate",
                        help="Recognition level (default: accurate)")
    args = parser.parse_args()

    result = recognize(args.image, args.level)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
