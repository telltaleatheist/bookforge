#!/usr/bin/env python3
"""
OCR Image Preprocessor for BookForge

Prepares scanned page images for Tesseract OCR by:
1. Removing colored highlights (yellow, green, pink markers)
2. Converting to grayscale
3. Denoising scanner speckle
4. Enhancing contrast via CLAHE

Usage: python3 ocr-preprocess.py <input_path> <output_path>
"""

import sys
import cv2
import numpy as np


def remove_highlights(img: np.ndarray) -> np.ndarray:
    """Replace yellow/green/pink highlight regions with white."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # Yellow highlights: hue ~10-45, low-to-high saturation (scanner highlights wash out)
    yellow_lo = np.array([10, 15, 150], dtype=np.uint8)
    yellow_hi = np.array([45, 255, 255], dtype=np.uint8)

    # Green highlights: hue ~40-85
    green_lo = np.array([35, 15, 150], dtype=np.uint8)
    green_hi = np.array([85, 255, 255], dtype=np.uint8)

    # Pink/magenta highlights: hue ~140-175
    pink_lo = np.array([140, 15, 150], dtype=np.uint8)
    pink_hi = np.array([175, 255, 255], dtype=np.uint8)

    mask = (
        cv2.inRange(hsv, yellow_lo, yellow_hi)
        | cv2.inRange(hsv, green_lo, green_hi)
        | cv2.inRange(hsv, pink_lo, pink_hi)
    )

    # Dilate to catch highlight edges, then close small gaps within highlighted regions
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.dilate(mask, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)

    # Replace highlighted regions with white
    img[mask > 0] = (255, 255, 255)
    return img


def preprocess(input_path: str, output_path: str) -> None:
    img = cv2.imread(input_path)
    if img is None:
        print(f"Error: Could not read image: {input_path}", file=sys.stderr)
        sys.exit(1)

    # 1. Remove colored highlights
    img = remove_highlights(img)

    # 2. Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 3. Light denoise — preserve character detail
    gray = cv2.fastNlMeansDenoising(gray, h=6, templateWindowSize=7, searchWindowSize=21)

    # 4. CLAHE contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Output enhanced grayscale — let Tesseract handle its own binarization
    cv2.imwrite(output_path, gray)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    preprocess(sys.argv[1], sys.argv[2])
