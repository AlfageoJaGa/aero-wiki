#!/usr/bin/env python3
"""AERO-wiki – knižnica voľných online leteckých zdrojov sveta.

Načíta sources/aero_library.json (AIP/eAIP všetkých štátov, NOTAM a briefing, letecká meteorológia, VAAC,
letecké mapy, zóny UAS, dátové služby a API, ADS-B), každý odkaz overí požiadavkou HTTP a zapíše
data/library.json a data/library.js s výsledkom a históriou dostupnosti.

Stav odkazu:
  ok    – server odpovedal 2xx/3xx,
  warn  – server odpovedal, ale 401/403/405/429 (prístup obmedzený alebo blokuje automatické kontroly),
  down  – 404/410/5xx, chyba spojenia alebo časový limit (2 pokusy).
Kontrola beží zo serverov GitHubu (USA); niektoré štátne servery zahraničné adresy blokujú, preto sa
zachováva aj posledný úspešný výsledok z prehliadača (via=chrome-sk) a história.

Použitie:
  python scripts/build_library.py              # plná kontrola
  python scripts/build_library.py --no-probe   # bez siete, prevezme posledný stav
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SRC = ROOT / "sources" / "aero_library.json"
SITE = os.environ.get("AEROWIKI_SITE", "https://example.github.io/aero-wiki/")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 "
      f"AERO-wiki-linkcheck/1.0 (+{SITE})")
HISTORY_LEN = 48


def iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def check(s: requests.Session, url: str) -> dict:
    res = {"checked": iso(now_utc()), "via": "server"}
    last = None
    for attempt in range(2):
        t0 = time.time()
        try:
            r = s.get(url, timeout=(12, 30), allow_redirects=True, stream=True)
            r.close()
        except requests.Timeout:
            last = {**res, "st": "down", "err": "časový limit"}
            time.sleep(2)
            continue
        except requests.RequestException as e:
            last = {**res, "st": "down", "err": type(e).__name__}
            time.sleep(2)
            continue
        out = {**res, "ms": int((time.time() - t0) * 1000), "code": r.status_code}
        if r.url and r.url.split("#")[0].rstrip("/") != url.split("#")[0].rstrip("/"):
            out["final"] = r.url[:300]
        if r.status_code < 400:
            return {**out, "st": "ok"}
        if r.status_code in (401, 403, 405, 406, 429, 999):
            return {**out, "st": "warn", "err": f"HTTP {r.status_code}"}
        last = {**out, "st": "down", "err": f"HTTP {r.status_code}"}
        if r.status_code in (404, 410):
            return last
    return last


def country_boxes() -> dict:
    """Rozsah štátov z polôh letísk (data/aero/ad/*.json); 1. – 99. percentil potlačí zámorské územia."""
    pts: dict[str, list] = {}
    d = DATA / "aero" / "ad"
    if not d.exists():
        return {}
    for f in d.glob("*.json"):
        if f.name == "index.json":
            continue
        try:
            part = json.loads(f.read_text())
        except Exception:  # noqa: BLE001
            continue
        cc = f.stem[:2]
        for a in part.get("ad", []):
            pts.setdefault(cc, []).append((a[4], a[3]))
    out = {}
    for cc, ps in pts.items():
        xs = sorted(p[0] for p in ps)
        ys = sorted(p[1] for p in ps)
        n = len(xs)
        k = int(n * 0.01) if n >= 40 else 0
        w, e = xs[k], xs[n - 1 - k]
        if e - w > 180:  # cez 180. poludník (Rusko, Fidži…): počítame v rozsahu 0–360°
            xs2 = sorted(x + 360 if x < 0 else x for x in xs)
            w, e = xs2[k], min(180.0, xs2[n - 1 - k])
        out[cc] = [round(w, 2), round(ys[k], 2), round(e, 2), round(ys[n - 1 - k], 2)]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-probe", action="store_true")
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()
    started = now_utc()

    lib = json.loads(SRC.read_text(encoding="utf-8"))
    entries = lib["entries"]

    prev = {}
    p = DATA / "library.json"
    if p.exists():
        try:
            for e in json.loads(p.read_text(encoding="utf-8"))["entries"]:
                prev[e["url"]] = e
        except Exception:  # noqa: BLE001
            pass

    # katalóg vrstiev – overenie odkazov na mapové vrstvy
    layer_ids = set()
    cp = DATA / "catalog.json"
    if cp.exists():
        try:
            layer_ids = {l["id"] for l in json.loads(cp.read_text())["layers"]}
        except Exception:  # noqa: BLE001
            pass

    urls = sorted({e["url"] for e in entries})
    results: dict[str, dict] = {}
    if not a.no_probe:
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
                          "Accept-Language": "en,sk;q=0.8"})
        with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
            futs = {ex.submit(check, s, u): u for u in urls}
            for f in cf.as_completed(futs):
                results[futs[f]] = f.result()

    out = []
    for e in entries:
        e = dict(e)
        seed = e.get("check") or {}
        pv = prev.get(e["url"], {})
        hist = (pv.get("hist") or [])[-(HISTORY_LEN - 1):]
        r = results.get(e["url"])
        if r:
            hist.append(r["st"][0])
            # posledný úspech z prehliadača v SR zostáva informatívne pri blokovaní zo zahraničia
            e["check"] = r
            if r["st"] == "down" and (seed.get("st") == "ok" or pv.get("last_ok")):
                e["check"]["note"] = "zo servera v USA nedostupné, z prehliadača v SR overené"
            if r["st"] == "ok":
                e["last_ok"] = r["checked"]
            elif pv.get("last_ok"):
                e["last_ok"] = pv["last_ok"]
        else:
            e["check"] = pv.get("check") or seed
            if pv.get("last_ok"):
                e["last_ok"] = pv["last_ok"]
            elif seed.get("st") == "ok" and seed.get("t"):
                e["last_ok"] = seed["t"]
        e["hist"] = hist
        if e.get("layers"):
            e["layers"] = [i for i in e["layers"] if not layer_ids or i in layer_ids]
            if not e["layers"]:
                del e["layers"]
        out.append(e)

    finished = now_utc()
    bbox = country_boxes()
    cnt = lambda k: sum(1 for e in out if (e.get("check") or {}).get("st") == k)  # noqa: E731
    doc = {
        "generated": iso(finished),
        "duration_s": int((finished - started).total_seconds()),
        "meta": lib["meta"],
        "stats": {"entries": len(out), "ok": cnt("ok"), "warn": cnt("warn"), "down": cnt("down"),
                  "unknown": len(out) - cnt("ok") - cnt("warn") - cnt("down"),
                  "countries": len({c for e in out for c in (e.get("ccs") or [e["cc"]]) if len(c) == 2 and c not in ("WW", "EU")})},
        "entries": out,
        "bbox": bbox,
    }
    js = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    DATA.mkdir(exist_ok=True)
    (DATA / "library.json").write_text(js, encoding="utf-8")
    (DATA / "library.js").write_text("window.AEROWIKI_LIBRARY=" + js + ";\n", encoding="utf-8")
    st = doc["stats"]
    print(f"[AERO-wiki] knižnica {st['entries']} zdrojov, {st['countries']} krajín | ok {st['ok']} · varovanie {st['warn']} · "
          f"nedostupné {st['down']} · neoverené {st['unknown']} | {doc['duration_s']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
