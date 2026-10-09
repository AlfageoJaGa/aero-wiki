# AERO-wiki

Otvorená wiki a mapa leteckých informácií a voľne dostupných zdrojov z celého sveta:
- **letectvo:** METAR, TAF, SIGMET/AIRMET, NOTAM, rezervácie vzdušného priestoru, priestory, prekážky, letiská
  a rádionavigačné zariadenia, letecké mapy, zóny pre drony, zrážkový radar – všetko k zvolenému času platnosti,
- **knižnica:** 307 voľných online leteckých zdrojov sveta (AIP/eAIP všetkých štátov, NOTAM a briefing, letecká
  meteorológia, VAAC, mapy, zóny UAS, dátové služby a API, ADS-B) s hodinovou kontrolou dostupnosti,
- **podklady:** letecké ortofoto, satelitné mozaiky, aktuálne snímky, reliéf, podkladové mapy.

> **Len informatívne.** Letecké údaje nenahrádzajú predletovú prípravu ani oficiálne zdroje
> (AIP, NOTAM/PIB, letecké meteorologické informácie).

## Ovládanie

| záložka | obsah |
|---|---|
| **Letectvo** | čas platnosti (teraz, +1/3/6/12/24 h), AIRAC, **Správy vo výreze** (NOTAM, SIGMET, rezervácie, METAR, TAF platné v aktuálnom výreze; klik = detail na mape), letecké vrstvy v skupinách; predvolene len vrstvy pre aktuálny výrez |
| **Knižnica** | všetky zdroje podľa štátov; filtre: text, kategória, len štáty vo výreze, len voľne dostupné, skryť nedostupné; „Na mapu“ zapne mapové vrstvy zdroja |
| **Podklady** | Krajiny / Celý svet; filtre typu, licencie a stavu |
| **Na mape** | tri úrovne s poradím, priehľadnosťou, prelínaním a farbami; pozadie mimo pokrytia |

**Logika vrstiev**
- Poradie v mape je pevné po úrovniach: **letecké vektorové** (vždy navrchu) > letecké rastrové prekrytia >
  prekrytia (popisy, reliéf, tematické) > **podklad** > pozadie. Poradie sa mení len v rámci úrovne.
- **Podklad je vždy jeden** (prepínač ◉): ortofoto, satelit, podkladové mapy aj nepriehľadné letecké mapy
  (ICAO CH, FAA Sectional, VFR podklad SR) sa navzájom nahrádzajú.
- Regionálny podklad (napr. ortofoto SR) dostane automaticky globálne **pozadie** (Sentinel-2 cloudless), aby mapa
  mimo jeho pokrytia nebola prázdna; pozadie sa dá zmeniť alebo vypnúť v záložke Na mape.
- Prekrytia a letecké vrstvy sa pridávajú (☐).

**Klik do mapy – letecké informácie majú prednosť**
- Plošné letecké objekty (priestory, zóny UAS, NOTAM, SIGMET, rezervácie) nepreberajú klik; klik do mapy zobrazí
  naraz všetko, čo v bode platí: najprv NOTAM a rezervácie, zóny pre drony, vzdušné priestory s hranicami, počasie,
  potom NOTAM a SIGMET z hodinových údajov (aj keď vrstva nie je zapnutá) a **najbližšie letiská do 30 km** s METAR,
  TAF a NOTAM. Až potom (zbalené) vrstvy podkladov s pokrytím v bode.
- Bodové objekty (letiská, stanice METAR, navigačné zariadenia, prekážky) majú vlastný popup.

## Podklady (záložky Krajiny, Celý svet)

| značka | typ | príklady |
|---|---|---|
| štvorec, okrový | letecké ortofoto | ZBGIS Ortofotomozaika SR, ČÚZK, basemap.at, swisstopo, IGN, PNOA, PDOK, GSI, USGS |
| kruh, modrý | satelitná mozaika | Sentinel-2 cloudless 2016–2025 (EOX), Esri World Imagery, Blue Marble, scény imagico.de |
| krúžok, fialový | aktuálne snímky s časom | MODIS/VIIRS denne, HLS 30 m denne, MTG-I a MSG každých 10–15 min, GOES, Himawari |
| trojuholník, olivový | terén a reliéf | DMR 5.0 SR, DMR 5G ČR, swissALTI3D, RGE ALTI, ASTER GDEM, výpočet reliéfu a sklonu v prehliadači |
| kosoštvorec | tematické | GEBCO batymetria |
| pruh, sivý | podklad a popisy | OpenStreetMap, OpenTopoMap, popisy EOX, pobrežia NASA |

Stav k 8. 10. 2026: 759 vrstiev (podklady a letecké), 59 krajín, globálne vrstvy, 566 dostupných / 43 varovanie /
149 nedostupných (overené načítaním testovacej dlaždice v Chrome zo siete na Slovensku).

## Letectvo (záložka Letectvo)

| skupina | vrstva | zdroj | aktualizácia | platnosť k času |
|---|---|---|---|---|
| počasie | METAR, celý svet (≈ 5 300 staníc) | NOAA Aviation Weather Center | každú hodinu (zdroj každú minútu) | vek pozorovania, šedé ak > 2,5 h |
| | TAF, celý svet (≈ 3 100) | NOAA AWC | každú hodinu | len TAF platné vo zvolenom čase |
| | SIGMET (celý svet), SIGMET/AIRMET a G-AIRMET (USA) | NOAA AWC | každú hodinu | od–do |
| | zrážkový radar, celý svet (do z7) | RainViewer API | 10 min, živé | snímka najbližšia zvolenému času |
| NOTAM, rezervácie | **celý svet**: ≈ 430 FIR/ARTCC + ≈ 10 100 letísk s ICAO kódom (medzinárodné, domáce a FDC NOTAM USA, vojenské, LTA); priorita FIR LZBB, LKAA, LOVV, LHCC, EPWW + letiská SK, CZ, AT, HU, PL | FAA NOTAM Search | priorita každú hodinu, ostatné postupne (celý svet ≈ 4–5 h) | B) – C), PERM, UFN, EST |
| | **rezervácie priestorov SR (LARA)** | LPS SR, ArcGIS | živé, podľa výrezu | od – do |
| | výstrahy VFR Manual SR | LPS SR, ArcGIS | živé | od – do |
| | **NOTAM Španielsko s presnou geometriou** (plochy, body) | ENAIRE, ArcGIS | živé | B) – C) |
| AIP | letiská, dráhy, frekvencie, VOR/DME/NDB (celý svet) | OurAirports | denne | – |
| | **vzdušné priestory SR (274, atribúty AIXM)** | LPS SR, ArcGIS | živé | platnosť od – do |
| | priestory B–E, SUA, prekážky DOF (USA) | FAA ADDS, ArcGIS | živé | – |
| | priestory, prekážky, hlásne body | openAIP (voliteľné, kľúč) | každú hodinu | – |
| | letecké prekážky CH | BAZL | priebežne | – |
| mapy | VFR Manual SR – letecká vrstva (z7–z17) a podklad | LPS SR | aktuálny AIRAC | – |
| | open flightmaps VFR (21 regiónov) | open flightmaps | aktuálny AIRAC | AIRAC |
| | VFR Sectional, Terminal Area, IFR Enroute Low/High (USA) | FAA | 56/28 dní | – |
| | ICAO 1:500 000, plachtárska, CTR, TMA, Mil Airspace (CH) | BAZL / VBS | priebežne | – |
| drony | zóny UAS CH, DIPUL DE (aj dočasné), FR (Géoplateforme), SI (CAA), ES (ENAIRE + UAS NOTAM), USA (UAS Facility Maps, obmedzenia) | BAZL, DFS/BKG, DGAC/IGN, CAA SI, ENAIRE, FAA | priebežne | UAS NOTAM od – do |

Živé služby ArcGIS sa dotazujú priamo z prehliadača podľa výrezu (GeoJSON, CORS overený 8. 10. 2026); hodinová
kontrola overuje počet objektov a hlavičku CORS.

- **Čas platnosti:** teraz alebo o 1, 3, 6, 12, 24 h. Pri voľbe „teraz“ sa NOTAM, SIGMET a TAF
  prepočítajú každú minútu, takže vypršané položky zmiznú bez obnovenia stránky.
- **AIRAC:** aktuálny cyklus sa počíta v prehliadači aj v spracovaní (8. 10. 2026: 2610, platný od 1. 10., ďalší 29. 10.).
- **NOTAM:** poloha v poradí presnosti: súradnice v texte (PSN, `… NM RADIUS OF 431005N0902047W`, jediná poloha
  prekážky) → Q-riadok → bod letiska/zariadenia FAA → letisko z A) (OurAirports) → stred FIR (VATSpy) → medián
  ostatných NOTAM danej FIR. Detail uvádza, ktorá poloha bola použitá; približná (stred FIR) má prerušovaný okraj.
  Kruh podľa polomeru sa kreslí pre priestory, varovania, prekážky a traťové NOTAM; letiskové NOTAM ako značka.
  Kategórie (priestor, prekážky, varovania, navigácia, letiská, postupy) sa dajú vypnúť. Rozvrh D) sa zobrazí v detaile.
- **Celý svet na mape:** NOTAM sú v dlaždiciach 10°; husté oblasti (USA, Európa) sa delia na 5°, 2,5° a 1,25°,
  aby dlaždica mala najviac 1 500 správ. Pri oddialení alebo viac ako 6 000 správach vo výreze sa zobrazia
  **súčty (bubliny)**, klik na bublinu priblíži oblasť; po priblížení sa načítajú len dlaždice výrezu.
- **EST:** NOTAM s odhadovaným koncom, ktorý uplynul, ostáva zobrazený (FAA ho vedie ako aktívny; podľa ICAO
  ostáva v systéme, kým ho vydavateľ nezruší alebo nenahradí) s červeným upozornením „odhadovaný koniec uplynul“.
- **Vyradené:** nahradené a zrušené znenia („NOTAM REPLACED/CANCELLED BY“), NOTAMC, kontrolné zoznamy (QKKKK),
  prázdne a šablónové preklady FAA (`locationIndicatorICAO`).
- **Popup letiska** doplní METAR, TAF a NOTAM platné vo zvolenom čase.
- **Symboly:** METAR podľa letovej kategórie (VFR zelená, MVFR modrá, IFR červená, LIFR fialová),
  NOTAM podľa kategórie, SIGMET podľa javu (búrky, turbulencia, námraza, popol, cyklóna, horské vlny).

### Overenie leteckých zdrojov (8. 10. 2026)
- LPS SR (gis.lps.sk/server): služby Airspaces (274 priestorov), Reservation_(Public) (LARA), VFRM_dynamic, dlaždice
  VFRM_cache z7–z17 a VFRM_basemap – CORS a GeoJSON overené z prehliadača v SR.
- FAA: dlaždice VFR_Sectional z8–z12, VFR_Terminal z10–z12, IFR_AreaLow z7–z12, IFR_High z5–z9 (Denver);
  ADDS Feature služby (Class_Airspace, Special_Use_Airspace, Digital_Obstacle_File, UAS Facility Map) s CORS.
- ENAIRE: NOTAM plochy 1 060, body 522, UAS NOTAM 871; polia itemB/itemC v ms; GeoJSON s CORS.
- Géoplateforme: TRANSPORTS.DRONES.RESTRICTIONS, matica PM_3_15, dlaždice z3–z15.
- CAA SI: webová mapa „GEOGRAFSKA OBMOČJA UAS GEO ZONES – Maj 2026“ → 13 podvrstiev + CTR (ArcGIS Online).
- RainViewer: weather-maps.json s CORS, 13 snímok, dlaždice do z7.
- Bez CORS (len v knižnici): OpenSky, adsb.lol, airplanes.live, adsb.fi, FAA TFR API, AWC Data API.
- AWC: METAR/TAF/SIGMET/G-AIRMET overené živými požiadavkami (štruktúra CSV, XML, JSON) a parser otestovaný
  na skutočných vzorkách. CORS AWC nepovoľuje, preto údaje sťahuje hodinový beh, nie prehliadač.
- NOTAM: celý cyklus pre nastavenú oblasť odskúšaný živo: 333 platných lokalít, 53 neplatných
  kódov automaticky vyradených, 1 203 NOTAM, 62 požiadaviek, 62 s, 0 chýb rozboru Q-riadku.
- NOTAM celého sveta (9. 10. 2026, živé požiadavky na FAA NOTAM Search z prehliadača): náhodná vzorka 16 skupín
  po 25 kódoch (FIR, veľké, stredné, malé letiská) → priemerne 896 / 402 / 133 / 30 NOTAM na skupinu, 0–6 neplatných
  kódov v skupine, odozva 0,25–0,37 s. Odhad celého sveta ≈ 60 000 NOTAM a ≈ 2 500 požiadaviek na úplný cyklus.
  Tvar všetkých 641 stiahnutých záznamov (typy zdroja I, D, F, M, LTA) preverený; parser spustený na 32 skutočných
  záznamoch (každý tvar D, F, M, LTA raz – všetky rozložené) a na 34 testovacích prípadoch zo skutočných správ (obálky ORIGINAL NOTAM / RQR, Q-riadky bez súradníc, s vynechanými poľami a súradnicami so
  sekundami, `\r\r\n`, `C)…EST` bez medzery, HTML entity aj značky `<BR>`, viac častí (END PART aj zopakovaná
  hlavička), domáce NOTAM bez ICAO znenia, FDC s iným C) v ICAO preklade, LTA).
- OurAirports: 72 593 letísk a 11 008 navigačných zariadení, údaje v balíku sú z 8. 10. 2026.
- open flightmaps: dlaždice z7–z12 sú súradnicovo zhodné s OSM (kontrola na LZIB).
- BAZL, DIPUL: všetky použité vrstvy načítané v EPSG:3857.
- openAIP: API bez kľúča vracia 403; parsovanie je pripravené podľa štruktúry API, ale bez kľúča sa
  nedalo overiť.

### Zapnutie openAIP
Bezplatný účet na openaip.net → API kľúč → v repozitári Settings → Secrets and variables → Actions →
`OPENAIP_API_KEY`. Krajiny a typy sú v `sources/aero.json`. Licencia CC BY-NC 4.0.

### NOTAM celého sveta
Jediný bezplatný zdroj NOTAM pre celý svet podľa lokality je **FAA NOTAM Search** (medzinárodné NOTAM z
výmeny AFTN/USNS, domáce a FDC NOTAM USA, vojenské, LTA). Spracovanie (`build_notam` v `scripts/build_aero.py`):
1. **Zoznam lokalít:** FIR/ARTCC zo zoznamu VATSpy (≈ 430 štvorpísmenových kódov; obnova raz za 7 dní),
   kódy FIR naučené z Q-riadkov a poľa A) (napr. čínske ZBPE, ZSHA), letiská s ICAO kódom z OurAirports
   (veľké, stredné, malé). Neplatné kódy FAA odmietne (`Invalid location`) a vyradia sa na 30 dní.
2. **Priorita** (`notam.firs`, `notam.aerodrome_countries`, `notam.extra_locations`) sa sťahuje každý beh celá.
3. **Ostatné** sa sťahujú od najdlhšie neobnovených v rozpočte `notam.budget` (600 požiadaviek alebo 900 s,
   pauza 1 s); celý svet sa obnoví približne za 4–5 hodín. Úplne stiahnutá skupina nahradí svoje predchádzajúce
   NOTAM (zrušené zmiznú), ostatné ostávajú z predchádzajúcich behov s časom stiahnutia v detaile („Stiahnuté“).
4. **Stav** medzi behmi: `data/aero/notam_store.json.gz` (hodinový beh ho načíta z publikovanej stránky).
5. **Výstup:** `data/aero/notam/{stupne}_{x}_{y}.json` a `index.json` (počty, ťažiská dlaždíc, pokrytie:
   lokality obnovené do 1 h / 6 h / 24 h – zobrazuje sa v Stave zdrojov).

Rozšírenie priority: doplniť FIR (napr. `EDGG`) do `notam.firs`, krajiny (ISO) do `notam.aerodrome_countries`
alebo jednotlivé kódy do `notam.extra_locations`. Rýchlejšia obnova sveta: zvýšiť `notam.budget.max_requests`
(dĺžka behu rastie ≈ 1,3 s na požiadavku). Vypnutie sveta: `notam.world.enabled: false`.

Zoznam a stredy FIR: [VATSpy Data Project](https://github.com/vatsimnetwork/vatspy-data-project), licencia
CC BY-SA 4.0 (použité len kódy a polohy popisov FIR, nie hranice).

## Analýza zdroja aisview.rlp.cz (9. 10. 2026)

**AisView 3.9 (ŘLP ČR, Foxtrot) nemožno použiť ako mapovú vrstvu:**
1. Všetky letecké údaje (NOTAM, AUP, priestory, METAR) idú cez `POST getGJ.php` s parametrami `ct`, `iv`, `s` –
   požiadavka aj odpoveď sú šifrované (CryptoJS AES, formát OpenSSL so soľou). Kľúče `ds_*` (8 × 24 znakov) nie sú
   v žiadnom statickom súbore, vznikajú za behu a sú viazané na reláciu PHP (`SESSION_ID`).
2. Kód je obfuskovaný (javascript-obfuscator); neexistuje dokumentované API ani WMS/WFS.
3. Server neposiela hlavičku CORS → prehliadač z inej domény (GitHub Pages) odpoveď neprečíta.
4. Dlaždice `tiles/cz/brdr/` sú len hranica ČR a tiež bez CORS.
5. Podmienky užitia AisView (platné od 1. 3. 2026): obsah sa nesmie kopírovať, distribuovať, upravovať ani analyzovať.
Obchádzať šifrovanie by bolo porušením podmienok aj technickej ochrany – nerobí sa.

**Čo je pod AisView/DroneMap technicky dostupné (ŘLP ČR):**
| zdroj | obsah | technicky | podmienky |
|---|---|---|---|
| `aimgis.rlp.cz/server/rest/services` (ArcGIS 11.3) | ICAO 2026 (WMS), gridy UAS CTR/ATZ (11 022 + 58 263 buniek s AGL limitom), vnútorné zóny letísk, HOP A1/A2 a A3, vojenské objekty, ochranné pásma (železnice, cesty, energetika, vodné zdroje, CHÚ), vedenia pre HEMS | CORS áno, GeoJSON a WMS overené z inej domény | nezverejnené |
| `aim.rlp.cz/?p=uas-gz` | záväzné GeoJSON zemepisných zón LKR311–LKR320 (LKR320A = 238 leteckých priestorov), gridy, ED-318 | bez CORS (len cez hodinové spracovanie) | len osobná potreba; v iných produktoch len s písomným súhlasom ŘLP |
| `aim.rlp.cz/?p=aup-uup` | AUP/UUP ČR v XML (testovacia prevádzka), napr. TSA/TRA s výškami a časmi; mapovateľné na LKR320A (`TSA1` → `LKTSA1`) | bez CORS | rovnaké ako vyššie |

Technicky by sa dali v AERO-wiki zobraziť aktivované priestory ČR (AUP/UUP + LKR320A), zóny UAS a mapa ICAO,
podmienky ŘLP to však pre verejnú stránku bez písomného súhlasu nepovoľujú. Zdroje sú preto v knižnici ako odkazy;
mapové vrstvy sa doplnia po súhlase ŘLP (kontakt aim@ans.cz).

## Knižnica voľných leteckých zdrojov (záložka Knižnica)

`sources/aero_library.json` – 307 zdrojov, 227 štátov a území:

| kategória | počet | obsah |
|---|---|---|
| AIP / eAIP | 176 | všetky štáty podľa zoznamu ERAU (232 odkazov) + opravy: ES aip.enaire.es, UK NATS eAIP, DE aip.dfs.de (IFR, VFR, AIXM 5.1), BR AISWEB, CH/LI skybriefing; regionálne AIP (ASECNA, COCESNA, Roberts FIR, Východný Karibik, Pacifik) priradené ku každému členskému štátu |
| NOTAM, briefing | 20 | FAA NOTAM Search, FAA API, EAD Basic, EUROCONTROL NOP, autorouter, IBS ŘLP, Homebriefing, SOFIA, NATS PIB, AROWeb, CFPS, NAIPS, IFIS, AMC Croatia, NAT Tracks … |
| meteorológia | 39 | AWC, OGIMET, IEM, RainViewer, Blitzortung, EUMETView, SWPC, 9 × VAAC, NHC, JTWC, WMO SWIC, GVP, národné letecké meteo (IMGW, Météo-France, Met Office, AEMET, JMA, IMD, REDEMET, KMA …) |
| mapy | 10 | VFR Manual SR, AIS View ČR, SkyVector, open flightmaps, VFRMap, FAA, ENAIRE Insignia, map.geo.admin.ch … |
| drony | 35 | národné mapy zón UAS takmer všetkých štátov EASA + USA, CA, AU, NZ, DJI |
| dáta a API | 18 | ICAO API, openAIP, OurAirports, OpenAir (SoaringWeb), FAA NASR/DOF/CIFP/ADDS, ENAIRE ArcGIS, LPS ArcGIS, PDOK, NRL, WMM … |
| ADS-B | 8 | OpenSky, adsb.lol, airplanes.live, adsb.fi, ADS-B Exchange, Flightradar24, FlightAware, RadarBox |

Prístup: voľne / bezplatná registrácia / bezplatný kľúč API / spoplatnené / len kontakt / prihlásenie
(predvolene sa zobrazujú len prvé tri). Stav z prehliadača v SR (8. a 9. 10. 2026): 288 dostupných, 1 varovanie,
18 nedostupných (AIP AO, BD, CO, ET, FK, LT, PK, SG, LK, UY, YE; VAAC Buenos Aires a Darwin; AirShare NZ,
MetFlight NZ, Oran LT, TM-CAD MT, SAWS aviation ZA). Kontrola dostupnosti servera; stav HTTP doplní hodinový beh.
Zoznam „vo výreze“ používa rozsah štátov z polôh letísk (1.–99. percentil).

Doplnenie zdroja: záznam do `sources/aero_library.json` (`id, cc, ccs, cat, access, name, provider, url, note, layers`).

## Automatické spracovanie každú hodinu

`.github/workflows/hourly.yml` (hh:07 UTC):
1. načíta posledné letecké údaje, katalóg a knižnicu z webu (záloha pri výpadku zdroja, história),
2. `scripts/build_aero.py`: METAR, TAF, SIGMET, NOTAM, letiská, openAIP, AIRAC → `data/aero/`,
3. `scripts/build_catalog.py`: ELI + kurátorské zdroje, časy GIBS/EUMETSAT, test dlaždice každej vrstvy,
   dotaz na každú živú službu ArcGIS (počet objektov, CORS), RainViewer → `data/catalog.js`, `data/history.json`,
4. `scripts/build_library.py`: požiadavka na každý odkaz knižnice (2 pokusy), história 48 kontrol,
   rozsahy štátov → `data/library.js`,
5. nasadí stránku na GitHub Pages.

Prehliadač si katalóg, letecké údaje aj knižnicu obnoví sám každú hodinu; NOTAM, SIGMET, TAF, rezervácie a radar
prepočítava každú minútu.

## Nasadenie

1. Verejný repozitár na GitHube.
2. Settings → Pages → Source: **GitHub Actions** (pred nahratím, aby prvý beh mohol stránku nasadiť).
3. Nahrať obsah priečinka (aj skrytý priečinok `.github`) – web: *Add file → Upload files*, alebo `git push`.
   Nahratie do vetvy `main` spustí prvý beh; ručne: Actions → *Hodinová aktualizácia …* → **Run workflow**.
4. Stránka: `https://<používateľ>.github.io/<repozitár>/`.

Lokálne: `python -m http.server` v priečinku a otvoriť `http://localhost:8000/`.
Prepočet: `pip install -r requirements.txt && python scripts/build_aero.py && python scripts/build_catalog.py && python scripts/build_library.py`.

Repozitár obsahuje katalóg podkladov a knižnicu. Letecké údaje (`data/aero/`: letiská, METAR, TAF, SIGMET, NOTAM)
nie sú v repozitári – vytvorí ich každý hodinový beh `build_aero.py` (prvý beh po nahratí, ≈ 15–20 min).

## Obmedzenia

- FAA NOTAM Search je informatívny zdroj; nové NOTAM sa môžu objaviť s oneskorením. Oficiálny zdroj pre
  Slovensko je LPS SR (AIS), pre Európu EAD.
- Rozvrh NOTAM v poli D) (napr. `0900-SS`) sa nevyhodnocuje; NOTAM sa zobrazuje počas celého B)–C).
- NOTAM mimo priority môžu byť staré až niekoľko hodín (čas stiahnutia je v detaile). FAA NOTAM Search nemá
  zverejnené API ani podmienky pre automatizované dotazy; webová aplikácia posiela token reCAPTCHA, ktorý server
  zatiaľ nevyžaduje. Ak ho začne vyžadovať, beh zlyhá s hlásením „neodpovedá alebo blokuje“ a ostanú NOTAM z
  posledného úspešného behu. Oficiálna alternatíva: FAA NOTAM API (`external-api.faa.gov/notamapi/v1`,
  client_id a client_secret z portálu api.faa.gov) – kľúče len v Secrets, nie v prehliadači.
- Letiská bez ICAO kódu (napr. malé letiská USA s kódom FAA `1W1`) sa nedotazujú; ich NOTAM chýbajú.
- NOTAM bez súradníc v Q-riadku aj texte (vo vzorke 22 z 397 medzinárodných, t. j. ≈ 6 %; pri FIR ≈ 10 %,
  napr. Irán, Čína) majú len približnú polohu (stred FIR) – kruh pre ne nekreslíme.
- Súkromný repozitár: hodinový beh trvá ≈ 15–20 min, čo presiahne bezplatných 2 000 min/mesiac; pre súkromný
  repozitár znížiť `notam.budget.max_requests` (napr. 100) alebo vypnúť `notam.world.enabled`.
- Hodinová kontrola beží zo serverov GitHubu (USA); servery blokujúce zahraničné adresy sa môžu
  nesprávne označiť ako nedostupné.
- GitHub pozastaví plánované spúšťanie po 60 dňoch bez aktivity v repozitári.
- Licencie: DIPUL len nekomerčne; openAIP CC BY-NC; EOX Sentinel-2 cloudless 2018+ CC BY-NC-SA;
  Esri, EUMETSAT, OFMA majú vlastné podmienky. Podrobnosti pri každej vrstve.
- Priestory a prekážky ako vektorové údaje pre celý svet poskytuje bez poplatku len openAIP (s kľúčom);
  národne: SR (LPS), USA (FAA), ES (ENAIRE); inde ako rastrové mapy (open flightmaps, BAZL, DIPUL).
- Služby LPS SR, ENAIRE a CAA SI nemajú zverejnené podmienky použitia; zobrazujú sa s uvedením zdroja, len informatívne.
- RainViewer bezplatne poskytuje len posledné ~2 h a priblíženie do z7; pre budúci čas sa zobrazí posledná snímka.
- Živá prevádzka ADS-B nie je vrstvou: verejné API (OpenSky, adsb.lol, airplanes.live, adsb.fi) neposielajú CORS.

## Štruktúra

```
index.html, app.js, aero.js, library.js, style.css   klient (Leaflet 1.9.4)
data/catalog.js|json                    katalóg podkladov a stav vrstiev
data/library.js|json                    knižnica leteckých zdrojov a stav odkazov
sources/aero_library.json               zdroje knižnice
data/aero/                              letecké údaje (meta.json, metar, taf, sigmet, notam/, notam_store, ad/…)
sources/extra.json                      kurátorské zdroje a licencie
sources/aero.json                       priorita a rozpočet NOTAM sveta, dlaždice, openAIP
scripts/build_catalog.py                kontrola podkladov
scripts/build_aero.py                   letecké údaje
scripts/build_library.py                kontrola knižnice
tests/test_notam_parse.py               34 prípadov rozboru NOTAM zo skutočných správ (python tests/test_notam_parse.py)
.github/workflows/hourly.yml            plán a nasadenie
```
