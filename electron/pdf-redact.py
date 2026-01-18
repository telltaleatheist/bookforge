#!/usr/bin/env python3
"""
PDF Redaction using PyMuPDF
Called from Electron main process to redact text/image regions from PDF.

Usage:
  python3 pdf-redact.py <input.pdf> <output.pdf> <regions.json>

regions.json format:
{
  "regions": [
    {"page": 0, "x": 10, "y": 20, "width": 100, "height": 30, "isImage": false},
    ...
  ],
  "deletedPages": [3, 5, 7],  // optional, 0-indexed
  "bookmarks": [              // optional, chapters to add as bookmarks
    {"title": "Chapter 1", "page": 0, "level": 1},
    {"title": "Section 1.1", "page": 5, "level": 2},
    ...
  ]
}

Coordinates are in screen coords (y=0 at top).
Page numbers are 0-indexed and should already account for deleted pages.
"""

import sys
import json
import pymupdf


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 pdf-redact.py <input.pdf> <output.pdf> <regions.json>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    regions_path = sys.argv[3]

    # Load regions
    with open(regions_path, 'r') as f:
        data = json.load(f)

    regions = data.get('regions', [])
    deleted_pages = set(data.get('deletedPages', []))
    bookmarks = data.get('bookmarks', [])

    # Open PDF
    doc = pymupdf.open(input_path)
    total_pages = len(doc)

    # Group regions by page
    regions_by_page = {}
    for region in regions:
        page_num = region['page']
        if page_num not in regions_by_page:
            regions_by_page[page_num] = []
        regions_by_page[page_num].append(region)

    # Apply redactions to each page
    for page_num, page_regions in regions_by_page.items():
        if page_num >= total_pages:
            continue
        if page_num in deleted_pages:
            continue  # Page will be deleted, no need to redact

        page = doc[page_num]

        for region in page_regions:
            x0 = region['x']
            y0 = region['y']
            x1 = x0 + region['width']
            y1 = y0 + region['height']
            text = region.get('text', '')

            # PyMuPDF uses top-left origin like screen coords
            region_rect = pymupdf.Rect(x0, y0, x1, y1)

            # For text regions, use text search to find exact bounds
            # This is more precise than coordinate-based redaction
            if text and not region.get('isImage'):
                # Search for the text on this page
                text_instances = page.search_for(text, quads=False)

                # Find the instance that overlaps with our region
                matched = False
                for found_rect in text_instances:
                    # Check if this found rect overlaps with our region
                    if found_rect.intersects(region_rect):
                        page.add_redact_annot(found_rect)
                        matched = True
                        break

                # Fall back to coordinate-based if no match found
                if not matched:
                    page.add_redact_annot(region_rect)
            else:
                # Image or no text - use coordinate-based redaction
                page.add_redact_annot(region_rect)

        # Apply all redactions on this page
        page.apply_redactions(images=2, graphics=1)

    # Delete pages (in reverse order to preserve indices)
    for page_num in sorted(deleted_pages, reverse=True):
        if page_num < len(doc):
            doc.delete_page(page_num)

    # Add bookmarks (TOC) if provided
    # PyMuPDF TOC format: [[level, title, page, dest], ...]
    # level: 1-based hierarchy level
    # page: 1-based page number
    if bookmarks:
        toc = []
        for bm in bookmarks:
            # Convert 0-indexed page to 1-indexed for PyMuPDF
            toc.append([
                bm.get('level', 1),
                bm.get('title', 'Untitled'),
                bm.get('page', 0) + 1  # 0-indexed to 1-indexed
            ])
        doc.set_toc(toc)
        print(f"Added {len(toc)} bookmarks")

    # Save with garbage collection to remove redacted content
    doc.save(output_path, garbage=4, deflate=True)
    doc.close()

    print(f"Redacted PDF saved to {output_path}")


if __name__ == '__main__':
    main()
