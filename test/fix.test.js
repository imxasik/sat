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
