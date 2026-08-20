#!/usr/bin/env python3
"""Index public pages at the site root and write pages.json next to index.html."""

from __future__ import annotations

import html as html_lib
import json
import re
import sys
from pathlib import Path

EXCLUDE_DIRS = {"scripts", "assets", "node_modules", ".git"}
SKIP_FILES = {"404.html"}
SEARCH2_PATH = "/Search2/app/"
SEARCH2_TITLE = "Search2 console"
SEARCH2_DESC = "Live operations desk — six desks, encrypted end to end."

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)
DESC_RE = re.compile(
    r'<meta\s+[^>]*name=["\']description["\'][^>]*>',
    re.IGNORECASE | re.DOTALL,
)
CONTENT_RE = re.compile(r'content=["\'](.*?)["\']', re.IGNORECASE | re.DOTALL)


def site_root() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).expanduser().resolve()
    return Path(__file__).resolve().parent.parent


def read_meta(path: Path) -> tuple[str, str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "", ""
    title_m = TITLE_RE.search(text)
    title = tidy(title_m.group(1)) if title_m else ""
    desc = ""
    desc_m = DESC_RE.search(text)
    if desc_m:
        content_m = CONTENT_RE.search(desc_m.group(0))
        if content_m:
            desc = tidy(content_m.group(1))
    return title, desc


def tidy(value: str) -> str:
    return re.sub(r"\s+", " ", html_lib.unescape(value)).strip()


def excluded(rel: Path) -> bool:
    parts = rel.parts
    if not parts:
        return False
    # Never crawl Search2 desks, assets, or APIs — console is a single entry.
    if parts[0] == "Search2":
        return True
    return any(part in EXCLUDE_DIRS or part.startswith(".") for part in parts)


def fallback_title(stem: str) -> str:
    return re.sub(r"[-_]+", " ", stem).strip().title() or stem


def collect(root: Path) -> list[dict]:
    pages: list[dict] = []

    index = root / "index.html"
    if index.is_file():
        pages.append(
            {
                "title": "Home",
                "path": "/",
                "desc": "This site",
                "nav": False,
            }
        )

    for html_file in sorted(root.glob("*.html")):
        if html_file.name == "index.html" or html_file.name in SKIP_FILES:
            continue
        title, desc = read_meta(html_file)
        pages.append(
            {
                "title": title or fallback_title(html_file.stem),
                "path": f"/{html_file.name}",
                "desc": desc,
                "nav": True,
            }
        )

    for index_html in sorted(root.rglob("index.html")):
        rel = index_html.parent.relative_to(root)
        if rel == Path("."):
            continue
        if excluded(rel):
            continue
        url = "/" + rel.as_posix().strip("/") + "/"
        title, desc = read_meta(index_html)
        if " — " in title:
            title = title.split(" — ", 1)[0]
        pages.append(
            {
                "title": title or fallback_title(rel.name),
                "path": url,
                "desc": desc,
                "nav": True,
            }
        )

    for html_file in sorted(root.rglob("*.html")):
        rel = html_file.relative_to(root)
        if rel.parent == Path("."):
            continue
        if html_file.name == "index.html" or html_file.name in SKIP_FILES:
            continue
        if excluded(rel):
            continue
        title, desc = read_meta(html_file)
        if " — " in title:
            title = title.split(" — ", 1)[0]
        pages.append(
            {
                "title": title or fallback_title(html_file.stem),
                "path": "/" + rel.as_posix(),
                "desc": desc,
                "nav": False,
            }
        )

    # One Search2 console entry for Search2/app/ (or Search2/app/index.html).
    app_index = root / "Search2" / "app" / "index.html"
    title, desc = read_meta(app_index) if app_index.is_file() else ("", "")
    pages.append(
        {
            "title": SEARCH2_TITLE,
            "path": SEARCH2_PATH,
            "desc": desc or SEARCH2_DESC,
            "live": True,
            "locked": True,
            "nav": False,
        }
    )

    return sort_pages(pages)


def sort_pages(pages: list[dict]) -> list[dict]:
    def key(page: dict) -> tuple[int, str]:
        path = page.get("path", "")
        if path == "/":
            return (0, path)
        if path == SEARCH2_PATH:
            return (2, path)
        return (1, path.lower())

    return sorted(pages, key=key)


def main() -> int:
    root = site_root()
    if not root.is_dir():
        print(f"Not a directory: {root}", file=sys.stderr)
        return 1

    pages = collect(root)
    out = root / "pages.json"
    payload = {"pages": pages}
    out.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {len(pages)} page(s) to {out}")
    for page in pages:
        flags = [flag for flag in ("live", "locked", "nav") if page.get(flag)]
        extra = f" [{', '.join(flags)}]" if flags else ""
        print(f"  {page['path']}\t{page['title']}{extra}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
