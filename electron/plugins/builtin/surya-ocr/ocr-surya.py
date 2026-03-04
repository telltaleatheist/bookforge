#!/usr/bin/env python3
"""
Surya OCR persistent worker for BookForge.

Loads Surya models once at startup, then processes images via stdin/stdout.
This avoids the ~30s model loading overhead per page.

Usage:
  Batch mode (persistent process, reads paths from stdin):
    python ocr-surya.py --batch [--layout] [--math]
    Then send one image path per line on stdin.
    Outputs one JSON object per line on stdout (newline-delimited JSON).
    Send empty line or EOF to exit.

  Single image:
    python ocr-surya.py --image <path> [--layout] [--math]

Output: JSON to stdout with { text, confidence, textLines, layoutBlocks? }
"""

import argparse
import json
import sys
import os
import warnings

warnings.filterwarnings("ignore")

# Module-level references initialized once
_rec_predictor = None
_det_predictor = None
_layout_predictor = None


def _get_surya_version():
    """Detect surya-ocr major version: 'v014' for 0.14.x, 'v015plus' for 0.15.0+."""
    # Try importlib.metadata first (most reliable)
    try:
        from importlib.metadata import version as pkg_version
        ver = pkg_version('surya-ocr')
        parts = ver.split('.')
        minor = int(parts[1]) if len(parts) > 1 else 0
        return 'v015plus' if minor >= 15 else 'v014'
    except Exception:
        pass

    # Try module attribute
    try:
        import surya
        ver = getattr(surya, '__version__', None)
        if ver:
            parts = ver.split('.')
            minor = int(parts[1]) if len(parts) > 1 else 0
            return 'v015plus' if minor >= 15 else 'v014'
    except Exception:
        pass

    # Probe for the FoundationPredictor module (only exists in 0.15+)
    try:
        from surya.foundation import FoundationPredictor  # noqa: F401
        return 'v015plus'
    except ImportError:
        return 'v014'


def _init_models(with_layout: bool = False):
    """Load Surya models once. Adapts to both 0.14.x and 0.15+ APIs."""
    global _rec_predictor, _det_predictor, _layout_predictor

    api_version = _get_surya_version()
    print(f"Surya API version detected: {api_version}", file=sys.stderr)

    from surya.recognition import RecognitionPredictor
    from surya.detection import DetectionPredictor

    # DetectionPredictor is self-contained in all versions
    _det_predictor = DetectionPredictor()

    if api_version == 'v015plus':
        # 0.15+: RecognitionPredictor requires a FoundationPredictor
        from surya.foundation import FoundationPredictor
        foundation = FoundationPredictor()
        _rec_predictor = RecognitionPredictor(foundation)
    else:
        # 0.14.x: RecognitionPredictor is self-contained
        _rec_predictor = RecognitionPredictor()

    if with_layout:
        try:
            from surya.layout import LayoutPredictor
            if api_version == 'v015plus':
                from surya.foundation import FoundationPredictor as FP
                from surya.settings import settings
                layout_foundation = FP(checkpoint=settings.LAYOUT_MODEL_CHECKPOINT)
                _layout_predictor = LayoutPredictor(layout_foundation)
            else:
                _layout_predictor = LayoutPredictor()
        except Exception as e:
            print(f"Warning: Layout predictor init failed: {e}", file=sys.stderr)


def recognize(image_path: str, with_layout: bool = False, math_mode: bool = False) -> dict:
    """Run Surya OCR on a single image."""
    if not os.path.exists(image_path):
        return {"error": f"Image file not found: {image_path}", "text": "", "confidence": 0, "textLines": []}

    try:
        from PIL import Image
        img = Image.open(image_path).convert("RGB")
    except Exception as e:
        return {"error": f"Failed to open image: {e}", "text": "", "confidence": 0, "textLines": []}

    # Run OCR
    results = _rec_predictor(
        [img],
        det_predictor=_det_predictor,
        math_mode=math_mode,
    )

    text_lines = []
    if results:
        ocr_result = results[0]
        for line in ocr_result.text_lines:
            text = line.text
            if not text.strip():
                continue

            # Strip residual HTML/math tags
            text = _strip_tags(text)

            # Convert polygon to bbox [x1, y1, x2, y2]
            bbox = _polygon_to_bbox(line.polygon) if line.polygon else [0, 0, 0, 0]
            confidence = line.confidence if line.confidence is not None else 0.9

            text_lines.append({
                "text": text,
                "confidence": round(confidence, 4),
                "bbox": bbox,
            })

    # Filter low-quality lines
    text_lines = [l for l in text_lines if _is_valid_line(l)]

    all_text = "\n".join(l["text"] for l in text_lines)
    avg_confidence = (
        sum(l["confidence"] for l in text_lines) / len(text_lines)
        if text_lines else 1.0
    )

    output = {
        "text": all_text,
        "confidence": round(avg_confidence, 4),
        "textLines": text_lines,
    }

    # Layout detection
    if with_layout and _layout_predictor is not None:
        layout_blocks = detect_layout(img)
        if layout_blocks:
            output["layoutBlocks"] = layout_blocks

    return output


def layout_only(image_path: str) -> dict:
    """Run ONLY layout detection on an image, skipping OCR recognition."""
    if not os.path.exists(image_path):
        return {"error": f"Image file not found: {image_path}", "layoutBlocks": []}

    try:
        from PIL import Image
        img = Image.open(image_path).convert("RGB")
    except Exception as e:
        return {"error": f"Failed to open image: {e}", "layoutBlocks": []}

    blocks = detect_layout(img)
    return {"layoutBlocks": blocks}


def detect_layout(img) -> list:
    """Run layout detection on a PIL Image."""
    if _layout_predictor is None:
        return []

    try:
        results = _layout_predictor([img])
        if not results:
            return []

        layout_result = results[0]
        blocks = []
        for box in layout_result.bboxes:
            bbox = _polygon_to_bbox(box.polygon) if box.polygon else [0, 0, 0, 0]
            blocks.append({
                "bbox": bbox,
                "polygon": [[round(p, 1) for p in point] for point in box.polygon] if box.polygon else [],
                "label": box.label,
                "confidence": round(box.confidence, 4) if box.confidence is not None else 0.9,
                "position": box.position,
            })

        # Sort by reading order (top-to-bottom, left-to-right)
        blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
        for i, block in enumerate(blocks):
            block["position"] = i

        return blocks
    except Exception as e:
        print(f"Warning: Layout detection failed: {e}", file=sys.stderr)
        return []


def _polygon_to_bbox(polygon) -> list:
    """Convert polygon points to [x1, y1, x2, y2] bbox."""
    if not polygon or len(polygon) < 2:
        return [0, 0, 0, 0]
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]


def _strip_tags(text: str) -> str:
    """Strip HTML/math tags that Surya can emit."""
    import re
    return re.sub(r'<[^>]+>', '', text)


def _is_valid_line(line: dict) -> bool:
    """Filter scan artifacts and noise."""
    if line["confidence"] < 0.5:
        return False
    stripped = line["text"].replace(" ", "")
    if len(stripped) <= 1 and all(c in ".-,;:!?*·•" for c in stripped):
        return False
    return True


def run_batch(with_layout: bool, math_mode: bool) -> None:
    """Batch mode: read commands from stdin, output JSON per line.

    Input can be:
      - A plain image path (runs full OCR + optional layout)
      - A JSON object with {"path": "...", "layoutOnly": true} (runs ONLY layout detection, ~10× faster)
    """
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            break

        try:
            # Detect JSON command vs plain image path
            if raw.startswith('{'):
                cmd = json.loads(raw)
                image_path = cmd.get('path', '')
                if cmd.get('layoutOnly'):
                    result = layout_only(image_path)
                else:
                    result = recognize(image_path, with_layout, math_mode)
            else:
                result = recognize(raw, with_layout, math_mode)
        except Exception as e:
            result = {"error": str(e), "text": "", "confidence": 0, "textLines": []}

        print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Surya OCR for BookForge")
    parser.add_argument("--image", help="Path to image file (single mode)")
    parser.add_argument("--batch", action="store_true",
                        help="Batch mode: read image paths from stdin, one per line")
    parser.add_argument("--layout", action="store_true",
                        help="Enable layout detection")
    parser.add_argument("--math", action="store_true",
                        help="Enable math recognition mode")
    parser.add_argument("--device", default=None,
                        help="Device to use: mps, cuda, cpu (default: auto-detect)")
    args = parser.parse_args()

    # Set device before importing surya (surya.settings reads TORCH_DEVICE from env)
    if args.device:
        os.environ['TORCH_DEVICE'] = args.device
        print(f"Device override: {args.device}", file=sys.stderr)

    # Load models once (heavy imports + model loading)
    try:
        _init_models(with_layout=args.layout)
    except ImportError as e:
        print(f"Error: {e}. Install with: pip install surya-ocr", file=sys.stderr)
        sys.exit(1)

    if args.batch:
        run_batch(args.layout, args.math)
    elif args.image:
        result = recognize(args.image, args.layout, args.math)
        print(json.dumps(result))
    else:
        parser.error("Either --image or --batch is required")


if __name__ == "__main__":
    main()
