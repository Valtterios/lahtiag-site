#!/usr/bin/env python3
"""Render a Markdown document to a brand-styled PDF.

    python3 scripts/brand-pdf.py docs/privacy-policy-2026-09-05.md out.pdf \
        --meta "Privacy policy · 5 September 2026"

Needs pandoc and Chromium on the machine (both present on the maintainer's
desktop). The page uses the site's own fonts and colours (public/fonts,
public/brand), embedded so the HTML is self-contained, and Chromium's print
engine so the result looks the same everywhere. The first `#` heading is
the document title; `--meta` fills the top-right lines under the
association's name and business id.
"""

import argparse
import base64
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def data_uri(path: pathlib.Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


CSS = """
@font-face { font-family: 'Chakra Petch'; font-style: italic; font-weight: 700; src: url('%(chakra_italic)s') format('woff2'); }
@font-face { font-family: 'Chakra Petch'; font-style: normal; font-weight: 600; src: url('%(chakra)s') format('woff2'); }
@page { size: A4; margin: 22mm 20mm 22mm 20mm; }
:root { --blue: #4169e1; --ink: #1e1e1e; --muted: #5f5f5f; --line: #e0e2e8; --yellow: #ffde59; }
html, body { margin: 0; padding: 0; }
body { font: 10.5pt/1.55 'Noto Sans', 'DejaVu Sans', system-ui, sans-serif; color: var(--ink); }
header.title { display: flex; justify-content: space-between; align-items: flex-end; gap: 12mm; border-bottom: 3px solid var(--blue); padding-bottom: 6mm; margin-bottom: 8mm; }
header.title img { height: 14mm; width: auto; }
header.title .meta { text-align: right; color: var(--muted); font-size: 9pt; line-height: 1.4; white-space: pre-line; }
h1 { font-family: 'Chakra Petch', sans-serif; font-style: italic; font-weight: 700; font-size: 20pt; text-transform: uppercase; letter-spacing: -0.01em; margin: 0 0 2mm; color: var(--ink); }
h1 + h2 { margin-top: 0; }
h2 { font-family: 'Chakra Petch', sans-serif; font-style: italic; font-weight: 700; font-size: 13pt; text-transform: uppercase; color: var(--ink); margin: 8mm 0 2.5mm; page-break-after: avoid; }
h2::before { content: ''; display: block; width: 9mm; height: 1.4mm; background: var(--blue); transform: skewX(-24deg); margin-bottom: 1.8mm; }
h3 { font-family: 'Chakra Petch', sans-serif; font-weight: 600; font-size: 11pt; margin: 5mm 0 1.5mm; page-break-after: avoid; }
p { margin: 0 0 2.6mm; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 3mm; padding-left: 5.5mm; }
li { margin: 0 0 1.2mm; }
li::marker { color: var(--blue); }
a { color: var(--blue); text-decoration: none; }
.lede { font-size: 11pt; color: var(--muted); }
.controller { background: #f5f5f5; border-left: 3px solid var(--yellow); padding: 3mm 4mm; margin: 0 0 4mm; font-size: 10pt; line-height: 1.5; }
footer { margin-top: 10mm; padding-top: 3mm; border-top: 1px solid var(--line); color: var(--muted); font-size: 8.5pt; }
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("markdown")
    ap.add_argument("pdf")
    ap.add_argument("--meta", default="", help="lines for the top-right header block")
    ap.add_argument("--footer", default="Lahti Association of Gaming LAG ry · Mukkulankatu 19, 15210 Lahti, Finland · board@lahtiag.fi · lahtiag.fi")
    args = ap.parse_args()

    body = subprocess.run(
        ["pandoc", args.markdown, "-t", "html5", "--syntax-highlighting=none"],
        check=True, capture_output=True, text=True,
    ).stdout
    body = re.sub(r'<header id="title-block-header">.*?</header>', "", body, flags=re.S)
    # The controller block of the privacy policy: the paragraph after that heading.
    body = re.sub(
        r'(<h2 id="data-controller">Data controller</h2>\s*)<p>(.*?)</p>',
        lambda m: m.group(1) + '<div class="controller">' + m.group(2) + "</div>",
        body, count=1, flags=re.S,
    )
    body = re.sub(r"<p>(Updated \d.*?)</p>", r'<p class="lede">\1</p>', body, count=1)

    css = CSS % {
        "chakra_italic": data_uri(ROOT / "public/fonts/chakra-italic-latin.woff2", "font/woff2"),
        "chakra": data_uri(ROOT / "public/fonts/chakra-latin.woff2", "font/woff2"),
    }
    logo = data_uri(ROOT / "public/brand/wordmark-blue.png", "image/png")
    meta = "Lahti Association of Gaming LAG ry\nBusiness ID 3485167-1" + ("\n" + args.meta if args.meta else "")
    html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LahtiAG</title>'
        f"<style>{css}</style></head><body>"
        f'<header class="title"><img src="{logo}" alt="Lahti AG"><div class="meta">{meta}</div></header>'
        f"{body}<footer>{args.footer}</footer></body></html>"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as tmp:
        tmp.write(html)
        tmp_path = tmp.name
    out = pathlib.Path(args.pdf).resolve()
    subprocess.run(
        ["chromium", "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
         f"--print-to-pdf={out}", f"file://{tmp_path}"],
        check=True, capture_output=True,
    )
    pathlib.Path(tmp_path).unlink()
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
