#!/usr/bin/env python3
"""
Extracts content from a base64-encoded PDF.
Reads base64 PDF from stdin to avoid OS argument-list-too-long (E2BIG) limits.

Strategy:
  1. Try direct text extraction (fast, no AI needed — works for digital PDFs).
  2. If extracted text is < MIN_TEXT_CHARS, also render pages as PNG images
     so the caller can use a Vision API as fallback (scanned/image PDFs).

Usage:  echo "<base64>" | python3 pdf_to_images.py [max_pages]
Output: JSON object written to stdout:
  {
    "text": "<extracted plain text or empty string>",
    "pages": ["<base64_png>", ...],   # empty when text extraction succeeded
    "total_in_doc": N,
    "extracted": N
  }
"""
import sys
import json
import base64

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({"error": "pymupdf not installed — run: pip install pymupdf"}))
    sys.exit(1)

# Minimum chars to consider text extraction successful (skip vision fallback).
# 50 is enough to distinguish a real digital PDF from a scanned one with stray chars.
MIN_TEXT_CHARS = 50


def main():
    max_pages = int(sys.argv[1]) if len(sys.argv) > 1 else 20

    b64_pdf = sys.stdin.read().strip()
    if not b64_pdf:
        print(json.dumps({"error": "No base64 input on stdin"}))
        sys.exit(1)

    try:
        pdf_bytes = base64.b64decode(b64_pdf)
    except Exception as e:
        print(json.dumps({"error": f"base64 decode failed: {e}"}))
        sys.exit(1)

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(json.dumps({"error": f"PDF open failed: {e}"}))
        sys.exit(1)

    total_pages = min(doc.page_count, max_pages)

    # ── Step 1: direct text extraction ────────────────────────────────────────
    text_parts = []
    for i in range(total_pages):
        page_text = doc[i].get_text("text").strip()
        if page_text:
            text_parts.append(f"=== Página {i + 1} ===\n{page_text}")

    full_text = "\n\n".join(text_parts)

    if len(full_text) >= MIN_TEXT_CHARS:
        # Digital PDF — return text directly, no vision needed
        print(json.dumps({
            "text": full_text,
            "pages": [],
            "total_in_doc": doc.page_count,
            "extracted": total_pages,
        }))
        return

    # ── Step 2: render pages as images (scanned/image-based PDF) ─────────────
    pages_b64 = []
    for i in range(total_pages):
        page = doc[i]
        # zoom=2 → 144 DPI — good quality for Vision API OCR
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        pages_b64.append(base64.b64encode(pix.tobytes("png")).decode("utf-8"))

    print(json.dumps({
        "text": "",
        "pages": pages_b64,
        "total_in_doc": doc.page_count,
        "extracted": total_pages,
    }))


if __name__ == "__main__":
    main()
