#!/usr/bin/env python3
"""AERO-wiki – hodinové automatické spracovanie katalógu voľných mapových podkladov.

Kroky jedného behu:
  1. stiahne aktuálny katalóg OSM Editor Layer Index (ortofoto + výškopis, celý svet),
  2. pridá kurátorské zdroje zo sources/extra.json,
  3. z GetCapabilities NASA GIBS a EUMETSAT doplní najnovší čas časových vrstiev,
  4. každú vrstvu overí stiahnutím testovacej dlaždice (HTTP, typ obrázka, prázdnosť, CORS),
  5. zapíše data/catalog.json, data/catalog.js (pre index.html) a data/history.json.

Použitie:
  python scripts/build_catalog.py                 # plný beh (sieť)
  python scripts/build_catalog.py --no-probe      # bez testu dlaždíc (prevezme posledný stav)
  python scripts/build_catalog.py --seed-status s.json   # počiatočné stavy z externého testu
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import io
import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import requests
from PIL import Image, ImageStat

try:
    from shapely.geometry import mapping, shape
    from shapely.validation import make_valid
except ImportError:  # geometria sa potom len zaokrúhli
    shape = None

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ELI_URL = "https://osmlab.github.io/editor-layer-index/imagery.geojson"
GIBS_CAPS = ("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi"
             "?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0")
GIBS_TILE = ("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/"
             "{time}/{tms}/{z}/{y}/{x}.{ext}")
SITE = os.environ.get("AEROWIKI_SITE", "https://example.github.io/aero-wiki/")
UA = f"AERO-wiki-healthcheck/1.0 (+{SITE})"
HISTORY_LEN = 48          # 48 hodinových záznamov = 2 dni
O = 20037508.342789244    # polovica obvodu Web Mercator [m]

NS = {
    "wmts": "http://www.opengis.net/wmts/1.0",
    "ows": "http://www.opengis.net/ows/1.1",
    "wms": "http://www.opengis.net/wms",
}

KIND_LABEL = {
    "ortho": "Letecké ortofoto",
    "satellite": "Satelitná mozaika",
    "live": "Aktuálne satelitné snímky",
    "relief": "Terén a reliéf",
    "thematic": "Tematické",
    "base": "Podkladové mapy a popisy",
    "aero": "Letectvo",
}
SAT_RE = re.compile(r"sentinel|landsat|cloudless|satell|imagico|osmim|\bS2[AB]\b|LC0?8|spot ?\d|planet", re.I)
OPEN_LICENSE_RE = re.compile(
    r"creativecommons|/licenses/by|cc[-_ ]?by|cc0|odbl|opendata|open[-_ ]?data|etalab|licence[-_]ouverte|"
    r"open[-_ ]?government|dl-de|datenlizenz|public[-_ ]?domain|data\.gov|geobasis|govdata|opendatacommons", re.I)


# --------------------------------------------------------------------------- utilities
def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Origin": SITE.rstrip("/"), "Referer": SITE})
    adapter = requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=0)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def lon2x(lon: float, z: int) -> int:
    return min(2 ** z - 1, max(0, int((lon + 180) / 360 * 2 ** z)))


def lat2y(lat: float, z: int) -> int:
    lat = max(-85.0511, min(85.0511, lat))
    r = math.radians(lat)
    return min(2 ** z - 1, max(0, int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)))


def tile_bbox(x: int, y: int, z: int) -> str:
    s = 2 * O / 2 ** z
    return ",".join(f"{v:.3f}" for v in (-O + x * s, O - (y + 1) * s, -O + (x + 1) * s, O - y * s))


def fill_template(url: str, x: int, y: int, z: int, proj: str = "EPSG:3857",
                  subdomains: str = "", time_value: str | None = None) -> str:
    """Rovnaké nahrádzanie zástupných symbolov ako v prehliadači (app.js)."""
    n = 2 ** z
    if subdomains:
        url = url.replace("{s}", subdomains[0])
    url = (url.replace("{z}", str(z)).replace("{x}", str(x)).replace("{-y}", str(n - 1 - y))
           .replace("{y}", str(y)).replace("{proj}", proj).replace("{wkid}", "3857")
           .replace("{bbox}", tile_bbox(x, y, z)).replace("{width}", "256").replace("{height}", "256"))
    if not time_value:  # čas neznámy -> server vráti svoj predvolený (najnovší) stav
        url = re.sub(r"[&?]TIME=\{time\}", "", url, flags=re.I)
    return url.replace("{time}", time_value or "default")


# --------------------------------------------------------------------------- geometry
def _pip(px: float, py: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def polygons(geom: dict | None) -> list:
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def bbox_of(geom: dict | None) -> list | None:
    pts = [p for poly in polygons(geom) for p in poly[0]]
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]


def test_point(geom: dict | None) -> tuple[float, float] | None:
    """Bod vnútri najväčšieho polygónu pokrytia, čo najbližšie k stredu jeho obálky."""
    best, best_area = None, -1.0
    for poly in polygons(geom):
        ring = poly[0]
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        b = (min(xs), min(ys), max(xs), max(ys))
        area = (b[2] - b[0]) * (b[3] - b[1])
        if area > best_area:
            best, best_area = (ring, b), area
    if not best:
        return None
    ring, b = best
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    cands = []
    for i in range(11):
        for j in range(11):
            x = b[0] + (b[2] - b[0]) * i / 10
            y = b[1] + (b[3] - b[1]) * j / 10
            if _pip(x, y, ring):
                cands.append(((x - cx) ** 2 + (y - cy) ** 2, x, y))
    if not cands:
        return ring[0][0], ring[0][1]
    cands.sort()
    return cands[0][1], cands[0][2]


def simplify_geom(geom: dict | None, tol: float = 0.01) -> dict | None:
    if not geom:
        return None
    if shape is not None:
        try:
            g = shape(geom)
            if not g.is_valid:
                g = make_valid(g)
            g = g.simplify(tol, preserve_topology=True)
            if g.is_empty:
                return None
            geom = mapping(g)
            if geom["type"] == "GeometryCollection":
                polys = [mapping(p) for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
                if not polys:
                    return None
                geom = polys[0]
        except Exception:
            pass

    def rnd(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 3), round(c[1], 3)]
        return [rnd(e) for e in c]

    return {"type": geom["type"], "coordinates": rnd(geom["coordinates"])}


# --------------------------------------------------------------------------- sources
def load_eli(s: requests.Session, cache: Path) -> dict:
    try:
        r = s.get(ELI_URL, timeout=60)
        r.raise_for_status()
        data = r.json()
        cache.write_text(json.dumps(data))
        return data
    except Exception as e:  # sieť zlyhala – použijeme poslednú kópiu
        print(f"[ELI] sťahovanie zlyhalo ({e}); používam vyrovnávaciu kópiu", file=sys.stderr)
        return json.loads(cache.read_text())


def classify_license(p: dict) -> dict:
    url = p.get("license_url") or ""
    text = json.dumps(p.get("attribution") or {}) + " " + url
    if OPEN_LICENSE_RE.search(text):
        return {"name": "Otvorená licencia (podľa poskytovateľa)", "url": url, "open": True}
    if p.get("permission_osm") == "explicit":
        return {"name": "Povolenie pre OpenStreetMap – overte podmienky pre iné použitie", "url": url, "open": False}
    return {"name": "Podmienky poskytovateľa", "url": url, "open": None}


def eli_layers(eli: dict, skip: set, stats: dict) -> list:
    out = []
    for f in eli["features"]:
        p = f["properties"]
        if p.get("category") not in ("photo", "elevation"):
            continue
        if p.get("type") not in ("tms", "wms", "wmts"):
            stats["eli_other_type"] += 1
            continue
        if p["id"] in skip:
            continue
        url = p["url"]
        if re.search(r"apikey|api_key|access_token|\{key\}", url, re.I):
            stats["eli_needs_key"] += 1
            continue
        if url.startswith("http://"):
            stats["eli_http_only"] += 1      # na HTTPS stránke by prehliadač dlaždice zablokoval
            continue
        projs = p.get("available_projections") or []
        proj = "EPSG:3857"
        if "{proj}" in url:
            if "EPSG:3857" in projs:
                proj = "EPSG:3857"
            elif "EPSG:900913" in projs:
                proj = "EPSG:900913"
            else:
                stats["eli_no_3857"] += 1
                continue
        subdomains = ""
        m = re.search(r"\{switch:([^}]+)\}", url)
        if m:
            opts = m.group(1).split(",")
            subdomains = ",".join(opts)
            url = url.replace(m.group(0), "{s}")
        url = url.replace("{zoom}", "{z}")
        geom = f.get("geometry")
        cc = p.get("country_code")
        if p.get("category") == "elevation":
            kind = "relief"
        elif not cc or SAT_RE.search(p["id"] + " " + p["name"]):
            kind = "satellite"
        else:
            kind = "ortho"
        if p.get("overlay") and kind == "ortho":
            kind = "base"
        pt = test_point(geom) or (17.1077, 48.1486)
        zmin, zmax = int(p.get("min_zoom") or 0), int(p.get("max_zoom") or 19)
        tz = max(zmin, min(zmax, 15 if geom else 5))
        attr = p.get("attribution") or {}
        out.append({
            "id": p["id"], "src": "eli", "name": p["name"], "kind": kind, "cc": cc,
            "type": "wms" if p["type"] == "wms" else "tms", "url": url, "proj": proj,
            "subdomains": subdomains, "minz": zmin, "maxz": zmax,
            "start": p.get("start_date"), "end": p.get("end_date"), "best": bool(p.get("best")),
            "overlay": bool(p.get("overlay")),
            "attribution": {"text": attr.get("text") or p["name"], "url": attr.get("url")},
            "license": classify_license(p), "description": p.get("description"),
            "geom": simplify_geom(geom), "bbox": bbox_of(geom),
            "test": [round(pt[0], 5), round(pt[1], 5), tz],
            "blend": "multiply" if kind == "relief" else None,
        })
    return out


def extra_layers(extra: dict) -> list:
    out = []
    lic = extra["licenses"]
    for e in extra["layers"]:
        b = e.get("bbox")
        geom = None
        if b:
            geom = {"type": "Polygon", "coordinates": [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]]}
        subdomains = e.get("subdomains", "")
        out.append({
            "id": e["id"], "src": "extra", "name": e["name"], "kind": e["kind"], "cc": e.get("cc"),
            "type": e["type"], "url": e.get("url"), "proj": "EPSG:3857",
            "subdomains": ",".join(subdomains) if subdomains else "", "minz": e.get("minz", 0), "maxz": e.get("maxz", 19),
            "start": e.get("start"), "end": e.get("end"), "best": bool(e.get("best")), "overlay": bool(e.get("overlay")),
            "attribution": e["attribution"], "license": lic[e["license"]], "description": e.get("description"),
            "geom": geom if e.get("cc") else None, "bbox": b, "test": e.get("test"), "blend": e.get("blend"),
            "mode": e.get("mode"), "time": e.get("time"), "allow_blank": e.get("allow_blank", False),
            "group": e.get("group"), "source": e.get("source"), "sub": e.get("sub"), "file": e.get("file"),
            "fmt": e.get("fmt"), "urls": e.get("urls"), "labels": e.get("labels"), "max": e.get("max"), "where": e.get("where"),
        })
    return out


# --------------------------------------------------------------------------- time dimensions
def parse_time_values(values: list[str]) -> dict:
    """Z hodnôt ISO 8601 ('a/b/PT10M' alebo zoznam) vráti posledný čas a periódu."""
    last, period, start = None, None, None
    for v in values:
        for part in v.split(","):
            part = part.strip()
            if not part:
                continue
            if "/" in part:
                a, b, *pp = part.split("/")
                start, last, period = a, b, (pp[0] if pp else None)
            else:
                last = part
    return {"latest": last, "period": period, "start": start}


def norm_time(t: str | None) -> str | None:
    if not t:
        return t
    t = re.sub(r"\.\d+Z$", "Z", t)
    return t


def gibs_resolve(s: requests.Session, layers: list, errors: list, offline: bool = False) -> None:
    need = {l["time"]["layer"]: l for l in layers if l.get("time") and l["time"].get("source") == "gibs"}
    if not need:
        return
    # záloha: URL zo známej matice dlaždíc a čas "default" (= najnovší podľa servera)
    for name, l in need.items():
        t = l["time"]
        l["url"] = GIBS_TILE.format(layer=name, time="{time}", tms=t["tms"], z="{z}", y="{y}", x="{x}", ext=t["ext"])
        l["maxz"] = int(t["tms"].split("_Level")[-1])
        l["time"] = {"source": "gibs", "layer": name, "caps": GIBS_CAPS, "static": bool(t.get("static")),
                     "latest": "default", "period": None, "start": None, "tms": t["tms"], "ext": t["ext"]}
    if offline:
        return
    try:
        r = s.get(GIBS_CAPS, timeout=90)
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception as e:
        errors.append(f"GIBS GetCapabilities: {e}")
        return
    found = {}
    for lay in root.iter(f"{{{NS['wmts']}}}Layer"):
        ident = lay.find("ows:Identifier", NS)
        if ident is None or ident.text not in need:
            continue
        fmt = (lay.findtext("wmts:Format", default="image/png", namespaces=NS) or "image/png")
        tms = lay.findtext("wmts:TileMatrixSetLink/wmts:TileMatrixSet", namespaces=NS)
        dim = lay.find("wmts:Dimension", NS)
        info = {"tms": tms, "ext": "jpg" if "jpeg" in fmt else "png"}
        if dim is not None:
            info["default"] = dim.findtext("wmts:Default", namespaces=NS)
            info.update(parse_time_values([v.text or "" for v in dim.findall("wmts:Value", NS)]))
        found[ident.text] = info
    for name, l in need.items():
        info = found.get(name)
        if not info or not info.get("tms"):
            l["status_override"] = {"state": "down", "err": "vrstva chýba v GetCapabilities GIBS"}
            continue
        maxz = int(re.sub(r"\D", "", info["tms"].split("_Level")[-1]) or 9)
        l["maxz"] = maxz
        l["url"] = GIBS_TILE.format(layer=name, time="{time}", tms=info["tms"], z="{z}", y="{y}", x="{x}", ext=info["ext"])
        static = l["time"].get("static") or not info.get("latest")
        l["time"] = {
            "source": "gibs", "layer": name, "caps": GIBS_CAPS, "static": bool(static),
            "latest": "default" if static else norm_time(info.get("latest")),
            "default": info.get("default"), "period": info.get("period"), "start": norm_time(info.get("start")),
            "tms": info["tms"], "ext": info["ext"],
        }


def wms_time_resolve(s: requests.Session, layers: list, errors: list, offline: bool = False) -> None:
    by_caps: dict[str, list] = {}
    if offline:
        return
    for l in layers:
        t = l.get("time")
        if t and t.get("source") == "wms":
            by_caps.setdefault(t["caps"], []).append(l)
    for caps, ls in by_caps.items():
        try:
            r = s.get(caps, timeout=90)
            r.raise_for_status()
            root = ET.fromstring(r.content)
        except Exception as e:
            errors.append(f"WMS GetCapabilities {urlsplit(caps).netloc}: {e}")
            continue
        dims = {}
        for lay in root.iter(f"{{{NS['wms']}}}Layer"):
            name = lay.findtext("wms:Name", namespaces=NS)
            dim = lay.find("wms:Dimension", NS)
            if name and dim is not None and (dim.get("name") or "").lower() == "time":
                info = parse_time_values([dim.text or ""])
                info["default"] = dim.get("default")
                dims[name] = info
        for l in ls:
            info = dims.get(l["time"]["layer"])
            if not info:
                l["status_override"] = {"state": "down", "err": "vrstva chýba v GetCapabilities"}
                continue
            l["time"].update({"latest": norm_time(info["latest"]), "default": norm_time(info.get("default")),
                              "period": info["period"], "start": norm_time(info["start"]), "static": False})


# --------------------------------------------------------------------------- probing
def is_blank(im: Image.Image) -> bool:
    im = im.convert("RGBA").resize((64, 64))
    st = ImageStat.Stat(im)
    if st.extrema[3][1] < 8:                    # úplne priehľadná
        return True
    return max(st.stddev) < 1.5                 # jednofarebná (vrátane alfa kanála)


def probe_arcgis(s: requests.Session, l: dict) -> dict:
    """Vektorová vrstva ArcGIS: počet objektov každej podvrstvy + hlavička CORS."""
    res = {"checked": iso(now_utc())}
    t0 = time.time()
    total, cors = 0, True
    for u in l.get("urls") or []:
        try:
            r = s.get(u + "/query", params={"where": l.get("where") or "1=1", "returnCountOnly": "true", "f": "json"},
                      headers={"Origin": "https://example.github.io"}, timeout=(10, 30))
        except requests.Timeout:
            return {**res, "state": "down", "err": "časový limit"}
        except requests.RequestException as e:
            return {**res, "state": "down", "err": type(e).__name__}
        if r.status_code != 200:
            return {**res, "state": "down", "err": f"HTTP {r.status_code}"}
        try:
            j = r.json()
        except ValueError:
            return {**res, "state": "down", "err": "odpoveď nie je JSON"}
        if "error" in j:
            return {**res, "state": "down", "err": f"ArcGIS {j['error'].get('code')}"}
        total += int(j.get("count") or 0)
        cors = cors and bool(r.headers.get("access-control-allow-origin"))
    res.update(ms=int((time.time() - t0) * 1000), cors=cors, count=total)
    if not cors:
        return {**res, "state": "warn", "err": "server neposiela hlavičku CORS"}
    return {**res, "state": "ok"}


def probe_rainviewer(s: requests.Session, l: dict) -> dict:
    res = {"checked": iso(now_utc())}
    t0 = time.time()
    try:
        r = s.get("https://api.rainviewer.com/public/weather-maps.json", timeout=(10, 25))
        j = r.json()
        frames = (j.get("radar") or {}).get("past") or []
        res["ms"] = int((time.time() - t0) * 1000)
        if not frames:
            return {**res, "state": "down", "err": "bez snímok"}
        return {**res, "state": "ok", "latest": dt.datetime.fromtimestamp(frames[-1]["time"], dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    except Exception as e:  # noqa: BLE001
        return {**res, "state": "down", "err": type(e).__name__}


def probe_layer(s: requests.Session, l: dict) -> dict:
    if l.get("source") == "arcgis":
        return probe_arcgis(s, l)
    if l["type"] == "rainviewer":
        return probe_rainviewer(s, l)
    lon, lat, z = l["test"]
    t = l.get("time") or {}
    tv = t.get("latest")
    url = fill_template(l["url"], lon2x(lon, z), lat2y(lat, z), z, l.get("proj", "EPSG:3857"),
                        l.get("subdomains", "").replace(",", ""), tv)
    t0 = time.time()
    res = {"checked": iso(now_utc())}
    try:
        r = s.get(url, timeout=(10, 25))
    except requests.Timeout:
        return {**res, "state": "down", "err": "časový limit"}
    except requests.RequestException as e:
        return {**res, "state": "down", "err": type(e).__name__}
    res["ms"] = int((time.time() - t0) * 1000)
    res["cors"] = bool(r.headers.get("access-control-allow-origin"))
    if r.status_code != 200:
        return {**res, "state": "down", "err": f"HTTP {r.status_code}"}
    try:
        im = Image.open(io.BytesIO(r.content))
        im.load()
    except Exception:
        ct = (r.headers.get("content-type") or "?").split(";")[0]
        return {**res, "state": "down", "err": f"odpoveď nie je obrázok ({ct})"}
    if is_blank(im) and not l.get("allow_blank"):
        return {**res, "state": "warn", "err": "testovacia dlaždica je prázdna"}
    return {**res, "state": "ok"}


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-probe", action="store_true")
    ap.add_argument("--seed-status", type=Path)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--eli-file", type=Path, help="lokálny imagery.geojson namiesto sťahovania")
    ap.add_argument("--offline", action="store_true", help="bez sieťových požiadaviek (implikuje --no-probe)")
    a = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    started = now_utc()
    s = session()
    stats = {k: 0 for k in ("eli_other_type", "eli_needs_key", "eli_http_only", "eli_no_3857")}
    errors: list[str] = []

    extra = json.loads((ROOT / "sources" / "extra.json").read_text())
    eli = json.loads(a.eli_file.read_text()) if a.eli_file else load_eli(s, DATA / ".eli-cache.geojson")
    layers = extra_layers(extra) + eli_layers(eli, set(extra.get("skip_eli_ids", [])), stats)

    # duplicity: rovnaký URL vzor -> ponechá sa prvý (kurátorský)
    seen, uniq = set(), []
    for l in layers:
        key = re.sub(r"\{s\}|https?://|\s", "", (l.get("url") or l["id"]).lower())
        key += "|" + (l.get("mode") or "") + "|" + ((l.get("time") or {}).get("layer") or "")
        if key in seen:
            stats["duplicates"] = stats.get("duplicates", 0) + 1
            continue
        seen.add(key)
        uniq.append(l)
    layers = uniq

    if a.offline:
        a.no_probe = True
    # rovnaké názvy v jednej krajine odlíšime hostiteľom služby
    seen_names: dict[tuple, int] = {}
    for l in layers:
        k = (l.get("cc"), l["name"])
        seen_names[k] = seen_names.get(k, 0) + 1
    for l in layers:
        if seen_names[(l.get("cc"), l["name"])] > 1 and l.get("url"):
            l["name"] = f'{l["name"]} · {urlsplit(l["url"]).netloc.split(":")[0]}'

    gibs_resolve(s, layers, errors, a.offline)
    wms_time_resolve(s, layers, errors, a.offline)

    prev_hist = {}
    hist_path = DATA / "history.json"
    if hist_path.exists():
        prev_hist = json.loads(hist_path.read_text()).get("layers", {})
    prev_status = {}
    cat_path = DATA / "catalog.json"
    if cat_path.exists():
        try:
            prev_status = {l["id"]: l.get("status") for l in json.loads(cat_path.read_text())["layers"]}
        except Exception:
            pass
    seed = json.loads(a.seed_status.read_text()) if a.seed_status else {}

    statuses: dict[str, dict] = {}
    # letecké vektorové vrstvy: stav podľa posledného behu scripts/build_aero.py
    aero_meta = {}
    if (DATA / "aero" / "meta.json").exists():
        aero_meta = json.loads((DATA / "aero" / "meta.json").read_text()).get("sources", {})
    for l in layers:
        if l["type"] != "vector" or l.get("source") == "arcgis":
            continue
        src = aero_meta.get("openaip" if l.get("source") == "openaip" else l.get("source"), {})
        stt = src.get("state", "unknown")
        if stt == "off":
            stt, err = "down", "vypnuté – chýba OPENAIP_API_KEY"
        else:
            err = src.get("error")
        l["status_override"] = {"state": stt, "err": err, "checked": src.get("updated") or src.get("checked")}
    probe_list = [l for l in layers if "status_override" not in l]
    for l in layers:
        if "status_override" in l:
            so = l.pop("status_override")
            statuses[l["id"]] = {**so, "checked": so.get("checked") or iso(now_utc())}
    if a.no_probe:
        for l in probe_list:
            statuses[l["id"]] = seed.get(l["id"]) or prev_status.get(l["id"]) or {"state": "unknown"}
    else:
        with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
            futs = {ex.submit(probe_layer, s, l): l for l in probe_list}
            for f in cf.as_completed(futs):
                statuses[futs[f]["id"]] = f.result()
        # zlyhané ešte raz, pomalšie (dočasné výpadky, preťažené servery)
        retry = [l for l in probe_list if statuses[l["id"]]["state"] == "down"]
        with cf.ThreadPoolExecutor(max_workers=6) as ex:
            futs = {ex.submit(probe_layer, s, l): l for l in retry}
            for f in cf.as_completed(futs):
                r = f.result()
                if r["state"] != "down":
                    statuses[futs[f]["id"]] = r

    hist = {}
    for l in layers:
        st = statuses[l["id"]]
        h = (prev_hist.get(l["id"]) or [])[-(HISTORY_LEN - 1):]
        if st.get("state") != "unknown":
            h.append([st.get("checked", iso(started)), st["state"][0]])
        hist[l["id"]] = h
        recent = [c for _, c in h[-24:]]
        st["uptime24"] = round(sum(c in "ow" for c in recent) / len(recent), 3) if recent else None
        st["h"] = "".join(recent)          # posledných 24 kontrol: o=ok, w=varovanie, d=nedostupné
        l["status"] = st

    # krajiny
    countries: dict[str, dict] = {}
    for l in layers:
        cc = l.get("cc")
        if not cc:
            continue
        c = countries.setdefault(cc, {"n": 0, "bbox": None, "kinds": {}})
        c["n"] += 1
        c["kinds"][l["kind"]] = c["kinds"].get(l["kind"], 0) + 1
        b = l.get("bbox")
        if b:
            c["bbox"] = b if not c["bbox"] else [min(c["bbox"][0], b[0]), min(c["bbox"][1], b[1]),
                                                 max(c["bbox"][2], b[2]), max(c["bbox"][3], b[3])]

    finished = now_utc()
    count = lambda k: sum(1 for l in layers if l["status"].get("state") == k)  # noqa: E731
    catalog = {
        "generated": iso(finished),
        "next": iso(finished.replace(minute=0, second=0) + dt.timedelta(hours=1, minutes=7)),
        "duration_s": int((finished - started).total_seconds()),
        "sources": {
            "eli": {"name": "OSM Editor Layer Index", "url": "https://github.com/osmlab/editor-layer-index"},
            "gibs": {"name": "NASA GIBS", "url": "https://earthdata.nasa.gov/gibs"},
            "eumetsat": {"name": "EUMETView", "url": "https://view.eumetsat.int/"},
        },
        "kinds": KIND_LABEL,
        "stats": {"layers": len(layers), "countries": len(countries), "ok": count("ok"), "warn": count("warn"),
                  "down": count("down"), "unknown": count("unknown"), "excluded": stats},
        "errors": errors,
        "countries": countries,
        "layers": layers,
    }
    js = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    (DATA / "catalog.json").write_text(js)
    (DATA / "catalog.js").write_text("window.AEROWIKI_CATALOG=" + js + ";\n")
    hist_path.write_text(json.dumps({"updated": iso(finished), "layers": hist}, separators=(",", ":")))
    st = catalog["stats"]
    print(f"[AERO-wiki] {st['layers']} vrstiev, {st['countries']} krajín | ok {st['ok']} · varovanie {st['warn']} · "
          f"nedostupné {st['down']} · neznáme {st['unknown']} | {catalog['duration_s']} s | catalog.js {len(js)//1024} kB")
    for e in errors:
        print("  chyba:", e, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
