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
