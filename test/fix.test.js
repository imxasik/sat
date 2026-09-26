const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDvorakProduct, parseStormReference, normaliseAgency, AGENCY_CATALOG } = require('../fix.js');

test('parses all reported subjective agencies and preserves the published values', () => {
    const product = `WDPN31 PGTW 260300
AGENCY DVORAK AND AUTOMATED FIXES:
   PGTW: T4.0 - 65 KTS
   DEMS: T2.0 - 30 KTS
   RJTD: T3.5 - 55 KTS
   KNES: T3.0 - 45 KTS
   RCTP: T3.5 - 55 KTS
   CIMSS SATCON: 56 KTS AT 260010Z
   CIMSS ADT: 47 KTS AT 260010Z

FORECASTER ASSESSMENT OF CURRENT ENVIRONMENT: FAVORABLE`;

    const parsed = parseDvorakProduct(product);
    assert.deepEqual(parsed.agencies.map(fix => fix.agency), ['PGTW', 'DEMS', 'RJTD', 'KNES', 'RCTP']);
    assert.deepEqual(parsed.agencies[1], {
        agency: 'DEMS', source_agency: null, t_number: 'T2.0', knots: 30, time: null, raw: 'T2.0 - 30 KTS'
    });
    assert.equal(parsed.automated.length, 2);
    assert.equal(parsed.automated[0].time, '260010Z');
});

test('maps NRL storm identifiers only to supported JTWC product families', () => {
    assert.equal(
        parseStormReference(new URLSearchParams('storm_id=wp2520262026092600&storm_name=Surigae')).product,
        'wp2526prog.txt'
    );
    assert.equal(
        parseStormReference(new URLSearchParams('storm_id=io012026&storm_name=One')).product,
        'io0126prog.txt'
    );
    assert.equal(
        parseStormReference(new URLSearchParams('storm_id=sp032026&storm_name=Three')).product,
        'sh0326prog.txt'
    );
    assert.equal(
        parseStormReference(new URLSearchParams('storm_id=al062026&storm_name=Six')).product,
        ''
    );
});

test('does not treat automated guidance as a subjective agency Dvorak fix', () => {
    const parsed = parseDvorakProduct(`AGENCY DVORAK AND AUTOMATED FIXES:
  CIMSS ADT: 53 KTS AT 231800Z
  CIMSS D-PRINT: 47 KTS AT 231800Z

FORECASTER ASSESSMENT OF CURRENT ENVIRONMENT: FAVORABLE`);
    assert.deepEqual(parsed.agencies, []);
    assert.equal(parsed.automated.length, 2);
});


test('normalises official reporting aliases into the requested agency cards', () => {
    assert.equal(normaliseAgency('KNHC'), 'NHC');
    assert.equal(normaliseAgency('RPHI'), 'PAGASA');
    assert.equal(normaliseAgency('BABJ'), 'CMA');
    assert.equal(normaliseAgency('RKSL'), 'KMA');
    assert.equal(normaliseAgency('FMEE'), 'MFR');
    assert.equal(normaliseAgency('ABRF'), 'BOM');
    assert.deepEqual(AGENCY_CATALOG.map(agency => agency.id), [
        'PGTW', 'DEMS', 'RJTD', 'KNES', 'NHC', 'PAGASA', 'RCTP', 'CMA', 'KMA', 'MFR', 'BOM'
    ]);
});

test('tries every official host before falling back to read-only mirrors of the same file', () => {
    const { buildSourceCandidates } = require('../fix.js');
    const candidates = buildSourceCandidates('wp2526prog.txt');
    const official = candidates.filter(item => item.kind === 'official');
    const mirrors = candidates.filter(item => item.kind === 'mirror');
    assert.ok(official.length >= 4);
    assert.ok(mirrors.length >= 3);
    assert.ok(official.every(item => item.url.endsWith('/products/wp2526prog.txt')));
    assert.ok(mirrors.every(item => item.official === official[0].url));
    assert.equal(official[0].url, 'https://www.metoc.navy.mil/jtwc/products/wp2526prog.txt');
});

test('accepts a mirrored copy of the official product and rejects error pages', () => {
    const { sanitiseMirrorText, looksLikeJtwcProduct, parseDvorakProduct } = require('../fix.js');
    const mirrored = `Title: \nURL Source: https://www.metoc.navy.mil/jtwc/products/wp2526prog.txt\nPublished Time: Sat, 26 Sep 2026 09:06:13 GMT\n\nMarkdown Content:\nWDPN31 PGTW 260900\nSUBJ/PROGNOSTIC REASONING FOR TYPHOON 25W (SURIGAE) WARNING NR 013//\nAGENCY DVORAK AND AUTOMATED FIXES:\n   PGTW: T4.0 - 65 KTS\n   RJTD: T3.0 - 45 KTS\n   CIMSS ADT: 51 KTS AT 260540Z\n\nFORECASTER ASSESSMENT OF CURRENT ENVIRONMENT: FAVORABLE`;
    const clean = sanitiseMirrorText(mirrored);
    assert.ok(looksLikeJtwcProduct(clean));
    assert.deepEqual(parseDvorakProduct(clean).agencies.map(fix => fix.agency), ['PGTW', 'RJTD']);
    assert.equal(looksLikeJtwcProduct('<html><body>522 Connection timed out</body></html>'), false);
    assert.equal(looksLikeJtwcProduct('{"error":"A valid API key is required."}'), false);
});

test('reads NHC-basin subjective fixes from the official forecast discussion', () => {
    const { parseNhcDiscussion, parseStormReference } = require('../fix.js');
    assert.equal(parseStormReference(new URLSearchParams('storm_id=al062026')).nhcId, 'al062026');
    const parsed = parseNhcDiscussion(
        'Subjective Dvorak satellite intensity estimates from TAFB and SAB were T2.5/35 kt and T2.0/30 kt, respectively. ' +
        'The initial intensity is held at 35 kt.'
    );
    assert.deepEqual(parsed.agencies.map(fix => [fix.agency, fix.t_number, fix.knots]), [
        ['TAFB', 'T2.5', 35],
        ['KNES', 'T2.0', 30]
    ]);
});

test('parses the slash layout some products use for agency values', () => {
    const { parseDvorakProduct } = require('../fix.js');
    const parsed = parseDvorakProduct(`AGENCY DVORAK AND AUTOMATED FIXES:
   PGTW: 4.0/4.0 65KTS 260600Z
   KNES: T3.5/3.5 55KTS AT 260600Z

ANALYSIS CONFIDENCE:`);
    assert.deepEqual(parsed.agencies.map(fix => [fix.agency, fix.t_number, fix.knots, fix.time]), [
        ['PGTW', 'T4.0', 65, '260600Z'],
        ['KNES', 'T3.5', 55, '260600Z']
    ]);
});

test('parses CWA and KMA values from their own official analysis layouts', () => {
    const { parseCwaAnalysis, parseKmaAnalysis, parseStormReference } = require('../fix.js');
    const reference = parseStormReference(new URLSearchParams('storm_id=wp252026&storm_name=Surigae&basin=WP'));
    const cwa = parseCwaAnalysis(`
        SEVERE TROPICAL STORM SURIGAE
        Analysis 0600UTC 26 September 2026
        Minimum Pressure 980 hPa
        Maximum Wind Speed 30 m/s
    `, reference);
    assert.deepEqual([cwa.agency, cwa.wind_ms, cwa.pressure_hpa, cwa.analysis_kind], ['RCTP', 30, 980, 'official_analysis']);

    const kma = parseKmaAnalysis(`No.26 SURIGAE KMA Issued at KST: Sat, 26 Sep 2026, 16:00
        Sat, 26 Sep 2026, 06:00 Analysis 2 27 97 985 22.9 127.0 N 14`, reference);
    assert.deepEqual([kma.agency, kma.wind_ms, kma.wind_kmh, kma.pressure_hpa], ['KMA', 27, 97, 985]);
    assert.match(kma.source, /weather\.go\.kr/);
});

test('only accepts an IMD Dvorak FT when the official bulletin identifies the storm', () => {
    const { parseDemsBulletin, parseStormReference } = require('../fix.js');
    const reference = parseStormReference(new URLSearchParams('storm_id=io022026&storm_name=Asani&basin=NI&lat=16.3&lon=89.4'));
    const matching = parseDemsBulletin(`TCIN50 DEMS 230600 SATELLITE FIX BULLETIN
        CYCLONIC STORM ASANI CENTERED AT 16.3N / 89.4E. DT = PT = MET. HENCE FT = 2.5.`, reference,
        'https://rsmcnewdelhi.imd.gov.in/uploads/archive/73/73_e76271_splbltn.pdf');
    assert.deepEqual([matching.agency, matching.t_number, matching.source_kind], ['DEMS', 'T2.5', 'official_text_render']);
    assert.equal(parseDemsBulletin('TCIN50 DEMS 230600 HENCE FT = 4.0.', reference, 'https://example.test/x.pdf'), null);
});

test('agency catalog records separate official publishers rather than a single JTWC source', () => {
    const { AGENCY_CATALOG } = require('../fix.js');
    const byId = Object.fromEntries(AGENCY_CATALOG.map(item => [item.id, item]));
    assert.match(byId.DEMS.source_url, /rsmcnewdelhi\.imd\.gov\.in/);
    assert.match(byId.RCTP.source_url, /cwa\.gov\.tw/);
    assert.match(byId.KMA.source_url, /weather\.go\.kr/);
    assert.match(byId.CMA.source_url, /typhoon\.nmc\.cn/);
    assert.notEqual(byId.DEMS.source_url, byId.PGTW.source_url);
});

test('collects CIMSS objective ADT, AiDT, SATCON, ARCHER and structure fields separately', () => {
    const { parseCimssSummary, parseStormReference, cimssStormReference } = require('../fix.js');
    const reference = parseStormReference(new URLSearchParams('storm_id=wp252026&storm_name=Surigae&basin=WP'));
    assert.deepEqual(cimssStormReference(reference), { id: '25W', year: '2026' });
    const products = parseCimssSummary(`
        Tropical Cyclone 25W (Surigae) Latest Real-Time CIMSS Product Summary
        Current Intensity Estimates ADT
        Date Time Vmax MSLP
        26Sep2026 1210UTC 51 kts 993 hPa
        Scene CI# FT# AdjT# RawT# Eye T Cloud T
        CRVBND 3.3 3.3 3.6 3.6 -2.96C -65.09C
        AiDT-V2 Date Time Vmax 26Sep2026 1210UTC 55 kts
        DPRINT Date Time Vmax MSLP 26Sep2026 1210UTC 69 kts 978 hPa
        Vmax 25% Vmax 75% 62 kts 76 kts
        SATCON Date Time Vmax MSLP 26Sep2026 1020UTC 56 kts 990 hPa
        Consensus Members 2 (ADT+Sounders)
        RI Forecast AI-RI Date Time Current Vmax Current MPI 26Sep2026 0600UTC 70 kts 132 kts
        20kt/12h 32.9% 25kt/24h 49.1%
        Position Estimates ARCHER Date Time Latitude Longitude 26Sep2026 0839UTC 23.12N 126.96E
        Satellite Sensor Eye Diameter Eye Cert % SSMIS-17 89-92GHz 0.60 deg 97.3%
        TC Structure MPERC Date Time Prob. ERC onset Full Model Prob. ERC onset V-based 26Sep2026 0800UTC 0% 5%
        Shear Analysis Date Time Shear Magnitude Shear Direction 26Sep2026 1200UTC 2 kts 86 deg
    `, { id: '25W', year: '2026' }, 'https://tropic.ssec.wisc.edu/real-time/summary/summary.25W_2026.html');
    const byId = Object.fromEntries(products.map(product => [product.id, product]));
    assert.deepEqual(byId.ADT.metrics.filter(item => ['Vmax', 'Final T#', 'Raw T#'].includes(item.label)).map(item => item.value), ['51 kt', '3.3', '3.6']);
    assert.equal(byId.AIDT.metrics.find(item => item.label === 'Vmax').value, '55 kt');
    assert.equal(byId.SATCON.metrics.find(item => item.label === 'Members').value, '2 (ADT+Sounders)');
    assert.equal(byId.ARCHER.metrics.find(item => item.label === 'Eye certainty').value, '97.3%');
    assert.equal(byId.SHEAR.metrics.find(item => item.label === 'Magnitude').value, '2 kt');
});

test('enriches CIMSS ADT and SATCON cards only with published detail fields', () => {
    const { parseCimssAdtDetail, parseCimssSatconDetail } = require('../fix.js');
    const adt = parseCimssAdtDetail(`Lat: 23:07N Lon: 126:58E
CI# /Pressure/ Vmax
3.5 / 990mb / 55kt
Final T# Adj T# Raw T#
3.5 3.7 3.6
Scene Type: CURVED BAND
Satellite Name: HIMAWARI-9
NE 80 50 20
SE 70 40 10`);
    assert.equal(adt.find(item => item.label === 'Vmax').value, '55 kt');
    assert.equal(adt.find(item => item.label === 'NE R34/R50/R64').value, '80/50/20 nm');
    const satcon = parseCimssSatconDetail(`SATCON: MSLP = 990 hPa MSW = 56 knots
SATCON Member Consensus: 55 knots
Pressure -> Wind Using SATCON MSLP: 57 knots
Distance to Outer Closed Isobar Used is 120 nm
Eye Size Correction Used is 3 knots
ADT: 992 hPa 52 knots
CIMSS AMSU: 989 hPa 58 knots`);
    assert.equal(satcon.find(item => item.label === 'Member consensus').value, '55 kt');
    assert.equal(satcon.find(item => item.label === 'Member ADT').value, 'ADT: 992 hPa 52 knots');
});
