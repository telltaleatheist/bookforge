#!/usr/bin/env python3
"""
Test PyMuPDF redaction with the same PDF to confirm it works.
"""

import pymupdf
import sys

INPUT_PDF = '/tmp/mupdf-redaction-tests/test-input.pdf'
OUTPUT_PDF = '/tmp/mupdf-redaction-tests/result-pymupdf.pdf'

def main():
    print("=== PyMuPDF Redaction Test ===")
    print(f"PyMuPDF version: {pymupdf.version}")

    # Open the test PDF
    doc = pymupdf.open(INPUT_PDF)
    page = doc[0]

    # Show original text
    print("\nOriginal text:")
    print("-" * 40)
    print(page.get_text())
    print("-" * 40)

    # Add redaction annotations (same areas as mupdf.js test)
    # For "SECRET" line around y=700 (PDF coords, y from bottom)
    # But pymupdf uses top-left origin, so we need to convert
    # Page height is 792, so y=700 from bottom = 792-700 = 92 from top

    # Actually let's search for the text to be sure
    secret_rects = page.search_for("SECRET")
    conf_rects = page.search_for("CONFIDENTIAL")

    print(f"\nFound SECRET at: {secret_rects}")
    print(f"Found CONFIDENTIAL at: {conf_rects}")

    for rect in secret_rects:
        page.add_redact_annot(rect)
    for rect in conf_rects:
        page.add_redact_annot(rect)

    # Apply redactions
    page.apply_redactions(images=2, graphics=1)

    # Save with garbage collection
    doc.save(OUTPUT_PDF, garbage=4, deflate=True)
    doc.close()

    # Verify by reopening
    doc2 = pymupdf.open(OUTPUT_PDF)
    page2 = doc2[0]

    print("\nText after redaction:")
    print("-" * 40)
    text = page2.get_text()
    print(text)
    print("-" * 40)

    has_secret = "SECRET" in text
    has_conf = "CONFIDENTIAL" in text
    has_public = "PUBLIC" in text

    print("\nVerification:")
    print(f"  SECRET removed: {'YES' if not has_secret else 'NO (FAILED)'}")
    print(f"  CONFIDENTIAL removed: {'YES' if not has_conf else 'NO (FAILED)'}")
    print(f"  PUBLIC kept: {'YES' if has_public else 'NO (unexpected)'}")

    if not has_secret and not has_conf and has_public:
        print("\n[PASS] PyMuPDF redaction works correctly!")
    else:
        print("\n[FAIL] PyMuPDF redaction also failed")

    print(f"\nOutput saved to: {OUTPUT_PDF}")

if __name__ == '__main__':
    main()
