#!/usr/bin/env python3
"""Build data/suburbs.json from SA Government open data: "Metro median house sales"
(Valuer-General sales by suburb, one quarterly XLSX/CSV per quarter back to 2015) on data.sa.gov.au.

No third-party dependencies: XLSX files are read with zipfile + ElementTree.

What the files contain
  Each quarterly file lists, per suburb, the number of sales and the median sale price for that quarter
  and for the same quarter one year earlier. There is no annual figure and no postcode column.

How the yearly series is built (documented in docs/DATA.md)
  1. Every file contributes two (year, quarter) cells per suburb; where files overlap, the newest file wins.
  2. house[].median = median of that year's available quarterly medians (a median of medians, not a median of
     all sales: the source does not publish the individual sales). house[].sales = sum of the quarterly sales
     counts. house[].quarters = how many quarters back the year (4 = full year, fewer = partial or thin data).
  3. Suburb names are matched to postcodes via the open australian_postcodes.csv (Delivery Area rows, SA),
     falling back to a built-in list for the suburbs the app cares about. Suburbs without a postcode are skipped.

Caching: downloads go to .cache/sa_medians/ (gitignored; the workflow caches it), keyed by sha1(resource URL +
last_modified), so a revised quarterly file is fetched again and an unchanged one never is.

Usage: python3 scripts/sa_medians.py [--force]    (skips if data/suburbs.json _fetchedAt is under 7 days old)
"""
import csv
import hashlib
import io
import json
import re
import statistics
import sys
import time
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "suburbs.json"
CACHE = ROOT / ".cache" / "sa_medians"
CKAN = "https://data.sa.gov.au/data/api/3/action/package_search?q=metro%20median%20house%20sales&rows=5"
DATASET = "metro-median-house-sales"
POSTCODES = "https://raw.githubusercontent.com/matthewproctor/australianpostcodes/master/australian_postcodes.csv"
UA = {"User-Agent": "adelaide-house-hunt/1.0 (github.com/pourmousavi/adelaide-house-hunt)"}
SOURCE = "SA Valuer-General via data.sa.gov.au"
MIN_YEAR = 2015
FRESH_DAYS = 7
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}

# Always present, even if the postcode download fails.
KNOWN = {
    "LINDEN PARK": "5065", "GLENUNGA": "5064", "ST GEORGES": "5064", "FREWVILLE": "5063", "GLENSIDE": "5065",
    "GLEN OSMOND": "5064", "BEAUMONT": "5066", "HAZELWOOD PARK": "5066", "MOUNT OSMOND": "5064",
    "TUSMORE": "5065", "TOORAK GARDENS": "5065", "BURNSIDE": "5066", "KENSINGTON": "5068", "ADELAIDE": "5000",
}


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  retry {url.split('/')[-1]}: {e}", file=sys.stderr)
            time.sleep(2 * (i + 1))


def cached(url, stamp, name):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (hashlib.sha1(f"{url}|{stamp}".encode()).hexdigest() + "-" + re.sub(r"[^A-Za-z0-9._-]", "_", name)[-40:])
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes(), True
    data = get(url)
    path.write_bytes(data)
    return data, False


# ---------- minimal XLSX / CSV reading ----------

def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def xlsx_rows(data):
    """First worksheet (in workbook order) -> list of rows (lists of str|None)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rid = wb.find("m:sheets", NS)[0].get("{%s}id" % NS["r"])
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = next(r.get("Target") for r in rels.findall("pr:Relationship", NS) if r.get("Id") == rid)
    path = target.lstrip("/") if target.startswith("/") else "xl/" + target
    rows = []
    for row in ET.fromstring(z.read(path)).iter("{%s}row" % NS["m"]):
        cells = {}
        for c in row.findall("m:c", NS):
            v = c.find("m:v", NS)
            if v is not None and v.text is not None:
                cells[col_index(c.get("r"))] = shared[int(v.text)] if c.get("t") == "s" else v.text
            elif c.get("t") == "inlineStr":
                cells[col_index(c.get("r"))] = "".join(t.text or "" for t in c.iter("{%s}t" % NS["m"]))
        if cells:
            rows.append([cells.get(i) for i in range(max(cells) + 1)])
    return rows


def table_rows(data):
    if data[:2] == b"PK":
        return xlsx_rows(data)
    return list(csv.reader(io.StringIO(data.decode("utf-8-sig", "replace"))))


def num(s):
    try:
        return float(str(s).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


HEAD = re.compile(r"(sales|median)\D*?(?:(\d)\s*Q\s*(\d{4})|Q\s*(\d)\s*(\d{4}))", re.I | re.S)


def parse_file(data):
    """-> { SUBURB: { (year, quarter): (sales|None, median|None) } }"""
    rows = table_rows(data)
    head = next((r for r in rows if r and r[0] and r[0].strip().lower() == "city"), None)
    if head is None:
        raise ValueError("no header row")
    cols = []  # (col, kind, year, quarter)
    for i, h in enumerate(head):
        m = HEAD.search(h or "")
        if m:
            q, y = (m.group(2), m.group(3)) if m.group(2) else (m.group(4), m.group(5))
            cols.append((i, m.group(1).lower(), int(y), int(q)))
    out = {}
    for r in rows[rows.index(head) + 1:]:
        if len(r) < 2 or not r[1]:
            continue
        cells = {}
        for i, kind, y, q in cols:
            v = num(r[i]) if i < len(r) else None
            cells.setdefault((y, q), {})[kind] = v
        out[r[1].strip().upper()] = {k: (v.get("sales"), v.get("median")) for k, v in cells.items()}
    return out


# ---------- postcodes ----------

def norm(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def postcode_map():
    """norm(suburb) -> (display name, [postcodes])"""
    out = {}
    try:
        data, _ = cached(POSTCODES, "v1", "australian_postcodes.csv")
        for r in csv.DictReader(io.StringIO(data.decode("utf-8-sig"))):
            if r["state"] == "SA" and r["type"] == "Delivery Area":
                name, pc = r["locality"], r["postcode"].zfill(4)
                out.setdefault(norm(name), (name.title() if name.isupper() else name, []))[1].append(pc)
    except Exception as e:  # noqa: BLE001
        print(f"  ! postcode list unavailable ({e}); using the built-in list only", file=sys.stderr)
    for name, pc in KNOWN.items():
        out[norm(name)] = (name.title(), [pc])  # the built-in list wins for the suburbs the app cares about
    return out


# ---------- main ----------

def fresh(path):
    try:
        t = json.loads(path.read_text())["_fetchedAt"]
        return (datetime.now(timezone.utc) - datetime.fromisoformat(t.replace("Z", "+00:00"))).days < FRESH_DAYS
    except Exception:  # noqa: BLE001
        return False


def main():
    if "--force" not in sys.argv and fresh(OUT):
        print(f"{OUT.name} is under {FRESH_DAYS} days old; skipping (use --force)")
        return 0
    pkg = json.loads(get(CKAN))["result"]["results"]
    pkg = next((p for p in pkg if p["name"] == DATASET), pkg[0])
    files = []
    for r in pkg["resources"]:
        m = re.search(r"Q\s*(\d)\s*(\d{4})", r["name"])
        if m and (r.get("format") or "").upper() in ("XLSX", "XLS", "CSV"):
            files.append(((int(m.group(2)), int(m.group(1))), r))
    files.sort(key=lambda x: x[0])
    print(f"{len(files)} quarterly files, {files[0][0]} to {files[-1][0]}")

    cells = {}  # suburb -> {(year, q): (sales, median)}; later files overwrite earlier ones
    bad = 0
    for key, r in files:
        try:
            data, hit = cached(r["url"], r.get("last_modified") or r.get("metadata_modified") or "", r["url"].split("/")[-1])
            for sub, d in parse_file(data).items():
                cells.setdefault(sub, {}).update({k: v for k, v in d.items() if v[1] is not None or v[0] is not None})
        except Exception as e:  # noqa: BLE001
            bad += 1
            print(f"  ! {key}: {e}", file=sys.stderr)
    if bad > len(files) // 2 or not cells:
        print("too many files failed; leaving suburbs.json untouched", file=sys.stderr)
        return 1

    pcs = postcode_map()
    out = {}
    skipped = []
    for sub, q in sorted(cells.items()):
        known = pcs.get(norm(sub))
        if not known:
            skipped.append(sub)
            continue
        name, postcodes = known
        years = {}
        for (y, qq), (sales, med) in q.items():
            if y >= MIN_YEAR:
                years.setdefault(y, []).append((sales, med))
        series = []
        for y in sorted(years):
            meds = [m for _, m in years[y] if m]
            if not meds:
                continue
            series.append({"year": y, "median": int(round(statistics.median(meds))),
                           "sales": int(sum(s for s, _ in years[y] if s)), "quarters": len(meds)})
        if not series:
            continue
        for pc in postcodes:
            out.setdefault(f"{name}|{pc}", {"house": series, "unit": []})
    result = {"_source": SOURCE, "_fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "_method": "house.median = median of the year's quarterly medians; sales = sum of quarterly sales; quarters = quarters contributing",
              **dict(sorted(out.items()))}
    # one line per suburb keeps the file small (~150 KB) and the git diffs readable
    lines = [f"{json.dumps(k)}:{json.dumps(v, separators=(',', ':'))}" for k, v in result.items()]
    OUT.write_text("{\n" + ",\n".join(lines) + "\n}\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(out)} suburbs; {len(skipped)} skipped without a postcode")
    for k in ("Linden Park|5065", "Glenunga|5064"):
        if k in out:
            print(k, [(p["year"], p["median"], p["sales"], p["quarters"]) for p in out[k]["house"]])
    return 0


if __name__ == "__main__":
    sys.exit(main())
