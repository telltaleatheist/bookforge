#!/usr/bin/env python3
"""
PDF Block Analyzer for BookForge.

Reads JSON commands from stdin, outputs JSON results to stdout.
Designed to work with Electron's Python bridge via IPC.

Commands:
  - analyze: Analyze PDF and extract categorized blocks
  - export: Export text from enabled categories
  - find_similar: Find blocks similar to a given block
  - render_page: Render a page as base64 PNG
"""
import sys
import json
import hashlib
import base64
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional
from collections import defaultdict

import fitz  # PyMuPDF


@dataclass
class TextBlock:
    """A whitespace-separated text block from the PDF."""
    id: str
    page: int
    x: float
    y: float
    width: float
    height: float
    text: str
    font_size: float
    font_name: str
    char_count: int
    region: str
    category_id: str
    is_bold: bool = False
    is_italic: bool = False
    is_superscript: bool = False
    is_image: bool = False
    line_count: int = 1


@dataclass
class Category:
    """An auto-generated category of similar blocks."""
    id: str
    name: str
    description: str
    color: str
    block_count: int
    char_count: int
    font_size: float
    region: str
    sample_text: str
    enabled: bool = True


class PDFAnalyzer:
    """Analyzes PDFs and extracts categorized text blocks."""

    # Semantic colors for category types
    CATEGORY_TYPE_COLORS = {
        'body': '#4CAF50',      # Green
        'footnote': '#2196F3',  # Blue
        'footnote_ref': '#E91E63',  # Pink - for footnote reference numbers
        'heading': '#FF9800',   # Orange
        'subheading': '#9C27B0', # Purple
        'title': '#F44336',     # Red
        'caption': '#00BCD4',   # Cyan
        'quote': '#FFEB3B',     # Yellow
        'header': '#795548',    # Brown
        'footer': '#607D8B',    # Blue Grey
        'image': '#9E9E9E',     # Grey - images/figures
    }

    # Fallback colors for unknown types
    FALLBACK_COLORS = [
        '#E91E63',  # Pink
        '#3F51B5',  # Indigo
        '#009688',  # Teal
        '#8BC34A',  # Light Green
        '#FF5722',  # Deep Orange
        '#673AB7',  # Deep Purple
        '#00E676',  # Green Accent
        '#FF4081',  # Pink Accent
        '#536DFE',  # Indigo Accent
    ]

    def __init__(self):
        self.blocks: List[TextBlock] = []
        self.categories: Dict[str, Category] = {}
        self.doc = None
        self.pdf_path = None
        self.page_dimensions = []

    def analyze(self, pdf_path: str, max_pages: Optional[int] = None) -> Dict:
        """Analyze PDF and return blocks, categories, dimensions."""
        self.pdf_path = Path(pdf_path)
        self.doc = fitz.open(pdf_path)
        self.blocks = []
        self.page_dimensions = []

        page_count = len(self.doc)
        if max_pages:
            page_count = min(page_count, max_pages)

        # Get per-page dimensions
        for page_num in range(page_count):
            page = self.doc[page_num]
            self.page_dimensions.append({
                'width': page.rect.width,
                'height': page.rect.height
            })

        # Extract blocks
        for page_num in range(page_count):
            self._extract_page_blocks(page_num)

        # Generate categories
        self._generate_categories()

        return {
            'blocks': [asdict(b) for b in self.blocks],
            'categories': {k: asdict(v) for k, v in self.categories.items()},
            'page_count': page_count,
            'page_dimensions': self.page_dimensions,
            'pdf_name': self.pdf_path.name,
        }

    def _extract_page_blocks(self, page_num: int):
        """Extract text and image blocks from a single page."""
        page = self.doc[page_num]
        page_height = self.page_dimensions[page_num]['height']
        page_width = self.page_dimensions[page_num]['width']

        # Extract images first using get_image_info for accurate bounding boxes
        image_rects = set()
        try:
            for img_info in page.get_image_info():
                bbox = img_info.get("bbox")
                if bbox:
                    x, y, x2, y2 = bbox
                    block_width = x2 - x
                    block_height = y2 - y

                    # Skip very small images (likely decorative)
                    if block_width < 20 or block_height < 20:
                        continue

                    # Round coords for deduplication
                    rect_key = (round(x), round(y), round(x2), round(y2))
                    if rect_key in image_rects:
                        continue
                    image_rects.add(rect_key)

                    block_id = hashlib.md5(f"{page_num}:img:{x:.0f},{y:.0f}".encode()).hexdigest()[:12]

                    self.blocks.append(TextBlock(
                        id=block_id,
                        page=page_num,
                        x=x,
                        y=y,
                        width=block_width,
                        height=block_height,
                        text=f"[Image {int(block_width)}x{int(block_height)}]",
                        font_size=0,
                        font_name="image",
                        char_count=0,
                        region="body",
                        category_id="",
                        is_image=True,
                        line_count=0
                    ))
        except Exception as e:
            # Fallback if get_image_info fails
            pass

        # Now extract text blocks
        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]

        for block_idx, block in enumerate(blocks):
            # Handle image blocks from text extraction (type=1 or no "lines")
            if "lines" not in block or block.get("type") == 1:
                bbox = block["bbox"]
                x, y, x2, y2 = bbox
                block_width = x2 - x
                block_height = y2 - y

                # Skip very small images (likely decorative)
                if block_width < 20 or block_height < 20:
                    continue

                # Skip if we already got this image from get_image_info
                rect_key = (round(x), round(y), round(x2), round(y2))
                if rect_key in image_rects:
                    continue
                image_rects.add(rect_key)

                block_id = hashlib.md5(f"{page_num}:img:{block_idx}:{x:.0f},{y:.0f}".encode()).hexdigest()[:12]

                self.blocks.append(TextBlock(
                    id=block_id,
                    page=page_num,
                    x=x,
                    y=y,
                    width=block_width,
                    height=block_height,
                    text=f"[Image {int(block_width)}x{int(block_height)}]",
                    font_size=0,
                    font_name="image",
                    char_count=0,
                    region="body",
                    category_id="",
                    is_image=True,
                    line_count=0
                ))
                continue

            bbox = block["bbox"]
            x, y, x2, y2 = bbox

            all_text = []
            font_sizes = defaultdict(int)
            font_names = defaultdict(int)
            bold_chars = 0
            italic_chars = 0
            superscript_chars = 0
            total_chars = 0
            line_count = len(block["lines"])

            for line in block["lines"]:
                for span in line["spans"]:
                    text = span["text"]
                    if text.strip():
                        all_text.append(text)
                        char_len = len(text)
                        total_chars += char_len
                        size = round(span["size"], 1)
                        font_sizes[size] += char_len
                        font_name = span.get("font", "unknown")
                        font_names[font_name] += char_len

                        # Detect bold/italic/superscript from font name or flags
                        font_lower = font_name.lower()
                        flags = span.get("flags", 0)
                        if "bold" in font_lower or (flags & 2**4):  # bit 4 = bold
                            bold_chars += char_len
                        if "italic" in font_lower or "oblique" in font_lower or (flags & 2**1):  # bit 1 = italic
                            italic_chars += char_len
                        # Superscript detection: flag bit 0, or very small relative size
                        if (flags & 1):  # bit 0 = superscript
                            superscript_chars += char_len

            combined_text = " ".join(all_text)
            if not combined_text.strip():
                continue

            dominant_size = max(font_sizes.items(), key=lambda x: x[1])[0] if font_sizes else 10.0
            dominant_font = max(font_names.items(), key=lambda x: x[1])[0] if font_names else "unknown"

            # Determine if predominantly bold, italic, or superscript
            is_bold = bold_chars > total_chars * 0.5 if total_chars > 0 else False
            is_italic = italic_chars > total_chars * 0.5 if total_chars > 0 else False
            is_superscript = superscript_chars > total_chars * 0.5 if total_chars > 0 else False

            # Improved region detection
            y_pct = y / page_height
            y_end_pct = y2 / page_height
            block_height = y2 - y
            text_len = len(combined_text)

            # Header detection:
            # - In top 8% of page AND short text (< 80 chars) - definitely header
            # - In top 5% of page AND medium text (< 150 chars) - likely header
            # - Long text in top area is NOT a header (it's first paragraph)
            if y_pct < 0.05 and text_len < 150 and line_count <= 3:
                region = "header"
            elif y_pct < 0.08 and text_len < 80 and line_count <= 2:
                region = "header"
            elif y_pct > 0.92 or (y_pct > 0.88 and text_len < 50):
                region = "footer"
            elif y_pct > 0.70:
                # Lower portion of page - could be footnotes
                region = "lower"
            else:
                region = "body"

            block_id = hashlib.md5(f"{page_num}:{block_idx}:{combined_text[:50]}".encode()).hexdigest()[:12]

            self.blocks.append(TextBlock(
                id=block_id,
                page=page_num,
                x=x,
                y=y,
                width=x2 - x,
                height=y2 - y,
                text=combined_text,
                font_size=dominant_size,
                font_name=dominant_font,
                char_count=len(combined_text),
                region=region,
                category_id="",
                is_bold=is_bold,
                is_italic=is_italic,
                is_superscript=is_superscript,
                line_count=line_count
            ))

    def _generate_categories(self):
        """Auto-generate categories based on block attributes."""
        # First pass: identify body text characteristics
        body_size = None
        body_char_count = 0

        # Find the most common font size in body region (not lower/header/footer)
        size_chars = defaultdict(int)
        for block in self.blocks:
            if block.region == "body" and not block.is_bold:
                size_chars[block.font_size] += block.char_count

        if size_chars:
            body_size = max(size_chars.items(), key=lambda x: x[1])[0]

        # Second pass: classify each block - group by semantic type only
        groups = defaultdict(list)

        for block in self.blocks:
            category_type = self._classify_block(block, body_size)
            # Group by semantic type only - don't split by font/size variations
            key = category_type
            groups[key].append(block)

        # Create categories
        fallback_idx = 0
        sorted_groups = sorted(groups.items(), key=lambda x: -sum(b.char_count for b in x[1]))

        for cat_type, blocks in sorted_groups:
            total_chars = sum(b.char_count for b in blocks)
            avg_size = sum(b.font_size for b in blocks) / len(blocks) if blocks else 10

            # Generate name and description based on category type
            if cat_type == "body":
                name = "Body Text"
                description = f"Main content ({len(blocks)} blocks)"
            elif cat_type == "footnote":
                name = "Footnotes"
                description = f"Footnotes and references ({len(blocks)} blocks)"
            elif cat_type == "footnote_ref":
                name = "Footnote Numbers"
                description = f"Superscript reference numbers ({len(blocks)} blocks)"
            elif cat_type == "heading":
                name = "Section Headings"
                description = "Bold section titles"
            elif cat_type == "subheading":
                name = "Subheadings"
                description = "Bold subsection titles"
            elif cat_type == "title":
                name = "Titles"
                description = "Large titles or chapter headings"
            elif cat_type == "header":
                name = "Page Headers"
                description = "Running header text"
            elif cat_type == "footer":
                name = "Page Footers"
                description = "Page numbers or footer text"
            elif cat_type == "caption":
                name = "Captions"
                description = "Figure or table captions"
            elif cat_type == "quote":
                name = "Block Quotes"
                description = "Indented quotations"
            elif cat_type == "image":
                name = "Images"
                description = f"Figures and images ({len(blocks)} blocks)"
            else:
                name = f"Other ({cat_type})"
                description = "Other text style"

            # Use semantic color if available, otherwise fallback
            if cat_type in self.CATEGORY_TYPE_COLORS:
                color = self.CATEGORY_TYPE_COLORS[cat_type]
            else:
                color = self.FALLBACK_COLORS[fallback_idx % len(self.FALLBACK_COLORS)]
                fallback_idx += 1

            cat_id = hashlib.md5(f"{cat_type}".encode()).hexdigest()[:8]
            sample = blocks[0].text[:100] if blocks else ""

            self.categories[cat_id] = Category(
                id=cat_id,
                name=name,
                description=description,
                color=color,
                block_count=len(blocks),
                char_count=total_chars,
                font_size=round(avg_size, 1),
                region=blocks[0].region if blocks else "body",
                sample_text=sample,
                enabled=True
            )

            for block in blocks:
                block.category_id = cat_id

    def _classify_block(self, block: TextBlock, body_size: float) -> str:
        """Classify a block into a semantic category."""
        body_size = body_size or 10.0

        # Image blocks
        if block.is_image:
            return "image"

        # Superscript blocks are footnote references (like ¹, ², ³)
        if block.is_superscript:
            return "footnote_ref"

        # Very small isolated numbers/text might be footnote refs
        # (catches cases where superscript flag isn't set but size is tiny)
        if block.font_size < body_size * 0.7 and block.char_count < 5:
            return "footnote_ref"

        # Header/footer regions
        if block.region == "header":
            return "header"
        if block.region == "footer":
            return "footer"

        # Footnotes: in lower region with smaller font
        if block.region == "lower" and block.font_size < body_size * 0.95:
            return "footnote"

        # Small text anywhere (but not in lower) might be captions
        if block.font_size < body_size * 0.85 and block.region != "lower":
            return "caption"

        # Large text is likely titles
        if block.font_size > body_size * 1.4:
            return "title"

        # Bold text with similar size to body = headings
        if block.is_bold:
            if block.font_size > body_size * 1.1:
                return "heading"
            elif block.line_count <= 2 and block.char_count < 200:
                return "subheading"

        # Italic blocks might be quotes or emphasis
        if block.is_italic and block.line_count > 2:
            return "quote"

        # Default: body text
        return "body"

    def render_page(self, page_num: int, scale: float = 2.0, pdf_path: str = None) -> str:
        """Render page as base64 PNG."""
        # If pdf_path provided, open it (for stateless calls)
        if pdf_path:
            doc = fitz.open(pdf_path)
            page = doc[page_num]
            mat = fitz.Matrix(scale, scale)
            pix = page.get_pixmap(matrix=mat)
            png_data = pix.tobytes("png")
            doc.close()
            return base64.b64encode(png_data).decode('utf-8')

        # Otherwise use cached doc
        if not self.doc:
            raise ValueError("No PDF loaded")

        page = self.doc[page_num]
        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat)
        png_data = pix.tobytes("png")
        return base64.b64encode(png_data).decode('utf-8')

    def export_text(self, enabled_categories: List[str]) -> Dict:
        """Export text from enabled categories."""
        enabled_set = set(enabled_categories)
        sorted_blocks = sorted(self.blocks, key=lambda b: (b.page, b.y, b.x))

        lines = []
        current_page = -1

        for block in sorted_blocks:
            if block.category_id not in enabled_set:
                continue

            if block.page != current_page:
                if current_page >= 0:
                    lines.append("")
                current_page = block.page

            lines.append(block.text)

        text = "\n".join(lines)
        return {
            'text': text,
            'char_count': len(text)
        }

    def find_similar(self, block_id: str) -> Dict:
        """Find blocks similar to the given block."""
        target = None
        for block in self.blocks:
            if block.id == block_id:
                target = block
                break

        if not target:
            return {'similar_ids': [], 'count': 0}

        similar = [b.id for b in self.blocks if b.category_id == target.category_id]
        return {'similar_ids': similar, 'count': len(similar)}

    def export_pdf(self, pdf_path: str, deleted_regions: List[Dict]) -> str:
        """
        Export a cleaned PDF with deleted regions removed.

        Args:
            pdf_path: Path to the source PDF
            deleted_regions: List of dicts with page, x, y, width, height

        Returns:
            Base64-encoded PDF data
        """
        doc = fitz.open(pdf_path)

        # Group regions by page
        regions_by_page = defaultdict(list)
        for region in deleted_regions:
            page_num = region['page']
            regions_by_page[page_num].append(region)

        # Process each page with deleted regions
        for page_num, regions in regions_by_page.items():
            if page_num >= len(doc):
                continue

            page = doc[page_num]

            for region in regions:
                x = region['x']
                y = region['y']
                width = region['width']
                height = region['height']

                # Create rectangle for the region
                rect = fitz.Rect(x, y, x + width, y + height)

                # Add redaction annotation (marks area for removal)
                page.add_redact_annot(rect, fill=(1, 1, 1))  # White fill

            # Apply all redactions on this page
            page.apply_redactions()

        # Save to bytes
        pdf_bytes = doc.tobytes(deflate=True, garbage=4)
        doc.close()

        return base64.b64encode(pdf_bytes).decode('utf-8')

    def close(self):
        """Close the PDF document."""
        if self.doc:
            self.doc.close()
            self.doc = None


# Global analyzer instance
analyzer = PDFAnalyzer()


def handle_request(request: Dict) -> Dict:
    """Handle a single request from the bridge."""
    method = request.get('method')
    args = request.get('args', [])

    if method == 'analyze':
        pdf_path = args[0] if args else None
        max_pages = args[1] if len(args) > 1 and args[1] else None  # None = all pages
        return analyzer.analyze(pdf_path, max_pages)

    elif method == 'export':
        enabled_categories = args[0] if args else []
        return analyzer.export_text(enabled_categories)

    elif method == 'find_similar':
        block_id = args[0] if args else None
        return analyzer.find_similar(block_id)

    elif method == 'render_page':
        page_num = args[0] if args else 0
        scale = args[1] if len(args) > 1 else 2.0
        pdf_path = args[2] if len(args) > 2 else None
        return {'image': analyzer.render_page(page_num, scale, pdf_path)}

    elif method == 'export_pdf':
        pdf_path = args[0] if args else None
        deleted_regions = args[1] if len(args) > 1 else []
        pdf_base64 = analyzer.export_pdf(pdf_path, deleted_regions)
        return {'pdf_base64': pdf_base64}

    else:
        return {'error': f'Unknown method: {method}'}


def main():
    """Main entry point - read JSON from stdin, write JSON to stdout."""
    try:
        # Read request from stdin
        input_data = sys.stdin.read()
        request = json.loads(input_data)

        # Handle request
        result = handle_request(request)

        # Output result as JSON
        print(json.dumps(result))

    except Exception as e:
        # Output error as JSON
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
