#!/usr/bin/env python3
"""AERO-wiki – hodinové spracovanie leteckých údajov.

Zdroje (všetky bez poplatku):
  METAR, TAF          NOAA Aviation Weather Center, súbory cache (celý svet)       aviationweather.gov
  SIGMET, AIRMET      NOAA AWC Data API: medzinárodné SIGMET, US SIGMET, G-AIRMET   aviationweather.gov
  NOTAM               FAA NOTAM Search – celý svet (FIR a letiská), postupná obnova  notams.aim.faa.gov
  letiská, VPD,       OurAirports (public domain, denná aktualizácia)              ourairports.com
  frekvencie, navaid
  zoznam a stredy FIR VATSpy Data Project (CC BY-SA 4.0), raz za 7 dní               github.com/vatsimnetwork
  priestory,          openAIP (CC BY-NC 4.0) – len ak je nastavený OPENAIP_API_KEY  openaip.net
  prekážky

Výstup: data/aero/*.json a data/aero/meta.json (čas, počty, chyby, AIRAC).
Použitie:
  python scripts/build_aero.py
  python scripts/build_aero.py --only metar,taf,sigmet     # len vybrané časti
  python scripts/build_aero.py --fixtures DIR              # offline test na uložených vzorkách
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import html
import io
import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "aero"
AWC = "https://aviationweather.gov"
NOTAM_URL = "https://notams.aim.faa.gov/notamSearch/search"
NOTAM_HOME = "https://notams.aim.faa.gov/notamSearch/"
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"
OPENAIP_API = "https://api.core.openaip.net/api/"
SITE = os.environ.get("AEROWIKI_SITE", "https://example.github.io/aero-wiki/")
UA = f"AERO-wiki-aero/1.0 (+{SITE})"
UTC = dt.timezone.utc


# --------------------------------------------------------------------------- pomocné
def now_utc() -> dt.datetime:
    return dt.datetime.now(UTC).replace(microsecond=0)


def iso(t: dt.datetime | None) -> str | None:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def from_epoch(v) -> str | None:
    try:
        return iso(dt.datetime.fromtimestamp(int(v), UTC))
    except (TypeError, ValueError):
        return None


def num(v, cast=float):
    try:
        if v in (None, ""):
            return None
        return cast(v)
    except (TypeError, ValueError):
        return None


def write_json(name: str, obj) -> int:
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(txt)
    return len(txt)


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    return s


class Fetcher:
    """Sieť alebo uložené vzorky (fixtures) pre offline test."""

    def __init__(self, fixtures: Path | None):
        self.fx = fixtures
        self.s = session()

    def get(self, url: str, name: str, binary=False, **kw):
        if self.fx:
            p = self.fx / name
            return p.read_bytes() if binary else p.read_text()
        r = self.s.get(url, timeout=kw.pop("timeout", 90), **kw)
        r.raise_for_status()
        return r.content if binary else r.text


# --------------------------------------------------------------------------- AIRAC
AIRAC_EPOCH = dt.date(2024, 1, 25)  # AIRAC 2401


def airac(day: dt.date) -> dict:
    idx = (day - AIRAC_EPOCH).days // 28
    eff = AIRAC_EPOCH + dt.timedelta(days=28 * idx)
    jan1 = dt.date(eff.year, 1, 1)
    k = math.ceil((jan1 - AIRAC_EPOCH).days / 28)
    first = AIRAC_EPOCH + dt.timedelta(days=28 * k)
    seq = (eff - first).days // 28 + 1
    return {"cycle": f"{eff.year % 100:02d}{seq:02d}", "effective": eff.isoformat(),
            "next": (eff + dt.timedelta(days=28)).isoformat()}


# --------------------------------------------------------------------------- METAR
def build_metar(f: Fetcher) -> dict:
    raw = f.get(AWC + "/data/cache/metars.cache.csv.gz", "metars.cache.csv.gz", binary=True)
    text = gzip.decompress(raw).decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    head = rows[0]
    ix = {}
    for i, h in enumerate(head):
        ix.setdefault(h, []).append(i)
    g = lambda r, k, n=0: (r[ix[k][n]] if k in ix and len(ix[k]) > n and ix[k][n] < len(r) else "")  # noqa: E731
    latest = {}
    for r in rows[1:]:
        if len(r) < 10:
            continue
        lat, lon = num(g(r, "latitude")), num(g(r, "longitude"))
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            continue
        sid, t = g(r, "station_id"), g(r, "observation_time")
        if sid in latest and latest[sid][3] >= t:
            continue
        clouds = []
        for n in range(4):
            cov, base = g(r, "sky_cover", n), g(r, "cloud_base_ft_agl", n)
            if cov:
                clouds.append(cov + (f"{int(float(base)) // 100:03d}" if base else ""))
        alt = num(g(r, "altim_in_hg"))
        qnh = round(alt * 33.8639) if alt else None
        wd = g(r, "wind_dir_degrees")
        latest[sid] = [sid, round(lat, 4), round(lon, 4), t.replace(".000Z", "Z"), g(r, "flight_category") or None,
                       (num(wd, int) if wd not in ("", "VRB") else (wd or None)), num(g(r, "wind_speed_kt"), int),
                       num(g(r, "wind_gust_kt"), int), g(r, "visibility_statute_mi") or None, num(g(r, "temp_c")),
                       num(g(r, "dewpoint_c")), qnh, g(r, "wx_string") or None, " ".join(clouds) or None,
                       g(r, "raw_text")]
    data = sorted(latest.values())
    newest = max((d[3] for d in data), default=None)
    size = write_json("metar.json", {"fields": ["id", "lat", "lon", "obs", "cat", "wdir", "wspd", "wgst", "visSM",
                                                 "temp", "dewp", "qnh", "wx", "clouds", "raw"], "rows": data})
    return {"count": len(data), "newest": newest, "bytes": size}


# --------------------------------------------------------------------------- TAF
def build_taf(f: Fetcher) -> dict:
    raw = f.get(AWC + "/data/cache/tafs.cache.xml.gz", "tafs.cache.xml.gz", binary=True)
    root = ET.fromstring(gzip.decompress(raw))
    latest = {}
    for e in root.iter("TAF"):
        sid = e.findtext("station_id")
        lat, lon = num(e.findtext("latitude")), num(e.findtext("longitude"))
        if not sid or lat is None or lon is None:
            continue
        issue = (e.findtext("issue_time") or "").replace(".000Z", "Z")
        if sid in latest and latest[sid][3] >= issue:
            continue
        latest[sid] = [sid, round(lat, 4), round(lon, 4), issue,
                       (e.findtext("valid_time_from") or "").replace(".000Z", "Z"),
                       (e.findtext("valid_time_to") or "").replace(".000Z", "Z"),
                       " ".join((e.findtext("raw_text") or "").split())]
    data = sorted(latest.values())
    size = write_json("taf.json", {"fields": ["id", "lat", "lon", "issue", "from", "to", "raw"], "rows": data})
    return {"count": len(data), "newest": max((d[3] for d in data), default=None), "bytes": size}


# --------------------------------------------------------------------------- SIGMET / AIRMET
def _ring(coords) -> list:
    pts = []
    for c in coords or []:
        lat, lon = num(c.get("lat")), num(c.get("lon"))
        if lat is not None and lon is not None:
            pts.append([round(lon, 4), round(lat, 4)])
    return pts


def _geom(coords):
    if not coords:
        return None
    if isinstance(coords[0], list):  # AREAS: viac polygónov
        polys = [p for p in (_ring(c) for c in coords) if len(p) >= 3]
        return {"type": "MultiPolygon", "coordinates": [[p + [p[0]]] for p in polys]} if polys else None
    p = _ring(coords)
    if len(p) >= 3:
        if p[0] != p[-1]:
            p.append(p[0])
        return {"type": "Polygon", "coordinates": [p]}
    if len(p) == 2:
        return {"type": "LineString", "coordinates": p}
    if len(p) == 1:
        return {"type": "Point", "coordinates": p[0]}
    return None


def build_sigmet(f: Fetcher) -> dict:
    feats, errors = [], []
    try:
        for s in json.loads(f.get(AWC + "/api/data/isigmet?format=json", "isigmet.json")):
            g = _geom(s.get("coords"))
            if not g:
                continue
            feats.append({"type": "Feature", "geometry": g, "properties": {
                "src": "SIGMET", "fir": s.get("firId"), "firName": s.get("firName"), "series": s.get("seriesId"),
                "hazard": s.get("hazard") or "", "qual": s.get("qualifier") or "", "base": s.get("base"),
                "top": s.get("top"), "from": from_epoch(s.get("validTimeFrom")), "to": from_epoch(s.get("validTimeTo")),
                "dir": s.get("dir"), "spd": s.get("spd"), "chng": s.get("chng"), "raw": s.get("rawSigmet")}})
    except Exception as e:  # noqa: BLE001
        errors.append(f"isigmet: {e}")
    try:
        for s in json.loads(f.get(AWC + "/api/data/airsigmet?format=json", "airsigmet.json")):
            g = _geom(s.get("coords"))
            if not g:
                continue
            feats.append({"type": "Feature", "geometry": g, "properties": {
                "src": s.get("airSigmetType") or "SIGMET", "fir": s.get("icaoId"), "firName": "USA",
                "series": s.get("seriesId"), "hazard": s.get("hazard") or "", "qual": str(s.get("severity") or ""),
                "base": s.get("altitudeLow1"), "top": s.get("altitudeHi1"), "from": from_epoch(s.get("validTimeFrom")),
                "to": from_epoch(s.get("validTimeTo")), "raw": s.get("rawAirSigmet")}})
    except Exception as e:  # noqa: BLE001
        errors.append(f"airsigmet: {e}")
    try:
        gj = json.loads(f.get(AWC + "/api/data/gairmet?format=geojson", "gairmet.geojson"))
        for ft in gj.get("features", []):
            p = ft.get("properties", {})
            vt = p.get("validTime")
            try:
                t = dt.datetime.fromisoformat(vt.replace("Z", "+00:00"))
            except Exception:  # noqa: BLE001
                continue
            if not ft.get("geometry"):
                continue
            feats.append({"type": "Feature", "geometry": ft["geometry"], "properties": {
                "src": "G-AIRMET", "fir": "KKCI", "firName": "USA", "series": p.get("tag"),
                "hazard": p.get("hazard") or "", "qual": p.get("severity") or "", "base": p.get("base"),
                "top": p.get("top"), "from": iso(t - dt.timedelta(minutes=90)), "to": iso(t + dt.timedelta(minutes=90)),
                "raw": f"G-AIRMET {p.get('product')} {p.get('hazard')} {p.get('tag')} platné {vt} "
                       f"(predpoveď +{p.get('forecast')} h), {p.get('base')}–{p.get('top')}"}})
    except Exception as e:  # noqa: BLE001
        errors.append(f"gairmet: {e}")
    size = write_json("sigmet.json", {"type": "FeatureCollection", "features": feats})
    return {"count": len(feats), "bytes": size, "errors": errors}


# --------------------------------------------------------------------------- NOTAM
Q_SUBJECT = {
    "AA": "minimálna výška", "AC": "riadený okrsok (CTR)", "AD": "ADIZ", "AE": "riadená oblasť (CTA)",
    "AF": "letová informačná oblasť (FIR)", "AH": "horná riadená oblasť", "AL": "minimálna použiteľná FL",
    "AN": "RNAV trať", "AO": "oceánska CTA", "AP": "hlásny bod", "AR": "trať ATS", "AT": "koncová riadená oblasť (TMA)",
    "AU": "horná FIR", "AV": "horná CTA", "AX": "priesečník", "AZ": "letiskový okrsok (ATZ)",
    "CA": "spojenie zem–vzduch", "CB": "ADS-B", "CC": "ADS-C", "CD": "CPDLC", "CE": "traťový radar", "CG": "GCA",
    "CL": "SELCAL", "CM": "radar pohybových plôch", "CP": "PAR", "CR": "radar", "CS": "SSR", "CT": "radar TAR",
    "FA": "letisko", "FB": "meranie brzdného účinku", "FC": "ceilometer", "FD": "dokovací systém", "FE": "kyslík",
    "FF": "hasičská a záchranná služba", "FG": "riadenie pohybu na zemi", "FH": "heliport", "FI": "odmrazovanie",
    "FJ": "palivo", "FL": "smerovka pristátia", "FM": "meteorologická služba", "FO": "rozptyl hmly",
    "FP": "heliport", "FS": "odpratávanie snehu", "FT": "transmisometer", "FU": "dostupnosť paliva",
    "FW": "ukazovateľ vetra", "FZ": "colná služba", "GA": "GNSS letisko", "GW": "GNSS oblasť",
    "IC": "ILS", "ID": "DME pri ILS", "IG": "zostupová rovina ILS", "II": "vnútorné návestidlo ILS",
    "IL": "kurzový maják ILS", "IM": "stredné návestidlo ILS", "IN": "kurzový maják", "IO": "vonkajšie návestidlo ILS",
    "IS": "ILS kat. I", "IT": "ILS kat. II", "IU": "ILS kat. III", "IW": "MLS", "IX": "lokátor",
    "LA": "približovacie svetlá", "LB": "letiskový maják", "LC": "svetlá osi dráhy", "LD": "svetlá ukazovateľa smeru",
    "LE": "okrajové svetlá dráhy", "LF": "zábleskové svetlá", "LG": "pilotom ovládané svetlá", "LH": "svetlá vysokej intenzity",
    "LI": "svetlá identifikácie konca dráhy", "LJ": "svetlá zarovnania", "LK": "svetlá kat. II", "LL": "svetlá nízkej intenzity",
    "LM": "svetlá strednej intenzity", "LP": "PAPI", "LR": "svetlá dráhy", "LS": "stop bar", "LT": "prahové svetlá",
    "LU": "svetlá heliportu", "LV": "VASIS", "LW": "svetlá heliportu", "LX": "svetlá osi TWY", "LY": "okrajové svetlá TWY",
    "LZ": "svetlá dotykovej zóny", "MA": "pohybová plocha", "MB": "únosnosť", "MC": "predpolie", "MD": "vyhlásené dĺžky",
    "MG": "navádzací systém TWY", "MH": "záchytné zariadenie", "MK": "stojisko", "MM": "dennú značenie",
    "MN": "odbavovacia plocha", "MO": "stop bar", "MP": "stanovište lietadiel", "MR": "dráha (RWY)",
    "MS": "dojazdová dráha", "MT": "prah dráhy", "MU": "obratisko", "MW": "pás dráhy", "MX": "pojazdová dráha (TWY)",
    "MY": "rýchla odbočovacia TWY", "NA": "všetky rádionavigačné služby", "NB": "NDB", "NC": "DECCA", "ND": "DME",
    "NF": "fan marker", "NL": "lokátor", "NM": "VOR/DME", "NN": "TACAN", "NO": "OMEGA", "NT": "VORTAC", "NV": "VOR",
    "NX": "zameriavač", "OA": "letecká informačná služba", "OB": "prekážka", "OE": "požiadavky na vstup lietadiel",
    "OL": "svetlá prekážky", "OR": "záchranné koordinačné stredisko", "PA": "príletová trať (STAR)",
    "PB": "štandardný VFR príchod", "PC": "postup pri nehode", "PD": "odletová trať (SID)", "PE": "štandardný VFR odchod",
    "PF": "flow control", "PH": "postup v čakaní", "PI": "prístrojový postup priblíženia", "PK": "VFR priblíženie",
    "PL": "podanie letového plánu", "PM": "letiskové prevádzkové minimá", "PN": "postup obmedzenia hluku",
    "PO": "výška prekážkovej voľnosti", "PR": "postup pri strate spojenia", "PT": "prechodová nadmorská výška",
    "PU": "nezdarené priblíženie", "PX": "minimálna výška v čakaní", "PZ": "ADIZ postup",
    "RA": "rezervovaný priestor", "RD": "nebezpečný priestor", "RM": "vojenský priestor", "RO": "prelet nad …",
    "RP": "zakázaný priestor", "RR": "obmedzený priestor", "RT": "dočasne obmedzený priestor",
    "SA": "ATIS", "SB": "ATS ohlasovňa", "SC": "oblastné stredisko (ACC)", "SE": "letová informačná služba (FIS)",
    "SF": "letisková letová informačná služba (AFIS)", "SL": "flow control centrum", "SO": "oceánske stredisko",
    "SP": "približovacie stanovište (APP)", "SS": "letová služobná stanica", "ST": "letisková riadiaca veža (TWR)",
    "SU": "horné oblastné stredisko", "SV": "VOLMET", "SY": "horná poradná služba",
    "WA": "letecká ukážka", "WB": "akrobatické lety", "WC": "upútaný balón alebo drak", "WD": "výbuchy",
    "WE": "cvičenie", "WF": "tankovanie za letu", "WG": "lety vetroňov", "WH": "odstrel", "WJ": "vlek bannera/terča",
    "WL": "vypúšťanie balónov", "WM": "streľba raketami, kanónmi", "WP": "zoskoky padákom",
    "WR": "rádioaktívny materiál", "WS": "vypúšťanie horľavých plynov", "WT": "hromadný presun lietadiel",
    "WU": "lety bezpilotných lietadiel (UAS)", "WV": "lety vo formácii", "WW": "vulkanická činnosť",
    "WY": "letecký snímkovací let", "WZ": "lety modelov",
}
Q_CONDITION = {
    "AC": "pridelené", "AD": "zaistené", "AF": "letová kontrola vykonaná", "AG": "v prevádzke", "AH": "zmenené hodiny",
    "AK": "obnovená normálna prevádzka", "AL": "v prevádzke s obmedzeniami", "AM": "vojenská prevádzka",
    "AN": "dostupné pre nočnú prevádzku", "AO": "v prevádzke", "AP": "potrebné povolenie", "AR": "dostupné na požiadanie",
    "AS": "mimo prevádzky", "AU": "nedostupné", "AW": "úplne odvolané", "AX": "predtým ohlásené vypnutie zrušené",
    "CA": "aktivované", "CC": "dokončené", "CD": "deaktivované", "CE": "postavené", "CF": "zmenená frekvencia",
    "CG": "znížené na", "CH": "zmenené", "CI": "zmenený identifikátor", "CL": "zmenená poloha", "CM": "zmenená výška",
    "CN": "zrušené", "CO": "v prevádzke", "CP": "pracuje so zníženým výkonom", "CR": "dočasne nahradené",
    "CS": "nainštalované", "CT": "skúšobná prevádzka", "HA": "brzdný účinok", "HV": "práce dokončené", "HW": "práce prebiehajú",
    "HX": "koncentrácia vtákov", "HY": "sneh odstránený", "LA": "prevádzka na záložný zdroj", "LB": "vyhradené pre lietadlá so základňou",
    "LC": "uzavreté", "LD": "nebezpečné", "LE": "prevádzka bez záložného zdroja", "LF": "rušenie od",
    "LG": "prevádzka bez identifikácie", "LH": "nepoužiteľné pre lietadlá ťažšie ako", "LI": "uzavreté pre IFR",
    "LK": "prevádzka ako stále svetlo", "LL": "použiteľná dĺžka", "LN": "uzavreté v noci", "LP": "zakázané pre",
    "LR": "lietadlá obmedzené na dráhy a TWY", "LS": "podlieha prerušeniu", "LT": "obmedzené na", "LV": "uzavreté pre VFR",
    "LW": "uskutoční sa", "LX": "prevádzka, ale opatrne", "TT": "prah", "XX": "pozri text",
}
CATEGORY = {"A": "airspace", "R": "airspace", "O": "obstacle", "W": "warning", "N": "nav", "I": "nav", "G": "nav",
            "C": "nav", "M": "aerodrome", "F": "aerodrome", "L": "aerodrome", "P": "procedure", "S": "procedure"}

HDR_RE = re.compile(r"(?<![A-Z0-9/])([A-Z]?\d{1,4}/\d{2,4})\s+NOTAM([NRC])\b(?:\s+([A-Z]?\d{1,4}/\d{2,4}))?")
QCOORD_RE = re.compile(r"(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})?")
QCOORD_S_RE = re.compile(r"(\d{2})(\d{2})(\d{2})([NS])(\d{2,3})(\d{2})(\d{2})([EW])")  # neštandardne so sekundami
# súradnica v texte: 6 číslic (aj s desatinami) N/S + 7 číslic E/W, bez ďalšej číslice pred ňou
COORD_RE = re.compile(r"(?<![\d.])(\d{2})(\d{2})(\d{2}(?:[.,]\d+)?)\s*([NS])\s*[,/]?\s*(\d{3}|\d{2}(?=\d{4}(?:[.,]\d+)?\s*[EW]))(\d{2})(\d{2}(?:[.,]\d+)?)\s*([EW])")
PSN_RE = re.compile(r"PSN:?\s*(\d{2})(\d{2})(\d{2}(?:[.,]\d+)?)\s*([NS])\s*(\d{3})(\d{2})(\d{2}(?:[.,]\d+)?)\s*([EW])")
RADIUS_RE = re.compile(r"(?<![\d.])(\d*\.?\d+)\s*NM\s+RADIUS\s+OF\s+(?:[A-Z ]*?\s)?(\d{6}(?:[.,]\d+)?[NS])\s*(\d{7}(?:[.,]\d+)?[EW])")
JUNK_RE = re.compile(r"locationIndicatorICAO|latNlong|\bundefined\b")
# kľúčové slová domácich NOTAM USA (bez Q-kódu)
DOM_KW = {
    "AIRSPACE": ("airspace", "vzdušný priestor", "W"), "TFR": ("airspace", "dočasné obmedzenie letov (TFR)", "W"),
    "SECURITY": ("airspace", "bezpečnostné opatrenia", "W"), "SUA": ("airspace", "priestor osobitného použitia", "W"),
    "OBST": ("obstacle", "prekážka", "AE"), "NAV": ("nav", "navigačné zariadenie", "AE"), "COM": ("nav", "spojenie", "AE"),
    "SVC": ("aerodrome", "služby letiska", "A"), "RWY": ("aerodrome", "dráha (RWY)", "A"), "TWY": ("aerodrome", "pojazdová dráha (TWY)", "A"),
    "APRON": ("aerodrome", "odbavovacia plocha", "A"), "AD": ("aerodrome", "letisko", "A"), "AIRPORT": ("aerodrome", "letisko", "A"),
    "IAP": ("procedure", "prístrojový postup priblíženia", "A"), "SID": ("procedure", "odletová trať (SID)", "A"),
    "STAR": ("procedure", "príletová trať (STAR)", "A"), "ODP": ("procedure", "odletový postup (ODP)", "A"),
    "DVA": ("procedure", "odletová vizuálna oblasť (DVA)", "A"), "VFP": ("procedure", "vizuálny postup", "A"),
    "ROUTE": ("procedure", "trať ATS", "E"), "CHART": ("procedure", "letecká mapa", "E"), "DATA": ("procedure", "letecké údaje", "E"),
    "SPECIAL": ("procedure", "osobitný postup", "A"), "LTA": ("other", "list letcom (LTA)", "E"), "FDC/OTHER": ("other", "FDC", "E"),
}


def _dms(d, m, s, h) -> float:
    v = int(d) + int(m) / 60 + float(str(s).replace(",", ".")) / 3600
    return -v if h in ("S", "W") else v


def _coords(text: str) -> list[tuple[float, float]]:
    out = []
    for m in COORD_RE.finditer(text or ""):
        d1, m1, s1, h1, d2, m2, s2, h2 = m.groups()
        if int(m1) > 59 or int(m2) > 59 or float(s1.replace(",", ".")) >= 60 or float(s2.replace(",", ".")) >= 60:
            continue
        lat, lon = _dms(d1, m1, s1, h1), _dms(d2, m2, s2, h2)
        if abs(lat) <= 90 and abs(lon) <= 180:
            out.append((lat, lon))
    return out


def _notam_time(v: str | None):
    """Pole B)/C) v tvare RRMMDDhhmm[EST] alebo PERM → (iso, est, perm)."""
    if not v:
        return None, False, False
    v = v.strip()
    if v.startswith("PERM"):
        return None, False, True
    m = re.match(r"(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(EST)?", v)
    if not m:
        return None, False, False
    y, mo, d, h, mi = (int(x) for x in m.groups()[:5])
    try:
        t = dt.datetime(2000 + y, mo, d, min(h, 23), mi, tzinfo=UTC)
        if h == 24:
            t += dt.timedelta(hours=1)
    except ValueError:
        return None, False, False
    return iso(t), bool(m.group(6)), False


def _api_time(v: str | None):
    """Polia startDate/endDate FAA NOTAM Search: 'MM/DD/YYYY hhmm[EST]' alebo 'PERM' → (iso, est, perm) alebo None."""
    v = (v or "").strip()
    if not v:
        return None
    if v.upper().startswith("PERM"):
        return None, False, True
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2})(\d{2})\s*(EST)?", v)
    if not m:
        return None
    mo, d, y, h, mi = (int(x) for x in m.groups()[:5])
    try:
        t = dt.datetime(y, mo, d, min(h, 23), mi, tzinfo=UTC) + dt.timedelta(hours=1 if h == 24 else 0)
    except ValueError:
        return None
    return iso(t), bool(m.group(6)), False


def _field(msg: str, key: str, stop: str) -> str | None:
    m = re.search(rf"(?:^|\s|\(){key}\)\s*(.*?)(?=\s(?:{stop})\)|\Z)", msg, re.S)
    return " ".join(m.group(1).split()) if m else None


def _clean(msg: str | None) -> str:
    """Normalizuje text správy: HTML entity, konce riadkov, obálky 'ORIGINAL NOTAM', 'RQR … (…)'."""
    msg = re.sub(r"(?i)<br\s*/?>", "\n", msg or "")
    msg = re.sub(r"</?[a-zA-Z][^<>]{0,40}>", "", msg)  # značky HTML v niektorých prekladoch FAA (<B>Q) </B>…)
    msg = html.unescape(msg).replace("\r", "\n")
    msg = re.sub(r"\n[ \t]*\n+", "\n", msg).strip()
    return msg


def parse_icao(msg: str) -> dict | None:
    """Rozloží NOTAM vo formáte ICAO (hlavička, Q) až G)). Poloha z Q-riadku nemusí byť (lat=None).

    Vráti None pre prázdne, šablónové a neaktuálne správy (nahradené, zrušené, kontrolné zoznamy).
    """
    msg = _clean(msg)
    if len(msg) < 12 or JUNK_RE.search(msg):
        return None
    if re.match(r"NOTAM\s+(REPLACED|CANCELL?ED)\s+BY", msg):
        return None  # pôvodné znenie už nahradeného/zrušeného NOTAM
    hdr = HDR_RE.search(msg[:200])
    if hdr:
        if hdr.group(2) == "C":
            return None  # zrušovací NOTAM nenesie platnú informáciu
        body = msg[hdr.start():]
        if msg[:hdr.start()].rstrip().endswith("(") and body.rstrip().endswith(")"):
            body = body.rstrip()[:-1]
    else:
        body = msg
    if "A)" not in body and "Q)" not in body:
        return None
    # viac častí (PART n OF m): E) všetkých častí za sebou; časti sú oddelené „END PART“ alebo zopakovanou hlavičkou
    parts = re.split(r"END\s+PART\s+\d+\s+OF\s+\d+", body)
    if hdr:
        rep = re.compile(r"\n\s*\(?" + re.escape(hdr.group(1)) + r"\s+NOTAM[NRC]\b")
        parts = [x for part in parts for x in rep.split(part)]
    head = parts[0]
    e_parts = [x for x in (_field(p, "E", "F|G") for p in parts) if x]
    q = {"fir": None, "q": "", "trf": "", "purp": "", "scope": "", "lo": 0, "hi": 999, "lat": None, "lon": None, "r": None}
    qm = re.search(r"Q\)\s*([^\n]*?)(?=\s+A\)|\n|$)", head)
    if qm:
        f = [x.strip() for x in qm.group(1).split("/")]
        if re.fullmatch(r"[A-Z0-9]{4}", f[0]):
            q["fir"] = f[0]
        if len(f) > 1 and re.fullmatch(r"Q[A-Z]{4}", f[1].replace(" ", "")):
            q["q"] = f[1].replace(" ", "")
        # ostatné polia podľa tvaru (niektoré štáty polia vynechávajú alebo oddeľujú medzerou)
        toks = [t for part in f[2:] for t in part.split()]
        slots = [("trf", r"[IVK]+"), ("purp", r"[NBOMK]+"), ("scope", r"[AEWK]+")]
        si, nums = 0, []
        for t in toks:
            if re.fullmatch(r"\d{3}", t) and len(nums) < 2:
                nums.append(int(t))
                continue
            c = QCOORD_RE.fullmatch(t)
            if c:
                la, lam, ns, lo_d, lo_m, ew, rad = c.groups()
                q["lat"], q["lon"] = _dms(la, lam, 0, ns), _dms(lo_d, lo_m, 0, ew)
                q["r"] = int(rad) if rad else None
                continue
            c = QCOORD_S_RE.fullmatch(t)
            if c:
                q["lat"], q["lon"] = _dms(*c.groups()[0:4]), _dms(*c.groups()[4:8])
                continue
            for k in range(si, len(slots)):
                if re.fullmatch(slots[k][1], t):
                    q[slots[k][0]] = t
                    si = k + 1
                    break
        if nums:
            q["lo"] = nums[0]
        if len(nums) > 1:
            q["hi"] = nums[1]
    if q["fir"] == "KKKK" or q["q"] == "QKKKK" or re.search(r"\bE\)\s*CHECKLIST", head):
        return None  # kontrolný zoznam NOTAM
    a = re.search(r"A\)\s*(.*?)\s+B\)", head, re.S)
    a_codes = []
    if a:
        for tok in a.group(1).split():
            if tok == "PART":
                break
            if re.fullmatch(r"[A-Z]{4}", tok):
                a_codes.append(tok)
    b_raw = re.search(r"B\)\s*(WIE|\d{10})", head)
    c_raw = re.search(r"C\)\s*(PERM|UFN|\d{10}\s*(?:EST)?)", head)
    b, _, _ = _notam_time(b_raw.group(1) if b_raw else None)
    c, est, perm = _notam_time(c_raw.group(1) if c_raw else None)
    e_text = "\n".join(e_parts)
    hgt = re.search(r"ELEV/HGT:?\s*([\d.,]+)\s*(M|FT)\s*/\s*([\d.,]+)\s*(M|FT)", e_text)
    s2, c2 = (q["q"][1:3], q["q"][3:5]) if q["q"] else ("", "")
    return {
        "id": hdr.group(1) if hdr else None, "type": hdr.group(2) if hdr else None, "ref": hdr.group(3) if hdr else None,
        "loc": a_codes[0] if a_codes else None, "a": a_codes, "fir": q["fir"],
        "q": q["q"], "subj": Q_SUBJECT.get(s2, "iné" if s2 in ("", "XX") else s2), "cond": Q_CONDITION.get(c2, c2),
        "cat": CATEGORY.get(s2[:1], "other"), "trf": q["trf"], "purp": q["purp"], "scope": q["scope"],
        "lo": q["lo"], "hi": q["hi"], "r": q["r"], "b": b, "c": c, "est": est, "perm": perm,
        "ufn": bool(c_raw and c_raw.group(1) == "UFN"),
        "d": _field(head, "D", "E"), "e": e_text, "f": _field(head, "F", "G"), "g": _field(head, "G", "ZZ"),
        "elev": (f"{hgt.group(1)} {hgt.group(2)} / {hgt.group(3)} {hgt.group(4)}" if hgt else None),
        "qlat": q["lat"], "qlon": q["lon"],
    }


def parse_domestic(trad: str) -> dict | None:
    """Domáci NOTAM USA (!DCA 03/226 DCA RWY … 2603101832-2712310001) – text a kľúčové slovo; viac častí sa spojí."""
    t = _clean(trad)
    m = re.match(r"!([A-Z0-9]{2,5})\s+(\d{1,2}/\d{1,4})\s+([A-Z0-9]{2,5})\s+(.*)", t, re.S)
    if not m:
        return None
    acct, nr, loc, _ = m.groups()
    texts = []
    for piece in re.split(r"\s*END\s+PART\s+\d+\s+OF\s+\d+\s*", t):
        piece = re.sub(r"^!\S+\s+\S+\s+\S+\s+(?:PART\s+\d+\s+OF\s+\d+\s+)?", "", piece.strip())
        piece = re.sub(r"\s*\d{10}-(?:\d{10}(?:EST)?|PERM)\s*$", "", piece)
        if piece:
            texts.append(piece)
    rest = "\n".join(texts)
    kw = rest.split(None, 1)[0] if rest else ""
    return {"id": f"{acct} {nr}", "acct": acct, "loc3": loc, "kw": kw, "text": " ".join(rest.split()) if len(rest) < 400 else rest}


def _near(a: tuple, b: tuple, tol: float) -> bool:
    return abs(a[0] - b[0]) <= tol and abs(((a[1] - b[1] + 180) % 360) - 180) <= tol * 1.5


def _lta_item(n: dict, ads: dict) -> dict | None:
    """List letcom (Letter to Airmen, FAA) – len názov, odkaz na plné znenie a poloha letiska."""
    mp = re.match(r"POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)", n.get("mapPointer") or "")
    icao_id = (n.get("icaoId") or "").strip()
    if mp:
        lat, lon = float(mp.group(2)), float(mp.group(1))
    elif ads.get(icao_id) and ads[icao_id]["lat"] is not None:
        lat, lon = ads[icao_id]["lat"], ads[icao_id]["lon"]
    else:
        return None
    sb, sc = _api_time(n.get("startDate")), _api_time(n.get("endDate"))
    url = (n.get("comment") or "").strip()
    if not (n.get("notamNumber") or "").strip():
        return None
    return {"id": (n.get("notamNumber") or "").strip(), "type": None, "ref": None, "loc": icao_id or n.get("facilityDesignator"),
            "fir": None, "q": "", "subj": "list letcom (LTA)", "cond": "", "cat": "other", "trf": "", "purp": "", "scope": "A",
            "lo": 0, "hi": 999, "r": None, "b": sb[0] if sb else None, "c": sc[0] if sc else None, "est": bool(sc and sc[1]),
            "perm": bool(sc and sc[2]), "d": None, "e": " ".join(html.unescape(n.get("traditionalMessage") or "").split()),
            "f": None, "g": None, "elev": None, "url": url if url.startswith("https://notams.aim.faa.gov/") else None,
            "lat": round(lat, 5), "lon": round(lon, 5), "pos": "ad", "precise": False, "name": n.get("airportName"), "_a": "", "dom": True}


def parse_item(n: dict, ads: dict, fir_label: dict, fir_learn: dict) -> dict | None:
    """Jeden záznam FAA NOTAM Search → NOTAM s polohou, alebo None (neaktuálny, nečitateľný, neumiestniteľný).

    Poloha: PSN/súradnice v texte (presná) → Q-riadok → bod zariadenia FAA (mapPointer) → letisko A) (OurAirports)
    → stred FIR (VATSpy) → medián polôh ostatných NOTAM danej FIR/lokality.
    """
    if str(n.get("cancelledOrExpired")).lower() == "true" or str(n.get("status", "")).lower() in ("cancelled", "expired"):
        return None
    st = (n.get("sourceType") or "").upper()
    trad = n.get("traditionalMessage") or ""
    p = parse_icao(n.get("icaoMessage") or "")
    # domáce (D) a FDC (F) NOTAM USA majú záväzné znenie v traditionalMessage; ostatné (I, M) len ak chýba ICAO znenie
    dom = parse_domestic(trad) if st in ("D", "F") or (p is None and re.match(r"\s*!", trad)) else None
    if not p and not dom:
        if st == "LTA" and trad.strip():
            return _lta_item(n, ads)
        return None
    if p is None:
        p = {"id": None, "type": None, "ref": None, "loc": None, "a": [], "fir": None, "q": "", "subj": "", "cond": "", "cat": "other",
             "trf": "", "purp": "", "scope": "", "lo": 0, "hi": 999, "r": None, "b": None, "c": None, "est": False, "perm": False,
             "ufn": False, "d": None, "e": "", "f": None, "g": None, "elev": None, "qlat": None, "qlon": None}
    icao_id = (n.get("icaoId") or "").strip()
    if dom:
        # domáci NOTAM: text a čísla podľa pôvodnej (domácej) správy, Q-kód z ICAO prekladu, ak je
        p["id"] = dom["id"]
        p["e"] = dom["text"]
        kw = (n.get("keyword") or dom["kw"] or "").upper()
        cat, subj, scope = DOM_KW.get(kw, (None, None, None))
        if cat and (not p["q"] or p["cat"] == "other"):
            p["cat"] = cat
        if subj and (not p["q"] or p["q"] == "QXXXX"):
            p["subj"], p["cond"] = subj, ""
        if not p["scope"] and scope:
            p["scope"] = scope
        p["loc"] = icao_id if re.fullmatch(r"[A-Z0-9]{3,4}", icao_id) else (p["loc"] or dom["loc3"])
        p["dom"] = True
        hgt = re.search(r"(\d+)\s*FT\s*\((\d+)\s*FT\s*AGL\)", dom["text"])
        if hgt:
            p["elev"] = f"{hgt.group(1)} FT AMSL / {hgt.group(2)} FT AGL"
    p["id"] = p["id"] or (n.get("notamNumber") or "").strip() or None
    p["loc"] = p["loc"] or (icao_id or (n.get("facilityDesignator") or "").strip() or None)
    if not p["id"] or not p["loc"]:
        return None
    # čas: polia FAA (startDate/endDate) sú zosúladené s domácim znením, inak B)/C)
    sb, sc = _api_time(n.get("startDate")), _api_time(n.get("endDate"))
    if sb and sb[0]:
        p["b"] = sb[0]
    if sc:
        p["c"], p["est"], p["perm"] = sc
        if sc[0]:
            p["ufn"] = False
    # poloha
    mp = re.match(r"POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)", n.get("mapPointer") or "")
    ref, pos = None, None
    if p["qlat"] is not None:
        ref, pos = (p["qlat"], p["qlon"]), "q"
    elif mp and abs(float(mp.group(2))) <= 90:
        ref, pos = (float(mp.group(2)), float(mp.group(1))), "ad"
    else:
        for code in p["a"] + [icao_id]:
            ad = ads.get(code)
            if ad and ad["lat"] is not None:
                ref, pos = (ad["lat"], ad["lon"]), "ad"
                break
    if ref is None:
        for code in [p["fir"]] + p["a"] + [icao_id, n.get("facilityDesignator")]:
            if code and code in fir_label:
                ref, pos = tuple(fir_label[code]), "fir"
                break
    if ref is None:
        for code in [icao_id, n.get("facilityDesignator")] + p["a"] + [p["fir"]]:
            if code and code in fir_learn:
                ref, pos = tuple(fir_learn[code]), "fir"
                break
    # presná poloha z textu
    e_text = p["e"] or ""
    tol = 10.0 if pos in ("fir", None) or (pos == "q" and (p["r"] or 0) >= 100) else max(1.5, (p["r"] or 0) / 60 * 1.5)
    if pos == "ad" and re.match(r"K?Z[A-Z]{2}$|P[AH]Z[A-Z]$", p["loc"] or ""):
        tol = 10.0  # oblastné stredisko (ARTCC) – bod FAA je len referenčný
    exact = None
    pm = PSN_RE.search(e_text)
    rm = RADIUS_RE.search(e_text)
    if pm:
        exact = (_dms(*pm.groups()[0:4]), _dms(*pm.groups()[4:8]))
    elif rm:
        c = _coords(rm.group(2) + rm.group(3))
        if c:
            exact = c[0]
            rv = float(rm.group(1))
            p["r"] = round(rv, 1) if rv < 10 else round(rv)
            if not p["scope"] or p["scope"] == "A":
                p["scope"] = "W" if p["cat"] in ("airspace", "warning") else p["scope"] or "E"
    elif p.get("dom") or pos != "q" or p["cat"] == "obstacle":
        pts = [c for c in _coords(e_text) if ref is None or _near(c, ref, tol)]
        if pos == "q" and not p.get("dom") and len(pts) != 1:
            pts = []  # pri ICAO NOTAM s Q-riadkom len jednoznačná poloha prekážky
        if len(pts) >= 3:
            exact = (sum(x[0] for x in pts) / len(pts), sum(x[1] for x in pts) / len(pts))
            span = max(max(abs(x[0] - exact[0]) * 60, abs(x[1] - exact[1]) * 60 * math.cos(math.radians(exact[0]))) for x in pts)
            p["r"] = max(1, min(99, round(span)))
        elif pts:
            exact = pts[0]
    if exact and (ref is None or _near(exact, ref, tol)):
        lat, lon, pos = exact[0], exact[1], "psn"
    elif ref:
        lat, lon = ref
    else:
        return None
    p["_a"] = " ".join(p.get("a") or [])
    for k in ("qlat", "qlon", "a"):
        p.pop(k, None)
    p["lat"], p["lon"], p["pos"], p["precise"] = round(lat, 5), round(lon, 5), pos, pos == "psn"
    p["name"] = n.get("airportName")
    if not p.get("dom"):
        p.pop("dom", None)
    if not p.get("ufn"):
        p.pop("ufn", None)
    return p


VATSPY_URL = "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/VATSpy.dat"
VATSPY_BOUNDARIES = "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson"
STORE = OUT / "notam_store.json.gz"
TILES = OUT / "notam"


def _icao_airports(airports_csv: str | None) -> dict[str, dict]:
    """ICAO kód → typ, krajina, poloha (OurAirports)."""
    out: dict[str, dict] = {}
    if not airports_csv:
        return out
    for r in csv.DictReader(io.StringIO(airports_csv)):
        code = r.get("icao_code") or ""
        if not re.fullmatch(r"[A-Z]{4}", code) or r.get("type") in ("closed", "balloonport"):
            continue
        lat, lon = num(r.get("latitude_deg")), num(r.get("longitude_deg"))
        out[code] = {"type": r.get("type"), "cc": r.get("iso_country"), "lat": lat, "lon": lon, "name": r.get("name")}
    return out


def _vatspy(f: Fetcher, world: dict, store: dict, now: dt.datetime) -> tuple[list[str], dict]:
    """Kódy FIR/ARTCC (4 písmená) a stredy FIR (label_lat/lon hraníc) z projektu VATSpy (CC BY-SA 4.0).

    Uloží sa do store a obnovuje raz za 7 dní; neplatné kódy vyradí FAA NOTAM Search.
    """
    cache = store.get("vatspy") or {}
    t = cache.get("t")
    if t and (now - dt.datetime.fromisoformat(t.replace("Z", "+00:00"))).days < 7 and cache.get("firs"):
        return cache["firs"], cache.get("label", {})
    firs, bmap, label = set(), {}, {}
    try:
        txt = f.get(world.get("fir_source", VATSPY_URL), "VATSpy.dat", timeout=60)
        sec = None
        for line in txt.splitlines():
            line = line.strip()
            if line.startswith("["):
                sec = line
                continue
            if sec == "[FIRs]" and line and not line.startswith(";"):
                cols = line.split("|")
                if re.fullmatch(r"[A-Z]{4}", cols[0]):
                    firs.add(cols[0])
                    if len(cols) > 3 and cols[3]:
                        bmap.setdefault(cols[0], cols[3])
    except Exception as e:  # noqa: BLE001
        print(f"[aero] zoznam FIR: {e}", file=sys.stderr)
    try:
        gj = json.loads(f.get(world.get("fir_boundaries", VATSPY_BOUNDARIES), "Boundaries.geojson", timeout=120))
        pos = {}
        for ft in gj.get("features", []):
            pr = ft.get("properties") or {}
            la, lo = num(pr.get("label_lat")), num(pr.get("label_lon"))
            if pr.get("id") and la is not None and lo is not None:
                pos[pr["id"]] = [round(la, 4), round(lo, 4)]
        for code in firs:
            b = bmap.get(code, code)
            if b in pos:
                label[code] = pos[b]
            elif code in pos:
                label[code] = pos[code]
    except Exception as e:  # noqa: BLE001
        print(f"[aero] hranice FIR: {e}", file=sys.stderr)
        label = cache.get("label", {})
    if not firs:
        return cache.get("firs", []), cache.get("label", label)
    store["vatspy"] = {"t": iso(now), "firs": sorted(firs), "label": label}
    return sorted(firs), label


def _learn_positions(notams: dict) -> dict:
    """Medián polôh NOTAM s Q-súradnicami podľa lokality dotazu (_q) a FIR – náhradná poloha pre NOTAM bez súradníc."""
    acc: dict[str, list] = {}
    for v in notams.values():
        if v.get("pos") not in ("q", "psn"):
            continue
        for code in {v.get("_q"), v.get("fir")}:
            if code:
                acc.setdefault(code, []).append((v["lat"], v["lon"]))
    out = {}
    for code, pts in acc.items():
        la = sorted(x[0] for x in pts)
        lo = sorted(x[1] for x in pts)
        out[code] = [round(la[len(la) // 2], 4), round(lo[len(lo) // 2], 4)]
    return out


def _load_store() -> dict:
    if STORE.exists():
        try:
            with gzip.open(STORE, "rt", encoding="utf-8") as fh:
                st = json.load(fh)
            if st.get("version") == 1:
                return st
        except Exception as e:  # noqa: BLE001
            print(f"[aero] NOTAM store: {e}", file=sys.stderr)
    return {"version": 1, "designators": {}, "invalid": {}, "notams": {}}


def _tiles_for(lat: float, lon: float, r_nm: int | None, deg: float) -> list[tuple[int, int]]:
    """Dlaždice deg×deg (x od −180°, y od −90°), ktoré pretína okolie NOTAM (stred ± polomer, najviac 100 NM)."""
    r = min(r_nm or 0, 100) / 60.0
    rlon = min(180.0, r / max(0.05, math.cos(math.radians(lat))))
    nx, ny = round(360 / deg), round(180 / deg)
    y0 = max(0, int(math.floor((lat - r + 90) / deg)))
    y1 = min(ny - 1, int(math.floor((lat + r + 90) / deg)))
    x0 = int(math.floor((lon - rlon + 180) / deg))
    x1 = int(math.floor((lon + rlon + 180) / deg))
    out = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            out.append((x % nx, y))
    return list(dict.fromkeys(out))


def _tile_label(deg: float) -> str:
    return format(deg, "g")


def _quadtiles(feats: list[dict], deg: float, max_feats: int, levels: int) -> dict[str, list]:
    """Rozdelenie NOTAM do dlaždíc: základ deg×deg; dlaždica s viac ako max_feats správami sa delí na štvrtiny
    (deg/2, deg/4 …, najviac `levels` úrovní). Výsledok: kľúč 'deg_x_y' → zoznam objektov; dlaždice sa neprekrývajú."""
    out: dict[str, list] = {}

    def place(items: list, d: float, x: int, y: int, lvl: int):
        if len(items) <= max_feats or lvl >= levels - 1:
            out[f"{_tile_label(d)}_{x}_{y}"] = items
            return
        h = d / 2
        sub: dict[tuple[int, int], list] = {}
        for ft in items:
            lon, lat = ft["geometry"]["coordinates"]
            r = ft["properties"].get("r")
            for (cx, cy) in _tiles_for(lat, lon, r if r and r < 100 else 0, h):
                if cx // 2 == x and cy // 2 == y:
                    sub.setdefault((cx, cy), []).append(ft)
        for (cx, cy), its in sub.items():
            place(its, h, cx, cy, lvl + 1)

    base: dict[tuple[int, int], list] = {}
    for ft in feats:
        lon, lat = ft["geometry"]["coordinates"]
        r = ft["properties"].get("r")
        for k in _tiles_for(lat, lon, r if r and r < 100 else 0, deg):
            base.setdefault(k, []).append(ft)
    for (x, y), its in base.items():
        place(its, deg, x, y, 0)
    return out


def build_notam(f: Fetcher, cfg: dict, airports_csv: str | None) -> dict:
    """NOTAM celého sveta z FAA NOTAM Search.

    Priorita (FIR a letiská z cfg) sa obnovuje každý beh. Ostatné FIR a letiská sveta sa obnovujú postupne podľa
    toho, kedy boli naposledy stiahnuté, v rozpočte požiadaviek a času; NOTAM nestiahnutých lokalít zostávajú
    z predchádzajúcich behov (store), vypršané sa vyradia. Výstup: data/aero/notam/{x}_{y}.json po dlaždiciach
    a data/aero/notam/index.json; úplný stav v data/aero/notam_store.json.gz pre ďalší beh.
    """
    now = now_utc()
    now_s = iso(now)
    batch = int(cfg.get("batch", 25))
    pause = float(cfg.get("pause_s", 0.6))
    max_pages = int(cfg.get("max_pages_per_batch", 80))
    world = cfg.get("world", {})
    budget = cfg.get("budget", {})
    max_req = int(budget.get("max_requests", 600))
    max_sec = float(budget.get("max_seconds", 900))
    deg = float(cfg.get("tile_deg", 10))
    ads = _icao_airports(airports_csv)
    store = _load_store()
    dstate: dict = store["designators"]
    invalid: dict = store["invalid"]
    notams: dict = store["notams"]
    # neplatné kódy sa po 30 dňoch skúsia znova
    for k, t in list(invalid.items()):
        if (now - dt.datetime.fromisoformat(t.replace("Z", "+00:00"))).days >= 30:
            invalid.pop(k)

    pr_cc = set(cfg.get("aerodrome_countries", []))
    priority = list(dict.fromkeys(cfg.get("firs", []) + cfg.get("extra_locations", []) +
                                  sorted(c for c, a in ads.items() if a["cc"] in pr_cc)))
    others: list[str] = []
    seen: dict = store.setdefault("codes", {})  # kódy FIR z Q-riadkov a A) (nie letiská), naposledy videné
    fir_label: dict = {}
    if world.get("enabled", False):
        firs_v, fir_label = _vatspy(f, world, store, now)
        if not f.fx:
            firs = set(firs_v)
            if world.get("learn_firs", True):
                lim = iso(now - dt.timedelta(days=90))
                firs |= {c for c, t in seen.items() if t >= lim}
            types = set(world.get("aerodrome_types", ["large_airport", "medium_airport", "small_airport"]))
            others = sorted(firs) + sorted(c for c, a in ads.items() if a["type"] in types)
    fir_learn = _learn_positions(notams)
    pset = set(priority)
    others = [d for d in dict.fromkeys(others) if d not in pset]
    universe = set(priority) | set(others)
    # poradie: priorita, potom najdlhšie nestiahnuté (nikdy nestiahnuté najprv, FIR pred letiskami)
    others.sort(key=lambda d: (dstate.get(d, {}).get("t") or "", 0 if d not in ads else 1, d))
    queue = [d for d in priority + others if d not in invalid]

    t_start = time.time()
    req = 0
    errors: list[str] = []
    fetched: set[str] = set()
    blocked = False
    skipped = 0

    def query(group: list[str], offset: int) -> dict:
        nonlocal req
        req += 1
        if f.fx:  # offline test: jedna uložená odpoveď pre prvú stránku každej skupiny
            p = f.fx / "notam_search.json"
            if offset == 0 and p.exists():
                return json.loads(p.read_text())
            return {"notamList": [], "totalNotamCount": 0, "error": ""}
        r = f.s.post(NOTAM_URL, data={"searchType": "0", "designatorsForLocation": ",".join(group),
                                      "offset": str(offset), "notamsOnly": "false"},
                     headers={"Referer": NOTAM_HOME}, timeout=60)
        r.raise_for_status()
        return r.json()

    if not f.fx:
        try:
            f.s.get(NOTAM_HOME, timeout=30)
        except Exception:  # noqa: BLE001
            pass

    def owner(n: dict, group: list[str]) -> str:
        loc = n.get("loc") or ""
        if loc in group:
            return loc
        a = n.get("_a") or ""
        for g in group:
            if g in a:
                return g
        return group[0]

    i = 0
    while i < len(queue):
        prio_left = any(d in pset for d in queue[i:i + batch])
        if not prio_left and (req >= max_req or time.time() - t_start > max_sec):
            break
        group = [d for d in queue[i:i + batch] if d not in invalid]
        i += batch
        got: list[dict] = []
        offset, page, complete = 0, 0, False
        while group and page < max_pages:
            try:
                j = query(group, offset)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{','.join(group[:3])}…: {type(e).__name__} {e}"[:200])
                if isinstance(e, (requests.HTTPError, ValueError)) and req <= 3:
                    blocked = True  # prvé požiadavky zlyhali: služba je nedostupná alebo blokuje
                break
            err = j.get("error") or ""
            bad = re.findall(r"'([A-Z0-9]{3,5})'", err) if "Invalid location" in err else []
            if bad:
                for b in bad:
                    invalid[b] = now_s
                group = [x for x in group if x not in invalid]
                if not f.fx:
                    time.sleep(pause)
                continue
            if err:
                errors.append(f"{','.join(group[:3])}…: {err}"[:200])
                break
            lst = j.get("notamList") or []
            for n in lst:
                p = parse_item(n, ads, fir_label, fir_learn)
                if not p:
                    skipped += 1
                    continue
                for code in [p.get("fir")] + (p.get("_a") or "").split():
                    if code and re.fullmatch(r"[A-Z]{4}", code) and code not in ads and code not in ("ZXXX", "KFDC", "KFIR"):
                        seen[code] = now_s
                got.append(p)
            offset += len(lst)
            page += 1
            total = int(j.get("totalNotamCount") or 0)
            if not lst or offset >= total:
                complete = True
                break
            if not f.fx:
                time.sleep(pause)
        if not group:
            continue
        if complete:
            # úplne stiahnutá skupina: NOTAM týchto lokalít sa nahradia novými
            gset = set(group)
            for k in [k for k, v in notams.items() if v.get("_q") in gset]:
                notams.pop(k)
            for p in got:
                p["_q"] = owner(p, group)
                p["u"] = now_s
                p.pop("_a", None)
                notams[f"{p['id']}|{p['loc']}"] = p
            cnt: dict[str, int] = {}
            for p in got:
                cnt[p["_q"]] = cnt.get(p["_q"], 0) + 1
            for d in group:
                dstate[d] = {"t": now_s, "n": cnt.get(d, 0)}
                fetched.add(d)
        if blocked:
            break
        if not f.fx:
            time.sleep(pause)

    # vyradenie vypršaných a lokalít mimo aktuálneho zoznamu
    for k, v in list(notams.items()):
        c = v.get("c")
        if c and c < now_s and not v.get("est"):
            notams.pop(k)
        elif v.get("_q") and v["_q"] not in universe:
            notams.pop(k)
    for d in list(dstate):
        if d not in universe:
            dstate.pop(d)

    # dlaždice (adaptívne: husté oblasti sa delia na menšie)
    feats_all = []
    for v in notams.values():
        props = {k: val for k, val in v.items() if k not in ("lat", "lon", "_q", "name") and val is not None and val is not False and val != ""}
        feats_all.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [v["lon"], v["lat"]]}, "properties": props})
    tiles = _quadtiles(feats_all, deg, int(cfg.get("tile_max_features", 1500)), int(cfg.get("tile_levels", 4)))
    if TILES.exists():
        for old in TILES.glob("*.json"):
            old.unlink()
    TILES.mkdir(parents=True, exist_ok=True)
    size = 0
    centers: dict[str, list] = {}
    for t, feats in tiles.items():
        feats.sort(key=lambda x: (x["properties"].get("loc") or "", x["properties"].get("id") or ""))
        size += write_json(f"notam/{t}.json", {"type": "FeatureCollection", "features": feats})
        d, x, y = t.split("_")
        d, x, y = float(d), int(x), int(y)
        w, so = -180 + x * d, -90 + y * d
        la = sum(ft["geometry"]["coordinates"][1] for ft in feats) / len(feats)
        lo = sum(((ft["geometry"]["coordinates"][0] - w + 180) % 360) - 180 + w for ft in feats) / len(feats)
        centers[t] = [round(min(max(la, so), so + d), 3), round(min(max(lo, w), w + d), 3)]
    ages = [dstate[d]["t"] for d in universe if d in dstate and d not in invalid]
    def within(h):
        lim = iso(now - dt.timedelta(hours=h))
        return sum(1 for a in ages if a >= lim)
    valid_total = len([d for d in universe if d not in invalid])
    cov = {"locations": valid_total, "fetched_ever": len(ages), "fresh_1h": within(1.5), "fresh_6h": within(6),
           "fresh_24h": within(24), "oldest": min(ages) if ages else None, "priority": len([d for d in priority if d not in invalid])}
    levels = sorted({t.split("_")[0] for t in tiles}, key=lambda x: -float(x)) or [_tile_label(deg)]
    write_json("notam/index.json", {"generated": now_s, "tile_deg": deg, "levels": levels, "count": len(notams),
                                    "tiles": {t: len(v) for t, v in sorted(tiles.items())}, "centers": centers, "coverage": cov,
                                    "priority": {"firs": cfg.get("firs", []), "countries": sorted(pr_cc)}})
    store.update({"version": 1, "updated": now_s, "designators": dstate, "invalid": invalid, "notams": notams})
    with gzip.open(STORE, "wt", encoding="utf-8") as fh:
        json.dump(store, fh, ensure_ascii=False, separators=(",", ":"))
    old = OUT / "notam.json"
    if old.exists():
        old.unlink()
    if blocked and not fetched:
        raise RuntimeError("FAA NOTAM Search neodpovedá alebo blokuje požiadavky; ponechané NOTAM z predchádzajúcich behov "
                           f"({len(notams)}). {errors[0] if errors else ''}")
    return {"count": len(notams), "tiles": len(tiles), "bytes": size, "requests": req, "seconds_used": round(time.time() - t_start),
            "fetched_now": len(fetched), "coverage": cov, "invalid": len(invalid), "skipped": skipped, "errors": errors[:20]}


# --------------------------------------------------------------------------- letiská a navigačné zariadenia
AD_TYPE = {"large_airport": "L", "medium_airport": "M", "small_airport": "S", "heliport": "H", "seaplane_base": "W"}


def build_airports(f: Fetcher, cfg: dict, airports_csv: str) -> dict:
    rw_csv = f.get(OURAIRPORTS + "runways.csv", "runways.csv")
    fq_csv = f.get(OURAIRPORTS + "airport-frequencies.csv", "airport-frequencies.csv")
    nv_csv = f.get(OURAIRPORTS + "navaids.csv", "navaids.csv")
    runways: dict[str, list[str]] = {}
    for r in csv.DictReader(io.StringIO(rw_csv)):
        if r.get("closed") == "1":
            continue
        ln = num(r.get("length_ft"))
        txt = "/".join(x for x in (r.get("le_ident"), r.get("he_ident")) if x)
        txt += f" {round(ln * 0.3048)} m" if ln else ""
        txt += f" {r.get('surface')}" if r.get("surface") else ""
        txt += " osv." if r.get("lighted") == "1" else ""
        runways.setdefault(r["airport_ident"], []).append(txt.strip())
    freqs: dict[str, list[str]] = {}
    for r in csv.DictReader(io.StringIO(fq_csv)):
        if r.get("frequency_mhz"):
            freqs.setdefault(r["airport_ident"], []).append(f"{r.get('type') or r.get('description')} {r['frequency_mhz']}")
    groups: dict[str, dict] = {}
    major = []
    counts: dict[str, int] = {}
    rows = [r for r in csv.DictReader(io.StringIO(airports_csv)) if r.get("type") in AD_TYPE]
    for r in rows:
        counts[r["iso_country"]] = counts.get(r["iso_country"], 0) + 1
    split = int(cfg.get("split_threshold", 3000))
    key_of = lambda cc, region: (region if counts.get(cc, 0) > split and region else cc)  # noqa: E731
    for r in rows:
        lat, lon = num(r.get("latitude_deg")), num(r.get("longitude_deg"))
        if lat is None or lon is None:
            continue
        t = AD_TYPE[r["type"]]
        rec = [r["ident"], t, r["name"], round(lat, 5), round(lon, 5), num(r.get("elevation_ft"), int),
               r.get("icao_code") or None, r.get("iata_code") or None, r.get("municipality") or None,
               "; ".join(runways.get(r["ident"], [])) or None, "; ".join(freqs.get(r["ident"], [])) or None]
        k = key_of(r["iso_country"], r.get("iso_region"))
        groups.setdefault(k, {"ad": [], "nav": []})["ad"].append(rec)
        if t in ("L", "M"):
            major.append([r["ident"], t, r["name"], round(lat, 4), round(lon, 4), r.get("icao_code") or None,
                          r.get("iata_code") or None, r["iso_country"]])
    for r in csv.DictReader(io.StringIO(nv_csv)):
        lat, lon = num(r.get("latitude_deg")), num(r.get("longitude_deg"))
        if lat is None or lon is None:
            continue
        cc = r.get("iso_country") or "XX"
        k = cc if cc in groups or counts.get(cc, 0) <= split else None
        if k is None:  # krajina rozdelená na regióny – navaid priradíme k najbližšiemu regiónu podľa obálky
            best, bd = None, 1e9
            for key, g in groups.items():
                if not key.startswith(cc + "-") or not g["ad"]:
                    continue
                d = min(abs(a[3] - lat) + abs(a[4] - lon) for a in g["ad"][:: max(1, len(g["ad"]) // 50)])
                if d < bd:
                    best, bd = key, d
            k = best or cc
        groups.setdefault(k, {"ad": [], "nav": []})["nav"].append(
            [r["ident"], r["type"], r["name"], round(lat, 5), round(lon, 5), num(r.get("frequency_khz"), int),
             num(r.get("elevation_ft"), int), r.get("associated_airport") or None])
    index = {}
    total = 0
    for k, g in groups.items():
        pts = [(a[3], a[4]) for a in g["ad"]] + [(n[3], n[4]) for n in g["nav"]]
        if not pts:
            continue
        lats, lons = [p[0] for p in pts], [p[1] for p in pts]
        index[k] = [round(min(lons), 3), round(min(lats), 3), round(max(lons), 3), round(max(lats), 3),
                    len(g["ad"]), len(g["nav"])]
        total += write_json(f"ad/{k}.json", {"ad_fields": ["ident", "type", "name", "lat", "lon", "elev_ft", "icao",
                                                            "iata", "city", "runways", "freqs"],
                                              "nav_fields": ["ident", "type", "name", "lat", "lon", "freq_khz",
                                                             "elev_ft", "airport"], **g})
    total += write_json("ad/index.json", index)
    total += write_json("ad_major.json", {"fields": ["ident", "type", "name", "lat", "lon", "icao", "iata", "cc"],
                                          "rows": major})
    return {"airports": sum(len(g["ad"]) for g in groups.values()), "navaids": sum(len(g["nav"]) for g in groups.values()),
            "files": len(index), "major": len(major), "bytes": total}


# --------------------------------------------------------------------------- openAIP (voliteľné)
def build_openaip(f: Fetcher, cfg: dict, key: str) -> dict:
    res, errors, total = {}, [], 0
    for typ in cfg.get("types", []):
        feats = []
        for cc in cfg.get("countries", []):
            page = 1
            while page < 50:
                try:
                    r = f.s.get(OPENAIP_API + typ, params={"country": cc, "page": page, "limit": 1000},
                                headers={"x-openaip-api-key": key, "Accept": "application/json"}, timeout=60)
                    r.raise_for_status()
                    j = r.json()
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{typ} {cc}: {e}")
                    break
                for it in j.get("items", []):
                    g = it.get("geometry")
                    if not g:
                        continue
                    props = {k: it.get(k) for k in ("name", "type", "icaoClass", "activity", "onDemand", "onRequest",
                                                    "byNotam", "country", "upperLimit", "lowerLimit", "elevation",
                                                    "height", "frequencies") if it.get(k) is not None}
                    feats.append({"type": "Feature", "geometry": g, "properties": props})
                if page >= int(j.get("totalPages") or 1):
                    break
                page += 1
                time.sleep(0.3)
        total += write_json(f"openaip_{typ}.json", {"type": "FeatureCollection", "features": feats})
        res[typ] = len(feats)
    return {"counts": res, "bytes": total, "errors": errors[:20]}


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="čiarkou oddelené: metar,taf,sigmet,notam,airports,openaip")
    ap.add_argument("--fixtures", type=Path, help="priečinok s uloženými odpoveďami (offline test)")
    a = ap.parse_args()
    parts = set((a.only or "metar,taf,sigmet,notam,airports,openaip").split(","))
    cfg = json.loads((ROOT / "sources" / "aero.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    meta_path = OUT / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"sources": {}}
    f = Fetcher(a.fixtures)
    started = now_utc()

    def run(name: str, fn):
        t0 = time.time()
        try:
            info = fn()
            info.update({"state": "warn" if info.get("errors") else "ok", "updated": iso(now_utc())})
        except Exception as e:  # noqa: BLE001
            prev = meta["sources"].get(name, {})
            info = {**prev, "state": "down", "error": f"{type(e).__name__}: {e}"[:300], "checked": iso(now_utc())}
        info["seconds"] = round(time.time() - t0, 1)
        meta["sources"][name] = info
        print(f"[aero] {name}: {info.get('state')} {json.dumps({k: v for k, v in info.items() if k in ('count', 'airports', 'navaids', 'counts', 'requests', 'error')}, ensure_ascii=False)}")

    airports_csv = None
    if parts & {"notam", "airports"}:
        try:
            airports_csv = f.get(OURAIRPORTS + "airports.csv", "airports.csv")
        except Exception as e:  # noqa: BLE001
            print(f"[aero] airports.csv: {e}", file=sys.stderr)
    if "metar" in parts:
        run("metar", lambda: build_metar(f))
    if "taf" in parts:
        run("taf", lambda: build_taf(f))
    if "sigmet" in parts:
        run("sigmet", lambda: build_sigmet(f))
    if "notam" in parts:
        run("notam", lambda: build_notam(f, cfg["notam"], airports_csv))
    if "airports" in parts and airports_csv:
        run("airports", lambda: build_airports(f, cfg.get("airports", {}), airports_csv))
    key = os.environ.get("OPENAIP_API_KEY", "").strip()
    if "openaip" in parts:
        if key and not a.fixtures:
            run("openaip", lambda: build_openaip(f, cfg["openaip"], key))
        else:
            meta["sources"]["openaip"] = {"state": "off", "note": "nenastavený OPENAIP_API_KEY"}
    meta.update({"generated": iso(now_utc()), "started": iso(started), "airac": airac(now_utc().date()),
                 "notam_region": {"firs": cfg["notam"]["firs"], "countries": cfg["notam"]["aerodrome_countries"],
                                  "world": bool(cfg["notam"].get("world", {}).get("enabled"))},
                 "disclaimer": "Len informatívne údaje. Nenahrádzajú predletovú prípravu ani oficiálne zdroje "
                               "(AIP, NOTAM/PIB, letecké meteorologické informácie)."})
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
