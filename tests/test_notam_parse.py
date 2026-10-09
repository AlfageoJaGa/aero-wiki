"""Test rozkladu NOTAM na skutočných vzorkách z FAA NOTAM Search (9. 10. 2026)."""
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent / "scripts"))
import build_aero as b  # noqa: E402

ADS = {"VIDF": None}
ADS = {
    "VILH": {"type": "medium_airport", "cc": "IN", "lat": 34.1359, "lon": 77.5465, "name": "Leh"},
    "OPKR": {"type": "large_airport", "cc": "PK", "lat": 24.9065, "lon": 67.1608, "name": "Karachi"},
    "PHNL": {"type": "large_airport", "cc": "US", "lat": 21.3187, "lon": -157.9224, "name": "Honolulu"},
}
LABEL = {"OIIX": [32.5, 53.6], "KZNY": [39.0, -68.0]}
LEARN = {"ZBPE": [39.9, 116.4]}


def item(m, **k):
    d = {"icaoMessage": m, "cancelledOrExpired": False, "status": "Active", "traditionalMessage": " ", "sourceType": "I"}
    d.update(k)
    return d


def P(m, **k):
    return b.parse_item(item(m, **k), ADS, LABEL, LEARN)


res = {}
# 1 Q bez súradníc, A) s dvoma kódmi → poloha druhého (letisko), C) EST
r = P("D0777/14 NOTAMN\nQ) VIDF/QMRHW/IV/NBO/A/000/999/\nA) VIDF VILH B) 1410031525 C) 1501031525 EST\nE) RWY RELAYING WIP.")
assert r and r["id"] == "D0777/14" and r["loc"] == "VIDF" and r["pos"] == "ad" and abs(r["lat"] - 34.1359) < 1e-3 and r["est"], r
# 2 kontrolný zoznam
assert P(" D0001/18 NOTAMR D1371/17\nQ) VIDF/QKKKK/K/K/K/000/999/\nA) VIDF PART 1 OF 2 B) 1801010000 C) 1801312359 EST\nE) CHECKLIST \n\nYEAR=2000?0341") is None
# 3 viac FIR (UUXX), súradnice v Q
r = P("U1184/23 NOTAMN\nQ) UUXX/QANXX/I/NBO/E/210/530/5049N05000E055\nA) UUWV URRV B) 2309200000 C) PERM\nE) MOSCOW FIR, ROSTOV-NA-DONU FIR\nAREA NAVIGATION RTE T619 SEGMENTS ESTABLISHED:\nNCRP LUGIL - CRP IVNIL (504146N 0425436E) - CRP OBABI.\nF) FL210  G) FL530")
assert r["pos"] == "q" and r["fir"] == "UUXX" and r["perm"] and r["lo"] == 210 and r["hi"] == 530 and r["r"] == 55 and r["f"] == "FL210" and r["g"] == "FL530", r
assert abs(r["lat"] - (50 + 49 / 60)) < 1e-3 and abs(r["lon"] - 50) < 1e-3
# 4 bez medzier za zátvorkou, \r\n
r = P("G0188/26 NOTAMN\r\nQ)UUWV/QGWXX/IV/NBO/AE/000/999/5535N03716E300\r\nA)UUWV B)2605061500 C)2612242359\r\nE)MOSCOW FIR: GNSS INTERRUPTIONS POSS.")
assert r["id"] == "G0188/26" and r["q"] == "QGWXX" and r["cat"] == "nav" and r["c"] == "2026-12-24T23:59:00Z" and r["e"] == "MOSCOW FIR: GNSS INTERRUPTIONS POSS.", r
# 5 jednoriadkový čínsky formát, ZXXX, bez súradníc → naučená poloha lokality
r = P(" A2100/26 NOTAMN Q) ZXXX/QXXXX/IV/NBO/E/000/999/ A) ZBPE ZLHW  PART 1 OF 2  B) 2606101600  C) PERM  E) AIRCRAFT OPERATING ON THE THE FOLLOWING ROUTES SHALL ADHERE TO \nTHE SPECIAL EMERGENCY DESCENT PROCEDURE.", icaoId="ZBPE", facilityDesignator="ZBPE")
assert r["loc"] == "ZBPE" and r["pos"] == "fir" and r["lat"] == 39.9 and r["subj"] == "iné" and r["perm"], r
# 6 FIR bez súradníc → stred FIR (VATSpy)
r = P("A1306/26 NOTAMR A1282/26\r\nQ) OIIX/QAFXX///E/000/999/\r\nA) OIIX B) 2606221121 C) 2609190830 EST\r\nE) TEHRAN FIR RESUMED NORMAL OPERATION",
      startDate="06/22/2026 1121", endDate="09/19/2026 0830EST")
assert r["pos"] == "fir" and r["lat"] == 32.5 and r["ref"] == "A1282/26" and r["type"] == "R" and r["est"] and r["c"] == "2026-09-19T08:30:00Z", r
# 7 C) s EST bez medzery
r = P("C0039/26 NOTAMR C0025/26\r\nQ) OPKR/QOBCE/IV/M/AE/000/002/2410N06826E025\r\nA) OPKR\r\nB) 2606300300 C) 2609300700EST\r\nE) RIG NO. PETEJI-2. 150FT HIGH RIG")
assert r["est"] and r["c"] == "2026-09-30T07:00:00Z" and r["cat"] == "obstacle" and r["b"] == "2026-06-30T03:00:00Z", r
# 8 obálka ORIGINAL NOTAM
r = P("ORIGINAL NOTAM\r\n(A0753/20 NOTAMN \r\nQ)FAXX/QFUXX/IV/NBO/E/000/999/2956S02344E609\r\nA)FAJA FACA B)2002180901 C)PERM\r\nE)AVGAS FUEL SUPPLY AT VARIOUS AP SUSPECTED TO BE CONTAMINATED)")
assert r["id"] == "A0753/20" and r["loc"] == "FAJA" and r["lat"] < -29 and r["e"].endswith("CONTAMINATED"), r
# 9 obálka RQR, medzery v poliach Q
r = P("RQR FAJN F0016/26\n(F0016/26 NOTAMN\nQ) FAXX/QOAXX/IV/BO /E /000/999/2838S02458E533\nA) FAJA FACA B) 2601280719 C) PERM\nE) HAND AMEND AIC D005/2017)")
assert r["id"] == "F0016/26" and r["purp"] == "BO" and r["scope"] == "E" and r["e"] == "HAND AMEND AIC D005/2017", r
# 10 nahradený NOTAM
assert P("NOTAM REPLACED BY A2578/26\r\n(A1598/26 NOTAMR A1544/26\r\nQ) SKED/QGAXX/I/NBO/A/000/150/0226N07636W030\r\nA) SKED\r\nB) 2606041141 C) 2609012359EST\r\nE) OPS GNSS)") is None
# 11 \r\r\n, D)
r = P("B1390/26 NOTAMN\r\r\nQ) MMFR/QWPLW/IV/M/W/000/170/1842N09853W003\r\r\nA) MMFR\r\r\nB) 2607111300\r\r\nC) 2610112359\r\r\nD) DLY 1300-2359\r\r\nE) PJE WILL TAKE PLACE\r\r\n   LATERAL LIMIT CIRCLE OF 3NM OF RADIUS WITH CENTER IN:\r\r\n   184203N  0985329.9W")
assert r["d"] == "DLY 1300-2359" and r["cat"] == "warning" and r["r"] == 3 and r["pos"] == "q", r
# 12 bez Q, WIE/UFN, poloha z mapPointer
r = P("A0429/09 NOTAMR A0151/03\nA) KZNY  B) WIE  C) UFN  \nE) QXXXX BEACON CODE PROCEDURES", mapPointer="POINT(-73.097053 40.783986)", icaoId="KZNY", startDate="06/29/2009 1752", endDate="PERM")
assert r["loc"] == "KZNY" and r["pos"] == "ad" and r["perm"] and r["b"] == "2009-06-29T17:52:00Z", r
# 13 prázdne polia Q
r = P("A0580/11 NOTAMN\nQ) KZNY/QXXXX//////\nA) KZNY\nB) WIE\nC) UFN\nE) QXXXX WHENEVER AN EASTBOUND NORTH ATLANTIC TRACK", icaoId="KZNY")
assert r["q"] == "QXXXX" and r["pos"] == "fir" and r.get("ufn"), r
# 14 domáci USA bez ICAO znenia, prekážka so súradnicami
r = P(" ", traditionalMessage="!HNL 11/343 HNL OBST CRANE (ASN 2021-AWP-13793-OE) 212109N1575757W (3.7NM NW HNL) 395FT (395FT AGL) U/S 2311302236-2812312359",
      sourceType="D", keyword="OBST", icaoId="PHNL", facilityDesignator="HNL", mapPointer="POINT(-157.9224 21.3187)", notamNumber="11/343",
      startDate="11/30/2023 2236", endDate="12/31/2028 2359")
assert r["id"] == "HNL 11/343" and r["loc"] == "PHNL" and r["cat"] == "obstacle" and r["pos"] == "psn" and r["elev"] == "395 FT AMSL / 395 FT AGL", r
assert abs(r["lat"] - 21.3525) < 1e-3 and abs(r["lon"] + 157.96583) < 1e-3 and r["c"] == "2028-12-31T23:59:00Z" and r["e"].startswith("OBST CRANE"), r
# 15 FDC: ICAO preklad s iným C) – rozhoduje endDate
r = P("Q) KZNY/QPIXX/I/NBO/A/000/999/4038N07346W005\nA) KJFK\nB) 2510211421\nC) 2606021421EST\nE) JFK JOHN F KENNEDY INTL, NEW YORK, NY.\nILS OR LOC RWY 4L, AMDT 11E...",
      traditionalMessage="!FDC 5/3815 JFK IAP JOHN F KENNEDY INTL, NEW YORK, NY.\nILS OR LOC RWY 4L, AMDT 11E...\n2510211421-2710211421EST", sourceType="F", keyword="IAP",
      icaoId="KJFK", mapPointer="POINT(-73.7789 40.6398)", notamNumber="5/3815", startDate="10/21/2025 1421", endDate="10/21/2027 1421EST")
assert r["id"] == "FDC 5/3815" and r["c"] == "2027-10-21T14:21:00Z" and r["est"] and r["cat"] == "procedure" and r["pos"] == "q" and "2510211421" not in r["e"], r
# 16 FDC s kruhom NM RADIUS OF
r = P(" ", traditionalMessage="!FDC 6/2400 ZAU AIRSPACE ADS-B, AUTO DEPENDENT SURVEILLANCE REBROADCAST (ADS-R), TFC INFO SERVICE BCST (TIS-B) SERVICES MAY NOT BE AVBL WI AN AREA DEFINED AS 45NM RADIUS OF 431005N0902047W. AP AIRSPACE AFFECTED MAY INCLUDE DLL. 2609110935-2701252200",
      sourceType="F", keyword="AIRSPACE", icaoId="KZAU", mapPointer="POINT(-87.761719 41.789475)", startDate="09/11/2026 0935", endDate="01/25/2027 2200")
assert r["r"] == 45 and r["pos"] == "psn" and r["cat"] == "airspace" and r["scope"] == "W" and abs(r["lat"] - 43.168) < 1e-3, r
# 17 šablónový ICAO preklad → len domáce znenie
r = P("Q) KFIR/QXXXX/I/NBO/A/000/999/latNlongW025\nA) locationIndicatorICAO\nB) 2105172011\nC) 2112272010EST\nE) undefined",
      traditionalMessage="!FDC 5/1165 ZDC NC..ROUTE ZDC ZTL.\nV454 GIZMO, NC TO LIBERTY (LIB) VORTAC, NC MEA 3100.\n2504242034-2705012034EST", sourceType="F", keyword="ROUTE",
      icaoId="KZDC", mapPointer="POINT(-77.542767 39.101217)", startDate="04/24/2025 2034", endDate="05/01/2027 2034EST")
assert r["id"] == "FDC 5/1165" and r["cat"] == "procedure" and r["pos"] == "ad" and r["fir"] is None and r["subj"] == "trať ATS", r
# 18 medzery v Q, mapPointer aj Q → Q
r = P("A1822/26 NOTAMR A1052/26\r\nQ) LZBB/QPIXX/I /NBO/A /000/999/4810N01713E005\r\nA) LZIB B) 2608211046 C) 2611212359EST\r\nE) LPV",
      mapPointer="POINT(17.21272778 48.17006667)", icaoId="LZIB", startDate="08/21/2026 1046", endDate="11/21/2026 2359EST")
assert r["trf"] == "I" and r["scope"] == "A" and r["pos"] == "q" and r["est"], r
# 19 šablóna bez domáceho znenia
assert P("Q) KFIR/QXXXX/I/NBO/A/000/999/latNlongW025 A) locationIndicatorICAO B) 2105172011 C) undefined E) undefined") is None
# 20 HTML entity
r = P("A0001/26 NOTAMN\nQ) LZBB/QOBCE/IV/M/AE/000/005/4810N01713E005\nA) LZIB B) 2601010000 C) PERM\nE) CRANE PSN 481012N0171234E PILOT&apos;S ATTENTION")
assert "PILOT'S" in r["e"] and r["pos"] == "psn" and abs(r["lat"] - 48.17) < 1e-3, r
# 21 domáci s ICAO prekladom bez Q-kódu, presná poloha z textu
r = P("03/528 NOTAMR \r\nQ) KZDC//IV/M//000//3851N07702W005 \r\nA) KDCA \r\nB) 2603201933 \r\nC) 3012312359 \r\nE) CRANE",
      traditionalMessage="!DCA 03/528 DCA OBST CRANE (ASN UNKNOWN) 385237N0770214W (1.53NM N DCA) \r\n 152FT (150FT AGL) FLAGGED AND LGTD 2603201933-3012312359",
      sourceType="D", keyword="OBST", icaoId="KDCA", mapPointer="POINT(-77.0377 38.8521)", startDate="03/20/2026 1933", endDate="12/31/2030 2359")
assert r["id"] == "DCA 03/528" and r["subj"] == "prekážka" and r["cat"] == "obstacle" and r["pos"] == "psn" and abs(r["lat"] - 38.87694) < 1e-3, r
# 22 zrušený / NOTAMC
assert b.parse_item(item("A0002/26 NOTAMC A0001/26\nQ) LZBB/QOBXX/IV/M/AE/000/005/4810N01713E005\nA) LZIB B) 2601010000\nE) REF NOTAM CANCELLED"), ADS, LABEL, LEARN) is None
assert b.parse_item(item("A0003/26 NOTAMN\nQ) LZBB/QOBXX/IV/M/AE/000/005/4810N01713E005\nA) LZIB B) 2601010000 C) PERM\nE) X", cancelledOrExpired=True), ADS, LABEL, LEARN) is None
# 23 bez akejkoľvek polohy → None
assert P("A0004/26 NOTAMN\nQ) XXXX/QAFXX///E/000/999/\nA) QQQQ B) 2601010000 C) PERM\nE) NOWHERE") is None
print("parse OK: 23 prípadov")
# 24 vojenský (M): ICAO znenie má prednosť pred '!' tradičným
r = P("V0618/26 NOTAMN \r\nQ) LPPC/QPICH/I/BO/A/000/999/3846N00908W005 \r\nA) LPPT \r\nB) 2608201600 \r\nC) 2611181600 \r\nE) [US DOD PROCEDURAL NOTAM] INSTRUMENT APPROACH PROCEDURE AMENDMENT RNP Y RWY 02",
      traditionalMessage="!LPPT V0618/26 LPPT AERODROME INSTRUMENT APPROACH PROCEDURE AMENDMENT RNP Y RWY 02", sourceType="M", keyword="MILITARY", icaoId="LPPT",
      mapPointer="POINT(-9.135919 38.781311)", startDate="08/20/2026 1600", endDate="11/18/2026 1600")
assert r["id"] == "V0618/26" and r["loc"] == "LPPT" and "dom" not in r and r["cat"] == "procedure", r
# 25 prekážka: jedna súradnica v texte s 6-cifernou dĺžkou
r = P("ORIGINAL NOTAM\r\n(M3283/25 NOTAMN\r\nQ) LIBB/QOBCE/IV/M/AE/000/035/4057N01703E005\r\nA) LIBB\r\nB) 2507040925 C) PERM\r\nE) LOW FLYING ZONE BOAT SUD OBSTACLES\r\nNEW OBST ERECTED:\r\n- ANEMOMETRIC POLE IDENT &apos;46922&apos;\r\nPSN COORD (WGS-84) 405729N 170322E\r\nHGT AGL 32M)",
      sourceType="M", icaoId="LIBB", endDate="PERM", startDate="07/04/2025 0925")
assert r["pos"] == "psn" and abs(r["lat"] - 40.95806) < 1e-3 and abs(r["lon"] - 17.05611) < 1e-3 and "'46922'" in r["e"], r
# 26 LTA
r = P(" ", traditionalMessage="Areas of Non-Visibility", sourceType="LTA", keyword="LTA", icaoId="PHOG", facilityDesignator="OGG", notamNumber="LTA-OGG-14",
      mapPointer="POINT(-156.4305 20.8986)", startDate="10/21/2024 1200", endDate="10/20/2026 1200", comment="https://notams.aim.faa.gov/lta/main/viewlta?lookupid=3481728")
assert r["id"] == "LTA-OGG-14" and r["url"].startswith("https://notams.aim.faa.gov/lta/") and r["c"] == "2026-10-20T12:00:00Z" and r["lat"] == 20.8986, r
# 27 domáci bez mapPointer a bez letiska v OurAirports → kruh z textu
r = P(" ", traditionalMessage="!BOS 07/491 BOS AIRSPACE UAS WI AN AREA DEFINED AS .5NM RADIUS OF 421722N0712148W (9.5NM NW OWD) SFC-400FT AGL 2607211529-2701212359",
      sourceType="D", keyword="AIRSPACE", icaoId="KBOS", notamNumber="07/491", startDate="07/21/2026 1529", endDate="01/21/2027 2359")
assert r["pos"] == "psn" and r["r"] == 0.5 and abs(r["lat"] - 42.28944) < 1e-3, r
# 28 ICAO preklad bez medzery za Q) a A) s 3-písmenovým kódom
r = P("10/022 NOTAMN \r\nQ)KZKC//IV/BO/AE/000/999/3721N09320W025 \r\nA) SGF \r\nB) 2610091400 \r\nC) 2610092030 \r\nE) VORTAC U/S",
      traditionalMessage="!SGF 10/022 SGF NAV VORTAC U/S 2610091400-2610092030", sourceType="D", keyword="NAV", icaoId="KSGF", notamNumber="10/022",
      startDate="10/09/2026 1400", endDate="10/09/2026 2030")
assert r["id"] == "SGF 10/022" and r["loc"] == "KSGF" and r["fir"] == "KZKC" and r["cat"] == "nav" and r["subj"] == "navigačné zariadenie" and r["pos"] == "q" and r["e"] == "NAV VORTAC U/S", r
print("parse OK: 28 prípadov")
# 29 posunuté polia Q (chýba prevádzka a účel)
r = P("A1500/26 NOTAMN\nQ) OIIX/QNXXX/AE/000/999///\nA) OIFM B) 2607010000 C) 2610302359\nE) NAV AIDS", icaoId="OIFM")
assert r["scope"] == "AE" and r["trf"] == "" and r["lo"] == 0 and r["hi"] == 999 and r["pos"] == "fir", r
# 30 súradnice so sekundami a oddelené medzerou
r = P("A0100/26 NOTAMN\nQ) FQBE/QWLPW/IV/NBO/W/000/012 255550S323435E\nA) FQMA B) 2607010000 C) 2610302359\nE) PJE", icaoId="FQMA")
assert r["trf"] == "IV" and r["purp"] == "NBO" and r["scope"] == "W" and r["hi"] == 12 and r["pos"] == "q" and abs(r["lat"] + 25.93056) < 1e-3 and abs(r["lon"] - 32.57639) < 1e-3, r
print("parse OK: 30 prípadov")
# 31 HTML v ICAO preklade
r = P("03/244 NOTAMN<BR> <B>Q) </B>KZBW/QOLAS/IV/M/E/000/004/4221N07100W005<BR> <B>A) </B>KBOS<BR> <B>B) </B>2603121246<BR> <B>C) </B>2610152359<BR>  <B>E) </B> TOWER LGT (ASR 1",
      traditionalMessage="!BOS 03/244 BOS OBST TOWER LGT (ASR 1261031) 421421.80N0705752.60W (7.7NM SSE BOS) 365.8FT (358.9FT AGL) U/S 2603121246-2610152359",
      sourceType="D", keyword="OBST", icaoId="KBOS", mapPointer="POINT(-71.0064238055556 42.3629650277778)", startDate="03/12/2026 1246", endDate="10/15/2026 2359")
assert r["q"] == "QOLAS" and r["fir"] == "KZBW" and r["pos"] == "psn" and r["subj"] == "svetlá prekážky" and abs(r["lat"] - 42.23939) < 1e-3, r
# 32 viac častí ICAO (END PART) a domáci FDC s časťami
r = P(" A4404/26 NOTAMN Q) ULLL/QMPXX/IV/BO/A/000/999/5948N03016E005 A) ULLI  PART 1 OF 2  B) 2607101000  C) 2610101000 EST  E) ACFT STANDS COORD ESTABLISHED \nAPRON 1: 703 594755.97N 0301742.32E END PART 1 OF 2\r\nA4404/26 NOTAMN Q) ULLL/QMPXX/IV/BO/A/000/999/5948N03016E005 A) ULLI  PART 2 OF 2  B) 2607101000  C) 2610101000 EST  E) 706 594756.49N 0301735.08E \n(AIP PAGE AD 2.1 ULLI-44). END PART 2 OF 2\r\n")
assert r["id"] == "A4404/26" and r["loc"] == "ULLI" and "ACFT STANDS" in r["e"] and "AD 2.1 ULLI-44" in r["e"] and "NOTAMN" not in r["e"] and r["est"], r
r = P(" ", traditionalMessage="!FDC 6/7644 IAD PART 1 OF 2 ODP WASHINGTON DULLES INTL, WASHINGTON, DC. TEMPORARY CRANE 480FT MSL 1.08NM NORTH OF 2608250216-2703160312EST END PART 1 OF 2\r\n!FDC 6/7644 IAD PART 2 OF 2 RWY 1C (2024-AEA-2889-NRA). ALL OTHER DATA REMAINS AS PUBLISHED. 2608250216-2703160312EST END PART 2 OF 2\r\n",
      sourceType="F", keyword="ODP", icaoId="KIAD", mapPointer="POINT(-77.4599444444444 38.9474444444444)", startDate="08/25/2026 0216", endDate="03/16/2027 0312EST")
assert r["e"].startswith("ODP WASHINGTON") and "RWY 1C" in r["e"] and "PART" not in r["e"] and "2608250216" not in r["e"] and r["cat"] == "procedure", r
# 33 kontrolný zoznam s opakovanou hlavičkou
assert P(" K0001/24 NOTAMR K0474/23\nQ) EGXX/QKKKK/K /K  /K /000/999/5218N01451W999\nA) EGPX EGTT EGGX PART 1 OF 2\nB) 2401010005 C) 2402010005 EST\nE) CHECKLIST\nYEAR=2023 0354\nK0001/24 NOTAMR K0474/23\nQ) EGXX/QKKKK/K /K  /K /000/999/5218N01451W999\nA) EGPX EGTT EGGX PART 2 OF 2\nB) 2401010005 C) 2402010005 EST\nE)\nAIC CHECKLIST") is None
print("parse OK: 34 prípadov")
