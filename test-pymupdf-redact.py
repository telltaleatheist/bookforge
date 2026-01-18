#!/usr/bin/env python3
"""
Simple test: Redact a block by coordinates using PyMuPDF
"""
import pymupdf

PDF_PATH = '/Volumes/Callisto/books/ww2/Ethnic Cleansing in the USSR, 1937-1949. Pohl, Otto. (1999).pdf'
OUTPUT = '/tmp/pymupdf-test.pdf'

doc = pymupdf.open(PDF_PATH)
page = doc[16]  # Page 17 (0-indexed as 16)

# The Korenzatsiia block coordinates from structured text:
# bbox: { x: 38, y: 334, w: 323, h: 31 }
# These are screen coords (y=0 at top) - PyMuPDF uses same system

rect = pymupdf.Rect(38, 334, 38 + 323, 334 + 31)
print(f"Redacting rect: {rect}")

# Add redaction and apply
page.add_redact_annot(rect)
page.apply_redactions()

# Save
doc.save(OUTPUT, garbage=4)
doc.close()

print(f"Saved to: {OUTPUT}")

# Verify
doc2 = pymupdf.open(OUTPUT)
page2 = doc2[16]
found = page2.search_for("Korenzatsiia")
print(f"Korenzatsiia found after redaction: {len(found) > 0}")
if not found:
    print("SUCCESS - text removed!")
doc2.close()
