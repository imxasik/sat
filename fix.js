#!/usr/bin/env node
/**
 * Local development server and independent official-agency analysis proxy.
 *
 * Run with: node fix.js
 * The browser calls /fix.php, matching the production PHP endpoint.  This
 * server deliberately exposes only static files in this folder and the one
 * read-only multi-agency analysis endpoint.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_TTL_MS = 4 * 60 * 1000;
// A successful official table is kept much longer than the live cache so a
// temporary network/geo-block on the official host can never blank the panel.
// Anything served from it is flagged as "last published", never re-estimated.
const LAST_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
const LAST_GOOD_DIR = require('os').tmpdir();
const cache = new Map();
const JTWC_HOSTS = [
    'https://www.metoc.navy.mil/jtwc',
    'https://www.metoc.dc3n.navy.mil/jtwc',
    'http://www.metoc.navy.mil/jtwc',
    'http://www.metoc.dc3n.navy.mil/jtwc'
];
// Public read-only text mirrors. They are used only after every official host
// has failed, and only to retrieve the very same official product file.
const MIRROR_TEMPLATES = [
    'https://r.jina.ai/{url}',
    'https://api.allorigins.win/raw?url={enc}',
    'https://api.codetabs.com/v1/proxy?quest={enc}',
    'https://thingproxy.freeboard.io/fetch/{url}',
    'https://corsproxy.garmeeh.workers.dev/?url={enc}'
];
const NHC_CURRENT_STORMS = [
    'https://www.nhc.noaa.gov/CurrentStorms.json',
    'https://r.jina.ai/https://www.nhc.noaa.gov/CurrentStorms.json'
];
// Every card has its own official publisher. Values from the JTWC table are
// deliberately restricted to PGTW; a JTWC citation is never used to fill another
// centre's card.
const AGENCY_CATALOG = [
    { id: 'PGTW', label: 'JTWC', source_label: 'JTWC prognostic reasoning', source_url: 'https://www.metoc.navy.mil/jtwc/jtwc.html', analysis_kind: 'dvorak', basins: ['WP', 'NI', 'IO', 'SI', 'SP', 'SH'] },
    { id: 'DEMS', label: 'India Meteorological Department', source_label: 'IMD satellite / satellite-fix bulletin', source_url: 'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=MjI%3D&menu_id=Mg%3D%3D', analysis_kind: 'dvorak', basins: ['NI', 'IO'] },
    { id: 'RJTD', label: 'Japan Meteorological Agency', source_label: 'JMA / TCAC Tokyo advisory', source_url: 'https://www.data.jma.go.jp/tca/data/index.html', analysis_kind: 'official_analysis', basins: ['WP'] },
    { id: 'KNES', label: 'NOAA Satellite Analysis Branch', source_label: 'NOAA OSPO tropical products', source_url: 'https://ospo.noaa.gov/products/ocean/tropical/tdpositions.html', analysis_kind: 'dvorak', basins: ['GLOBAL'] },
    { id: 'NHC', label: 'U.S. National Hurricane Center', source_label: 'NHC forecast discussion / TAFB analysis', source_url: 'https://www.nhc.noaa.gov/', analysis_kind: 'dvorak', basins: ['AL', 'EP', 'CP'] },
    { id: 'PAGASA', label: 'PAGASA', source_label: 'PAGASA tropical cyclone bulletin', source_url: 'https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin', analysis_kind: 'official_analysis', basins: ['WP'] },
    { id: 'RCTP', label: 'Taiwan CWA', source_label: 'CWA typhoon analysis and forecast', source_url: 'https://www.cwa.gov.tw/V8/E/P/Typhoon/TY_NEWS.html', analysis_kind: 'official_analysis', basins: ['WP'] },
    { id: 'CMA', label: 'China Meteorological Administration', source_label: 'CMA / NMC Typhoon Network', source_url: 'https://typhoon.nmc.cn/web.html', analysis_kind: 'official_analysis', basins: ['WP'] },
    { id: 'KMA', label: 'Korea Meteorological Administration', source_label: 'KMA typhoon analysis', source_url: 'https://www.weather.go.kr/neng/typhoon/typhoon-information.do', analysis_kind: 'official_analysis', basins: ['WP'] },
    { id: 'MFR', label: 'Météo-France La Réunion', source_label: 'RSMC La Réunion cyclone activity', source_url: 'https://meteofrance.re/fr/cyclone/activite-cyclonique-en-cours', analysis_kind: 'official_analysis', basins: ['SI', 'SH'] },
    { id: 'BOM', label: 'Australian Bureau of Meteorology', source_label: 'BoM tropical cyclone warnings', source_url: 'https://www.bom.gov.au/weather-and-climate/specialised-forecasts-and-observations/tropical-cyclone', analysis_kind: 'official_analysis', basins: ['SI', 'SP', 'SH'] }
];
const COMMON_AGENCIES = AGENCY_CATALOG.map(agency => agency.id);
const AGENCY_ALIASES = {
    KNHC: 'NHC', NHC: 'NHC', TAFB: 'NHC', 'NHC/TAFB': 'NHC', 'KNHC/TAFB': 'NHC',
    PAGASA: 'PAGASA', RPHI: 'PAGASA',
    RCTP: 'RCTP', CWA: 'RCTP',
    CMA: 'CMA', BABJ: 'CMA',
    KMA: 'KMA', RKSL: 'KMA',
    MFR: 'MFR', FMEE: 'MFR',
    BOM: 'BOM', ABRF: 'BOM', APRF: 'BOM', AMMC: 'BOM'
};

function sendJSON(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(payload));
}

function normaliseText(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim();
}

function safeParam(value, maxLength = 80) {
    return String(value || '')
        .replace(/[\u0000-\u001f<>]/g, '')
        .trim()
        .slice(0, maxLength);
}

function parseStormReference(params) {
    const stormId = safeParam(params.get('storm_id')).toLowerCase();
    const basin = safeParam(params.get('basin')).toUpperCase();
    const stormName = safeParam(params.get('storm_name'));
    const latitude = Number(safeParam(params.get('lat'), 24));
    const longitude = Number(safeParam(params.get('lon'), 24));
    const explicitProduct = safeParam(params.get('product')).toLowerCase();
    let product = '';

    // An optional product value is intentionally constrained to a JTWC
    // prognostic-reasoning filename, so this endpoint cannot become an open proxy.
    if (/^(?:wp|io|sh)[0-9]{4}prog\.txt$/.test(explicitProduct)) {
        product = explicitProduct;
    }

    if (!product) {
        const match = stormId.match(/^([a-z]{2})(\d{2})(\d{4})/i);
        if (match) {
            const basinCode = match[1].toLowerCase();
            const number = match[2];
            const year = match[3].slice(-2);
            const productPrefix = {
                wp: 'wp', ni: 'io', io: 'io', si: 'sh', sp: 'sh', sh: 'sh'
            }[basinCode];
            if (productPrefix) product = `${productPrefix}${number}${year}prog.txt`;
        }
    }

    // NHC basins publish their subjective fixes in the forecast discussion.
    const nhcMatch = stormId.match(/^(al|ep|cp)(\d{2})(\d{4})/i);
    const nhcId = nhcMatch ? `${nhcMatch[1]}${nhcMatch[2]}${nhcMatch[3]}`.toLowerCase() : '';

    return {
        stormId, basin, stormName, product, nhcId,
        latitude: Number.isFinite(latitude) && Math.abs(latitude) <= 90 ? latitude : null,
        longitude: Number.isFinite(longitude) && Math.abs(longitude) <= 180 ? longitude : null
    };
}

function fetchText(url, redirects = 0, timeout = 12000) {
    return new Promise((resolve, reject) => {
        if (redirects > 3) {
            reject(new Error('Too many redirects from the official source.'));
            return;
        }
        const transport = url.startsWith('http://') ? http : https;
        const request = transport.get(url, {
            headers: {
                'Accept': 'text/plain,text/html;q=0.9,*/*;q=0.1',
                'User-Agent': 'SatelliteViewer-Dvorak/1.0 (+https://www.metoc.navy.mil/)'
            },
            timeout
        }, response => {
            const { statusCode = 502, headers } = response;
            if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                response.resume();
                const nextURL = new URL(headers.location, url).toString();
                fetchText(nextURL, redirects + 1, timeout).then(resolve, reject);
                return;
            }

            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                // JTWC text products are small. A hard ceiling avoids retaining an
                // unexpected response in memory.
                if (size > 800000) {
                    request.destroy(new Error('Official response exceeded the safety limit.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                status: statusCode,
                text: Buffer.concat(chunks).toString('utf8'),
                contentType: headers['content-type'] || ''
            }));
        });
        request.once('timeout', () => request.destroy(new Error('The official source timed out.')));
        request.once('error', reject);
    });
}

function normaliseAgency(agency) {
    const canonical = String(agency || '').replace(/\s+/g, ' ').trim().toUpperCase();
    return AGENCY_ALIASES[canonical] || canonical;
}

function parseDvorakProduct(text) {
    const clean = String(text || '').replace(/\r/g, '');
    const start = clean.search(/AGENCY\s+DVORAK(?:\s+AND\s+AUTOMATED)?\s+FIXES\s*:/i);
    if (start === -1) return { agencies: [], automated: [], issued: '' };

    const afterHeading = clean.slice(start);
    const endMatch = afterHeading.search(/\n\s*(?:FORECASTER\s+ASSESSMENT|ANALYSIS\s+CONFIDENCE|3\.\s*FORECAST|INITIAL\s+WIND\s+RADII)\b/i);
    const block = endMatch === -1 ? afterHeading : afterHeading.slice(0, endMatch);
    const agencies = [];
    const automated = [];
    const seen = new Set();

    block.split('\n').forEach(line => {
        const match = line.match(/^\s*([A-Z][A-Z0-9 .\-/]{1,34}):\s*(.+?)\s*$/i);
        if (!match) return;
        const sourceAgency = match[1].replace(/\s+/g, ' ').trim().toUpperCase();
        const raw = match[2].replace(/\s+/g, ' ').trim();
        const isAutomated = /^(?:CIMSS|SATCON|ADT|AIDT|AIDTC|D-MINT|D-PRINT|DMINT|DPRINT|AIDTM)/.test(sourceAgency);
        const agency = isAutomated ? sourceAgency : normaliseAgency(sourceAgency);
        if (!agency || seen.has(agency)) return;
        seen.add(agency);

        const tMatch = raw.match(/\bT\s*(\d(?:\.\d)?)/i) || raw.match(/^\s*(\d\.\d)\s*\//);
        const windMatch = raw.match(/\b(\d{1,3})\s*KTS?\b/i) || raw.match(/\/\s*(\d{1,3})\s*(?:KT|KTS)?\b/i);
        const timeMatch = raw.match(/\bAT\s+(\d{4,6}Z)\b/i) || raw.match(/\b(\d{6}Z)\b/);
        const fix = {
            agency,
            source_agency: sourceAgency !== agency ? sourceAgency : null,
            t_number: tMatch ? `T${tMatch[1]}` : null,
            knots: windMatch ? Number(windMatch[1]) : null,
            time: timeMatch ? timeMatch[1].toUpperCase() : null,
            raw
        };

        if (isAutomated) {
            automated.push(fix);
        } else {
            agencies.push(fix);
        }
    });

    const issued = (clean.match(/\b(\d{2}\/\d{4}Z)\b/) || [])[1] || '';
    return { agencies, automated, issued };
}

function buildUnavailable(reference, message, status = 'not_available', attempts = []) {
    return {
        status,
        message,
        storm_id: reference.stormId,
        storm_name: reference.stormName,
        product_id: reference.product ? reference.product.replace('prog.txt', '').toUpperCase() : null,
        agencies: [],
        automated: [],
        source: null,
        source_kind: null,
        freshness: 'unavailable',
        stale: false,
        issued: null,
        fetched_at: new Date().toISOString(),
        attempts,
        cimss: null,
        agency_statuses: AGENCY_CATALOG.map(agency => agencyStatus(agency.id, 'not_checked', 'No agency source was checked for this request.')),
        common_agencies: COMMON_AGENCIES,
        agency_catalog: AGENCY_CATALOG
    };
}

// ---------------------------------------------------------------------------
// Source resolution: official hosts first, then read-only public mirrors of the
// exact same official file. Everything returned is still the published text.
// ---------------------------------------------------------------------------
function buildSourceCandidates(product) {
    const officialURLs = JTWC_HOSTS.map(host => `${host}/products/${product}`);
    const candidates = officialURLs.map(url => ({ url, official: url, kind: 'official' }));
    const primary = officialURLs[0];
    MIRROR_TEMPLATES.forEach(template => {
        candidates.push({
            url: template.replace('{url}', primary).replace('{enc}', encodeURIComponent(primary)),
            official: primary,
            kind: 'mirror'
        });
    });
    return candidates;
}

// Text mirrors may wrap the product in a small header or a markdown fence.
function sanitiseMirrorText(text) {
    let clean = String(text || '').replace(/\r/g, '');
    const marker = clean.indexOf('Markdown Content:');
    if (marker !== -1) clean = clean.slice(marker + 'Markdown Content:'.length);
    clean = clean.replace(/^\s*(?:Title|URL Source|Published Time|Warning):.*$/gim, '');
    clean = clean.replace(/^\s*```[a-z]*\s*$/gim, '');
    return clean.trim();
}

function looksLikeJtwcProduct(text) {
    const probe = String(text || '').toUpperCase();
    if (probe.length < 80 || probe.length > 800000) return false;
    if (/<HTML|<!DOCTYPE HTML|CLOUDFLARE|ACCESS DENIED|API KEY IS REQUIRED/.test(probe)) return false;
    return /AGENCY\s+DVORAK/.test(probe) || (/PGTW/.test(probe) && /PROGNOSTIC\s+REASONING/.test(probe));
}

async function fetchOfficialProduct(product) {
    const attempts = [];
    for (const candidate of buildSourceCandidates(product)) {
        try {
            const response = await fetchText(candidate.url, 0, candidate.kind === 'official' ? 12000 : 20000);
            if (response.status !== 200) {
                attempts.push({ url: candidate.url, kind: candidate.kind, result: `http_${response.status}` });
                continue;
            }
            const text = candidate.kind === 'mirror' ? sanitiseMirrorText(response.text) : response.text;
            if (!looksLikeJtwcProduct(text)) {
                attempts.push({ url: candidate.url, kind: candidate.kind, result: 'unrecognised_content' });
                continue;
            }
            attempts.push({ url: candidate.url, kind: candidate.kind, result: 'ok' });
            return { text, source: candidate.official, sourceKind: candidate.kind, attempts };
        } catch (error) {
            attempts.push({ url: candidate.url, kind: candidate.kind, result: 'error', detail: String(error && error.message || error).slice(0, 120) });
        }
    }
    return { text: '', source: null, sourceKind: null, attempts };
}

// ---------------------------------------------------------------------------
// NHC basins (AL / EP / CP) do not appear in JTWC reasoning. Their subjective
// Dvorak numbers are published in the official forecast discussion instead.
// ---------------------------------------------------------------------------
const NHC_AGENCY_TOKENS = { TAFB: 'TAFB', SAB: 'KNES', KNES: 'KNES', NHC: 'NHC', AFWA: 'AFWA' };

function parseNhcDiscussion(text) {
    const clean = String(text || '').replace(/\r/g, '').replace(/<[^>]+>/g, ' ');
    const agencies = [];
    const automated = [];
    const seen = new Set();

    clean.split(/(?<=\.)\s+/).forEach(sentence => {
        if (!/dvorak|satellite intensity|subjective/i.test(sentence)) return;
        const pattern = /\bT?(\d(?:\.\d)?)\s*\/\s*(\d{2,3})\s*kt\b/gi;
        const estimates = [];
        let match;
        while ((match = pattern.exec(sentence)) !== null) {
            estimates.push({ t: Number(match[1]).toFixed(1), knots: Number(match[2]), raw: match[0].trim() });
        }
        if (!estimates.length) return;
        const tokens = (sentence.toUpperCase().match(/\b(TAFB|SAB|KNES|AFWA)\b/g) || []);
        tokens.forEach((token, index) => {
            const estimate = estimates[index] || (estimates.length === 1 ? estimates[0] : null);
            if (!estimate) return;
            const agency = NHC_AGENCY_TOKENS[token] || token;
            if (seen.has(agency)) return;
            seen.add(agency);
            agencies.push({
                agency,
                source_agency: agency === token ? null : token,
                t_number: `T${estimate.t}`,
                knots: estimate.knots,
                time: null,
                raw: `${estimate.raw} (${token})`
            });
        });
    });

    const issued = (clean.match(/\b(\d{3,4}\s*(?:AM|PM)\s+[A-Z]{2,4})\b/) || [])[1] || '';
    return { agencies, automated, issued };
}

async function fetchNhcFixes(reference) {
    const attempts = [];
    let storms = null;
    for (const url of NHC_CURRENT_STORMS) {
        try {
            const response = await fetchText(url, 0, 15000);
            if (response.status !== 200) {
                attempts.push({ url, kind: 'official', result: `http_${response.status}` });
                continue;
            }
            const body = url.includes('r.jina.ai') ? sanitiseMirrorText(response.text) : response.text;
            const jsonStart = body.indexOf('{');
            storms = JSON.parse(body.slice(jsonStart === -1 ? 0 : jsonStart));
            attempts.push({ url, kind: 'official', result: 'ok' });
            break;
        } catch (error) {
            attempts.push({ url, kind: 'official', result: 'error', detail: String(error && error.message || error).slice(0, 120) });
        }
    }
    if (!storms || !Array.isArray(storms.activeStorms)) return { parsed: null, source: null, attempts };

    const wanted = reference.stormId.slice(0, 8).toLowerCase();
    const storm = storms.activeStorms.find(item => String(item.id || '').toLowerCase() === wanted)
        || storms.activeStorms.find(item => reference.stormName
            && String(item.name || '').toUpperCase() === reference.stormName.toUpperCase());
    const discussionURL = storm && storm.forecastDiscussion && storm.forecastDiscussion.url;
    if (!discussionURL) return { parsed: null, source: null, attempts };

    for (const url of [discussionURL, `https://r.jina.ai/${discussionURL}`]) {
        try {
            const response = await fetchText(url, 0, 15000);
            if (response.status !== 200) {
                attempts.push({ url, kind: url.includes('r.jina.ai') ? 'mirror' : 'official', result: `http_${response.status}` });
                continue;
            }
            const parsed = parseNhcDiscussion(response.text);
            attempts.push({ url, kind: url.includes('r.jina.ai') ? 'mirror' : 'official', result: parsed.agencies.length ? 'ok' : 'no_table' });
            if (parsed.agencies.length) return { parsed, source: discussionURL, attempts };
        } catch (error) {
            attempts.push({ url, kind: 'official', result: 'error', detail: String(error && error.message || error).slice(0, 120) });
        }
    }
    return { parsed: null, source: null, attempts };
}

// ---------------------------------------------------------------------------
// Independent agency adapters
// ---------------------------------------------------------------------------
// These adapters read the publishers' own pages/bulletins.  They intentionally
// do not look at a JTWC product, nor do they translate an agency name found in
// it into an agency value.  Some centres publish an operational analysis rather
// than a public Dvorak T-number; those values are preserved in the units printed
// by the publisher and marked `official_analysis`.
const OFFICIAL_AGENCY_URLS = {
    DEMS_ARCHIVE: 'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=MjI%3D&menu_id=Mg%3D%3D',
    DEMS_SPECIAL_ARCHIVE: 'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=NzM%3D&menu_id=OQ%3D%3D',
    JMA_TCAC: 'https://www.data.jma.go.jp/tca/data/index.html',
    PAGASA: 'https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin',
    CWA: 'https://www.cwa.gov.tw/V8/E/P/Typhoon/TY_NEWS.html',
    CMA: 'https://typhoon.nmc.cn/web.html',
    KMA: 'https://www.weather.go.kr/neng/typhoon/typhoon-information.do',
    MFR: 'https://meteofrance.re/fr/cyclone/activite-cyclonique-en-cours',
    BOM: 'https://www.bom.gov.au/weather-and-climate/specialised-forecasts-and-observations/tropical-cyclone'
};

function agencyCatalogItem(id) {
    return AGENCY_CATALOG.find(item => item.id === id) || { id, label: id, source_label: id, source_url: null, analysis_kind: 'official_analysis', basins: [] };
}

function basinForReference(reference) {
    const raw = normaliseText(reference.basin).split(' ')[0];
    const fromParameter = { B: 'NI', AS: 'NI', ARABIAN: 'NI', BOB: 'NI' }[raw] || raw;
    if (['AL', 'EP', 'CP', 'WP', 'NI', 'IO', 'SI', 'SP', 'SH'].includes(fromParameter)) return fromParameter;
    const prefix = String(reference.stormId || '').slice(0, 2).toUpperCase();
    return { AL: 'AL', EP: 'EP', CP: 'CP', WP: 'WP', NI: 'NI', IO: 'IO', SI: 'SI', SP: 'SP', SH: 'SH' }[prefix] || '';
}

function canAgencyCover(agency, reference) {
    const basin = basinForReference(reference);
    return agency.basins.includes('GLOBAL') || agency.basins.includes(basin);
}

function decodeEntities(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&deg;/gi, '°')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function plainOfficialText(value) {
    return decodeEntities(String(value || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function meaningfulStormName(reference) {
    const name = normaliseText(reference.stormName);
    if (!name || /^(?:INVEST|UNKNOWN|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)$/.test(name)) return '';
    return name;
}

function textNamesStorm(text, reference) {
    const name = meaningfulStormName(reference);
    if (!name) return false;
    const normalized = normaliseText(text);
    // A multiword official storm name must occur as a complete normalized phrase.
    return normalized.includes(name);
}

function coordinateNearReference(text, reference, threshold = 4) {
    if (!Number.isFinite(reference.latitude) || !Number.isFinite(reference.longitude)) return false;
    const pairs = String(text || '').matchAll(/(\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])\s*\/?\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])/gi);
    for (const item of pairs) {
        const lat = Number(item[1]) * (item[2].toUpperCase() === 'S' ? -1 : 1);
        const lon = Number(item[3]) * (item[4].toUpperCase() === 'W' ? -1 : 1);
        const lonDifference = Math.min(Math.abs(lon - reference.longitude), 360 - Math.abs(lon - reference.longitude));
        if (Math.abs(lat - reference.latitude) <= threshold && lonDifference <= threshold) return true;
    }
    return false;
}

function officialFix(agency, fields = {}) {
    const info = agencyCatalogItem(agency);
    return {
        agency,
        source_agency: fields.source_agency || null,
        t_number: fields.t_number || null,
        knots: Number.isFinite(fields.knots) ? fields.knots : null,
        wind_ms: Number.isFinite(fields.wind_ms) ? fields.wind_ms : null,
        wind_kmh: Number.isFinite(fields.wind_kmh) ? fields.wind_kmh : null,
        intensity_label: fields.intensity_label || null,
        pressure_hpa: Number.isFinite(fields.pressure_hpa) ? fields.pressure_hpa : null,
        time: fields.time || null,
        raw: String(fields.raw || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        source: fields.source || info.source_url || null,
        source_kind: fields.source_kind || 'official',
        source_label: fields.source_label || info.source_label,
        analysis_kind: fields.analysis_kind || info.analysis_kind || 'official_analysis'
    };
}

function agencyStatus(agency, status, message, source) {
    const info = agencyCatalogItem(agency);
    return {
        agency,
        status,
        message,
        source: source || info.source_url || null,
        source_label: info.source_label,
        analysis_kind: info.analysis_kind
    };
}

async function fetchOfficialPage(url, timeout = 12000) {
    const response = await fetchText(url, 0, timeout);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    if (!response.text || response.text.length < 20) throw new Error('The official page was empty.');
    return response.text;
}

function parseCwaAnalysis(text, reference, source = OFFICIAL_AGENCY_URLS.CWA) {
    const clean = plainOfficialText(text);
    if (!textNamesStorm(clean, reference)) return null;
    const wind = clean.match(/(?:Analysis[\s\S]{0,700}?|Current Western[\s\S]{0,700}?)(?:Maximum Wind Speed|Max sustained winds near center)\s*(\d{1,3})\s*(?:meter|m)\s*(?:per\s*second|\/s(?:ec(?:ond)?)?)/i);
    const pressure = clean.match(/(?:Analysis[\s\S]{0,700}?)(?:Minimum Pressure|Minimum pressure)\s*(\d{3,4})\s*hPa/i);
    const time = clean.match(/Analysis\s+(\d{4})\s*UTC\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
    if (!wind && !pressure) return null;
    return officialFix('RCTP', {
        wind_ms: wind ? Number(wind[1]) : null,
        pressure_hpa: pressure ? Number(pressure[1]) : null,
        time: time ? `${time[1]}Z ${time[2]}` : null,
        raw: wind ? wind[0] : pressure[0],
        source
    });
}

function parseKmaAnalysis(text, reference, source = OFFICIAL_AGENCY_URLS.KMA) {
    const clean = plainOfficialText(text);
    if (!textNamesStorm(clean, reference)) return null;
    // KMA's first `Analysis` row is current analysis. The columns after it are
    // intensity code, m/s, km/h, pressure, latitude and longitude.
    const analysis = clean.match(/([A-Z][a-z]{2},\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4},\s*\d{2}:\d{2})\s+Analysis\s+(?:[A-Z]|\d+)\s+(\d{1,3})\s+(\d{1,3})\s+(\d{3,4})\s+(\d{1,2}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)/);
    if (!analysis) return null;
    return officialFix('KMA', {
        wind_ms: Number(analysis[2]),
        wind_kmh: Number(analysis[3]),
        pressure_hpa: Number(analysis[4]),
        time: analysis[1],
        raw: analysis[0],
        source
    });
}

function parsePagasaAnalysis(text, reference, source = OFFICIAL_AGENCY_URLS.PAGASA) {
    const clean = plainOfficialText(text);
    // PAGASA may use a Philippine local name. We only accept a value when the
    // selected storm name itself is printed; never guess a local-name mapping.
    if (!textNamesStorm(clean, reference)) return null;
    const wind = clean.match(/Maximum sustained winds of\s*(\d{1,3})\s*km\/h/i);
    const issued = clean.match(/Issued at\s+([^|]{5,80}?\d{4})/i);
    if (!wind) return null;
    return officialFix('PAGASA', {
        wind_kmh: Number(wind[1]),
        time: issued ? issued[1].trim() : null,
        raw: wind[0],
        source
    });
}

function parseCmaAnalysis(text, reference, source = OFFICIAL_AGENCY_URLS.CMA) {
    const clean = plainOfficialText(text);
    if (!textNamesStorm(clean, reference)) return null;
    const force = clean.match(/(?:中心附近)?最大风力\s*(\d{1,2})\s*级/i) || clean.match(/maximum\s+(?:wind\s+)?force\s*(\d{1,2})/i);
    const position = clean.match(/(?:北纬|Latitude\s*:?\s*)(\d{1,2}(?:\.\d+)?)\s*(?:度|N)?[，,\s]+(?:东经|Longitude\s*:?\s*)(\d{1,3}(?:\.\d+)?)/i);
    if (!force && !position) return null;
    return officialFix('CMA', {
        intensity_label: force ? `Force ${force[1]}` : 'Current analysis',
        raw: force ? force[0] : position[0],
        source
    });
}

function parseDemsBulletin(text, reference, source) {
    const clean = plainOfficialText(text);
    const tMatch = clean.match(/(?:\bFT\b|FINAL\s*T(?:ROPICAL)?\s*(?:NUMBER|NO\.?)?)\s*(?:=|:|IS)?\s*(\d(?:\.\d)?)/i);
    if (!tMatch) return null;
    // A bulletin may cover the whole Indian Ocean. Require the agency's storm
    // name or a position close to the selected NRL storm before using its FT.
    if (!textNamesStorm(clean, reference) && !coordinateNearReference(clean, reference)) return null;
    const ms = clean.match(/(?:MAX(?:IMUM)?\s+SUSTAINED\s+WINDS?|MSW)\D{0,35}(\d{1,3})\s*(KTS?|KT|KM\/?H|M\/?S)/i);
    const issued = clean.match(/TCIN\d+\s+DEMS\s+(\d{6})/i) || clean.match(/Date:\s*\d{4}-\d{2}-\d{2}\s+Time:\s*(\d{2}:\d{2})/i);
    const unit = ms ? ms[2].toUpperCase() : '';
    return officialFix('DEMS', {
        t_number: `T${tMatch[1]}`,
        knots: ms && /^KT/.test(unit) ? Number(ms[1]) : null,
        wind_kmh: ms && /KM/.test(unit) ? Number(ms[1]) : null,
        wind_ms: ms && /M\/?S/.test(unit) ? Number(ms[1]) : null,
        time: issued ? issued[1].toUpperCase().replace(':', '') + (issued[1].includes(':') ? 'Z' : 'Z') : null,
        raw: clean.slice(Math.max(0, tMatch.index - 130), tMatch.index + 180),
        source,
        source_kind: 'official_text_render',
        analysis_kind: 'dvorak'
    });
}

function parseJmaTcaXml(xml, reference, source) {
    const clean = plainOfficialText(xml);
    if (!textNamesStorm(clean, reference)) return null;
    const valueForTag = pattern => {
        const match = String(xml).match(new RegExp(`<[^>]*${pattern}[^>]*>\\s*([^<]+)`, 'i'));
        return match ? Number(String(match[1]).trim()) : null;
    };
    const wind = valueForTag('(?:surfaceWindSpeed|maximumWindSpeed|maxWindSpeed|windSpeed)');
    const pressure = valueForTag('(?:centralPressure|pressure)');
    const time = (String(xml).match(/<[^>]*(?:issueTime|timePosition)[^>]*>\s*([^<]+)/i) || [])[1] || null;
    if (!Number.isFinite(wind) && !Number.isFinite(pressure)) return null;
    const knotUnit = /(?:surfaceWindSpeed|maximumWindSpeed|maxWindSpeed|windSpeed)[^>]+(?:kn|kt|knot)/i.test(String(xml));
    return officialFix('RJTD', {
        knots: Number.isFinite(wind) && knotUnit ? wind : null,
        wind_ms: Number.isFinite(wind) && !knotUnit ? wind : null,
        pressure_hpa: Number.isFinite(pressure) ? pressure : null,
        time,
        raw: 'JMA TCAC Tokyo tropical cyclone advisory',
        source
    });
}

function parseNamedWindAnalysis(text, reference, agency, source) {
    const clean = plainOfficialText(text);
    if (!textNamesStorm(clean, reference)) return null;
    const knots = clean.match(/(?:maximum sustained winds?|winds near the centre|vent maximum)\D{0,45}(\d{1,3})\s*(?:knots?|kt)\b/i);
    const kmh = clean.match(/(?:maximum sustained winds?|winds near the centre|vent maximum)\D{0,45}(\d{1,3})\s*km\/?h/i);
    if (!knots && !kmh) return null;
    return officialFix(agency, {
        knots: knots ? Number(knots[1]) : null,
        wind_kmh: kmh ? Number(kmh[1]) : null,
        raw: (knots || kmh)[0],
        source
    });
}

async function fetchDemsFix(reference) {
    const candidates = [];
    for (const indexURL of [OFFICIAL_AGENCY_URLS.DEMS_SPECIAL_ARCHIVE, OFFICIAL_AGENCY_URLS.DEMS_ARCHIVE]) {
        try {
            const listing = await fetchOfficialPage(indexURL, 13000);
            const found = [...listing.matchAll(/(?:https?:\/\/[^"'\s<>]+|\/?uploads\/[^"'\s<>]+)(?:satbltn|splbltn)\.pdf/gi)]
                .map(match => new URL(decodeEntities(match[0]), indexURL).toString());
            found.forEach(url => { if (!candidates.includes(url)) candidates.push(url); });
        } catch (error) { /* The regular archive may still work. */ }
    }
    for (const pdf of candidates.slice(0, 8)) {
        try {
            // IMD publishes PDF bulletins. r.jina.ai is used solely as a text
            // renderer; the provenance link returned to the browser remains the
            // original imd.gov.in PDF.
            const rendered = await fetchOfficialPage(`https://r.jina.ai/${pdf}`, 20000);
            const parsed = parseDemsBulletin(sanitiseMirrorText(rendered), reference, pdf);
            if (parsed) return { fix: parsed, status: agencyStatus('DEMS', 'ok', '', pdf) };
        } catch (error) { /* try the next official PDF */ }
    }
    return { fix: null, status: agencyStatus('DEMS', 'not_published', 'No matching IMD satellite-fix bulletin is currently published for this storm.') };
}

async function fetchSingleAgency(reference, agency, url, parser) {
    try {
        const page = await fetchOfficialPage(url);
        const fix = parser(page, reference, url);
        if (fix) return { fix, status: agencyStatus(agency, 'ok', '', url) };
        return { fix: null, status: agencyStatus(agency, 'not_published', 'The agency page has no matching current analysis for this storm.', url) };
    } catch (error) {
        return { fix: null, status: agencyStatus(agency, 'source_unavailable', 'The agency’s official page could not be reached right now.', url) };
    }
}

async function fetchJmaFix(reference) {
    try {
        const index = await fetchOfficialPage(OFFICIAL_AGENCY_URLS.JMA_TCAC);
        if (!textNamesStorm(plainOfficialText(index), reference)) {
            return { fix: null, status: agencyStatus('RJTD', 'not_published', 'JMA/TCAC Tokyo has no matching current advisory for this storm.') };
        }
        const xmlURLs = [...index.matchAll(/(?:href=["'])?([^"'\s<>]+\.xml)(?:["'])?/gi)]
            .map(match => new URL(decodeEntities(match[1]), OFFICIAL_AGENCY_URLS.JMA_TCAC).toString());
        for (const xmlURL of xmlURLs.slice(0, 6)) {
            const xml = await fetchOfficialPage(xmlURL);
            const fix = parseJmaTcaXml(xml, reference, xmlURL);
            if (fix) return { fix, status: agencyStatus('RJTD', 'ok', '', xmlURL) };
        }
        return { fix: null, status: agencyStatus('RJTD', 'not_published', 'JMA/TCAC Tokyo’s current advisory did not contain a readable analysis value.') };
    } catch (error) {
        return { fix: null, status: agencyStatus('RJTD', 'source_unavailable', 'The JMA/TCAC Tokyo official advisory could not be reached right now.') };
    }
}

async function fetchNhcAgencyFix(reference) {
    const result = await fetchNhcFixes(reference);
    if (!result.parsed) {
        return { fix: null, status: agencyStatus('NHC', 'not_published', 'NHC has no matching current subjective satellite analysis for this storm.', result.source) };
    }
    // TAFB is NHC’s tropical-analysis unit. Keep the original reporting unit in
    // source_agency but publish it on the NHC card rather than as a JTWC alias.
    const sourceFix = result.parsed.agencies.find(item => ['TAFB', 'NHC', 'KNES'].includes(item.agency));
    if (!sourceFix) return { fix: null, status: agencyStatus('NHC', 'not_published', 'NHC’s current discussion did not list a subjective satellite estimate.', result.source) };
    return {
        fix: officialFix('NHC', {
            ...sourceFix,
            source_agency: sourceFix.source_agency || sourceFix.agency,
            source: result.source,
            analysis_kind: 'dvorak'
        }),
        status: agencyStatus('NHC', 'ok', '', result.source)
    };
}

async function fetchIndependentAgencyFixes(reference) {
    const basin = basinForReference(reference);
    const jobs = [];
    if (['NI', 'IO'].includes(basin)) jobs.push(fetchDemsFix(reference));
    if (['WP'].includes(basin)) {
        jobs.push(fetchJmaFix(reference));
        jobs.push(fetchSingleAgency(reference, 'PAGASA', OFFICIAL_AGENCY_URLS.PAGASA, parsePagasaAnalysis));
        jobs.push(fetchSingleAgency(reference, 'RCTP', OFFICIAL_AGENCY_URLS.CWA, parseCwaAnalysis));
        jobs.push(fetchSingleAgency(reference, 'CMA', OFFICIAL_AGENCY_URLS.CMA, parseCmaAnalysis));
        jobs.push(fetchSingleAgency(reference, 'KMA', OFFICIAL_AGENCY_URLS.KMA, parseKmaAnalysis));
    }
    if (['AL', 'EP', 'CP'].includes(basin)) jobs.push(fetchNhcAgencyFix(reference));
    if (['SI', 'SH'].includes(basin)) jobs.push(fetchSingleAgency(reference, 'MFR', OFFICIAL_AGENCY_URLS.MFR, (text, ref, url) => parseNamedWindAnalysis(text, ref, 'MFR', url)));
    if (['SI', 'SP', 'SH'].includes(basin)) jobs.push(fetchSingleAgency(reference, 'BOM', OFFICIAL_AGENCY_URLS.BOM, (text, ref, url) => parseNamedWindAnalysis(text, ref, 'BOM', url)));

    const results = await Promise.all(jobs);
    const resultByAgency = new Map(results.map(item => [item.status.agency, item]));
    const statuses = AGENCY_CATALOG.map(agency => {
        if (agency.id === 'PGTW') return null;
        if (agency.id === 'KNES') {
            return agencyStatus('KNES', 'discontinued', 'NOAA OSPO retired manual SAB Dvorak estimates in September 2026; no replacement value is inferred.');
        }
        if (resultByAgency.has(agency.id)) return resultByAgency.get(agency.id).status;
        return canAgencyCover(agency, reference)
            ? agencyStatus(agency.id, 'not_checked', 'No independent source adapter is available for this storm yet.')
            : agencyStatus(agency.id, 'outside_responsibility', 'Outside this centre’s published tropical-cyclone responsibility area.');
    }).filter(Boolean);
    return { fixes: results.map(item => item.fix).filter(Boolean), statuses };
}

// ---------------------------------------------------------------------------
// UW-CIMSS objective satellite products
// ---------------------------------------------------------------------------
// CIMSS products are automated satellite guidance, not an agency's subjective
// Dvorak fix.  They are therefore returned in a separate payload and rendered
// in a separate panel so they cannot be mistaken for a human agency analysis.
const CIMSS_BASE = 'https://tropic.ssec.wisc.edu';

function cimssStormReference(reference) {
    const match = String(reference.stormId || '').match(/^([a-z]{2})(\d{2})(\d{4})/i);
    if (!match) return null;
    const originalBasin = normaliseText(reference.basin).split(' ')[0];
    const basin = basinForReference(reference);
    const suffix = {
        AL: 'L', EP: 'E', CP: 'C', WP: 'W', SI: 'S', SP: 'P', SH: 'S',
        NI: ['B', 'BOB'].includes(originalBasin) ? 'B' : 'A',
        IO: ['B', 'BOB'].includes(originalBasin) ? 'B' : 'A'
    }[basin];
    return suffix ? { id: `${match[2]}${suffix}`, year: match[3] } : null;
}

function cimssText(value) {
    return decodeEntities(String(value || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<(?:br|\/tr|\/p|\/h[1-6]|\/table)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim());
}

function cimssMetric(label, value) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    return clean ? { label, value: clean } : null;
}

function cimssProduct(id, label, source, observedAt, metrics, description = '') {
    return {
        id, label, source, observed_at: observedAt || null, description,
        metrics: metrics.filter(Boolean)
    };
}

function cimssSegment(text, startPattern, endPatterns) {
    const start = text.search(startPattern);
    if (start === -1) return '';
    const after = text.slice(start);
    let end = after.length;
    endPatterns.forEach(pattern => {
        const found = after.search(pattern);
        if (found > 0 && found < end) end = found;
    });
    return after.slice(0, end);
}

function cimssTimestamp(segment) {
    const match = String(segment).match(/(\d{1,2}[A-Za-z]{3}\d{4})\s+(\d{4})\s*UTC/i);
    return match ? `${match[1]} ${match[2]}UTC` : null;
}

function cimssVmaxMslp(segment) {
    const match = String(segment).match(/(?:\d{1,2}[A-Za-z]{3}\d{4}\s+\d{4}\s*UTC\s+)?(\d{1,3})\s*kts?\s+(\d{3,4}(?:\.\d+)?)\s*hPa/i);
    return {
        vmax: match ? `${match[1]} kt` : null,
        mslp: match ? `${match[2]} hPa` : null
    };
}

function parseCimssSummary(text, cimssReference, source) {
    const clean = cimssText(text);
    if (!new RegExp(`Tropical Cyclone\\s+${cimssReference.id}\\b`, 'i').test(clean)) return null;
    const id = cimssReference.id;
    const year = cimssReference.year;
    const sourceFor = {
        ADT: `${CIMSS_BASE}/real-time/adt/odt${id}.html`,
        AIDT: `${CIMSS_BASE}/real-time/adt/AiDT/${id}.AiDT.V2.html`,
        DPRINT: `${CIMSS_BASE}/real-time/DPRINT/${year}/${year}_${id}_history_IR.html`,
        DMINT: `${CIMSS_BASE}/real-time/DMINT/${year}/${year}_${id}_history_MWIR.html`,
        MWSOUNDERS: `${CIMSS_BASE}/real-time/atms/archive/${year}/${year}${id}.html`,
        SATCON: `${CIMSS_BASE}/real-time/satcon/${year}${id}.html`,
        AIRI: `${CIMSS_BASE}/real-time/ai-ri/#${encodeURIComponent(referenceNameFromCimss(clean) || id)}`,
        ARCHER: `${CIMSS_BASE}/real-time/arch-all/cyclones/${year}_${id}/web/summaryTable.html`,
        MPERC: `${CIMSS_BASE}/real-time/arch-all/cyclones/${year}_${id}/web/summaryTableERC.html`,
        SHEAR: `${CIMSS_BASE}/real-time/${cimssBasinDirectory(id)}/storm/shear/shear.${id}.txt`
    };
    const products = [];
    const adt = cimssSegment(clean, /\bADT\b/, [/\bAiDT-V?2?\b/i, /\bDPRINT\b/i]);
    if (adt) {
        const winds = cimssVmaxMslp(adt);
        const scene = adt.match(/Scene\s+CI#\s+FT#\s+AdjT#\s+RawT#\s+Eye T\s+Cloud T\s*\n?\s*([^\s]+)\s+(\d(?:\.\d+)?)\s+(\d(?:\.\d+)?)\s+(\d(?:\.\d+)?)\s+(\d(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?C)\s+(-?\d+(?:\.\d+)?C)/i);
        products.push(cimssProduct('ADT', 'ADT v9.1', sourceFor.ADT, cimssTimestamp(adt), [
            cimssMetric('Vmax', winds.vmax), cimssMetric('MSLP', winds.mslp),
            cimssMetric('Scene', scene && scene[1]), cimssMetric('CI#', scene && scene[2]),
            cimssMetric('Final T#', scene && scene[3]), cimssMetric('Adj T#', scene && scene[4]),
            cimssMetric('Raw T#', scene && scene[5]), cimssMetric('Eye T', scene && scene[6]),
            cimssMetric('Cloud T', scene && scene[7])
        ], 'Automated infrared Advanced Dvorak Technique'));
    }
    const aidt = cimssSegment(clean, /\bAiDT-V?2?\b/i, [/\bDPRINT\b/i, /\bDMINT\b/i]);
    if (aidt) {
        const value = aidt.match(/(\d{1,3})\s*kts?/i);
        products.push(cimssProduct('AIDT', 'AiDT v2', sourceFor.AIDT, cimssTimestamp(aidt), [cimssMetric('Vmax', value && `${value[1]} kt`)], 'AI-enhanced ADT wind estimate'));
    }
    const dprint = cimssSegment(clean, /\bDPRINT\b/i, [/\bDMINT\b/i, /\bMW Sounders\b/i]);
    if (dprint) {
        const winds = cimssVmaxMslp(dprint);
        const range = dprint.match(/Vmax\s*25%\s+Vmax\s*75%\s*\n?\s*(\d{1,3})\s*kts?\s+(\d{1,3})\s*kts?/i);
        products.push(cimssProduct('DPRINT', 'D-PRINT', sourceFor.DPRINT, cimssTimestamp(dprint), [
            cimssMetric('Vmax', winds.vmax), cimssMetric('MSLP', winds.mslp),
            cimssMetric('25th percentile', range && `${range[1]} kt`), cimssMetric('75th percentile', range && `${range[2]} kt`)
        ], 'Deep-learning infrared intensity estimate'));
    }
    const dmint = cimssSegment(clean, /\bDMINT\b/i, [/\bMW Sounders\b/i, /\bSATCON\b/i]);
    if (dmint) {
        const winds = cimssVmaxMslp(dmint);
        const info = dmint.match(/Vmax\s*25%\s+Vmax\s*75%\s+MW Instr\.\s*\n?\s*(\d{1,3})\s*kts?\s+(\d{1,3})\s*kts?\s+([A-Z0-9-]+)/i);
        products.push(cimssProduct('DMINT', 'D-MINT', sourceFor.DMINT, cimssTimestamp(dmint), [
            cimssMetric('Vmax', winds.vmax), cimssMetric('MSLP', winds.mslp),
            cimssMetric('25th percentile', info && `${info[1]} kt`), cimssMetric('75th percentile', info && `${info[2]} kt`), cimssMetric('MW instrument', info && info[3])
        ], 'Deep multi-sensor infrared/microwave intensity estimate'));
    }
    const sounders = cimssSegment(clean, /\bMW Sounders\b/i, [/\bSATCON\b/i, /\bRI Forecast\b/i]);
    if (sounders) {
        const winds = cimssVmaxMslp(sounders);
        const detail = sounders.match(/Satellite\s+FOV\s*\n?\s*(?:\S+\s+)?(\d+)\s+(\d+)/i);
        products.push(cimssProduct('MWSOUNDERS', 'Microwave Sounders', sourceFor.MWSOUNDERS, cimssTimestamp(sounders), [
            cimssMetric('Vmax', winds.vmax), cimssMetric('MSLP', winds.mslp), cimssMetric('Satellite', detail && detail[1]), cimssMetric('FOV', detail && detail[2])
        ], 'CIMSS microwave-sounding intensity estimate'));
    }
    const satcon = cimssSegment(clean, /\bSATCON\b/i, [/\bRI Forecast\b/i, /\bPosition Estimates\b/i]);
    if (satcon) {
        const winds = cimssVmaxMslp(satcon);
        const members = satcon.match(/Consensus Members\s*\n?\s*([^\n]+)/i);
        products.push(cimssProduct('SATCON', 'SATCON', sourceFor.SATCON, cimssTimestamp(satcon), [
            cimssMetric('Vmax', winds.vmax), cimssMetric('MSLP', winds.mslp), cimssMetric('Members', members && members[1])
        ], 'Satellite Consensus intensity estimate'));
    }
    const airi = cimssSegment(clean, /\bAI-RI\b/i, [/\bPosition Estimates\b/i, /\bTC Structure\b/i]);
    if (airi) {
        const current = airi.match(/(\d{1,3})\s*kts?\s+(\d{1,3})\s*kts?/i);
        const probabilityMatches = [...airi.matchAll(/(\d+kt\/\d+h)\s+([\d.]+%)/gi)];
        products.push(cimssProduct('AIRI', 'AI-RI', sourceFor.AIRI, cimssTimestamp(airi), [
            cimssMetric('Current Vmax', current && `${current[1]} kt`), cimssMetric('Current MPI', current && `${current[2]} kt`),
            ...probabilityMatches.map(item => cimssMetric(item[1], item[2]))
        ], 'AI rapid-intensification guidance'));
    }
    const archer = cimssSegment(clean, /\bARCHER\b/i, [/\bTC Structure\b/i, /\bM-PERC\b/i]);
    if (archer) {
        const location = archer.match(/(\d{1,2}(?:\.\d+)?[NS])\s+(\d{1,3}(?:\.\d+)?[EW])/i);
        const detail = archer.match(/Satellite\s+Sensor\s+Eye Diameter\s+Eye Cert\s*%\s*\n?\s*([^\s]+)\s+([^\s]+)\s+([\d.]+\s*deg)\s+([\d.]+%)/i);
        products.push(cimssProduct('ARCHER', 'ARCHER', sourceFor.ARCHER, cimssTimestamp(archer), [
            cimssMetric('Latitude', location && location[1]), cimssMetric('Longitude', location && location[2]),
            cimssMetric('Satellite', detail && detail[1]), cimssMetric('Sensor', detail && detail[2]),
            cimssMetric('Eye diameter', detail && detail[3]), cimssMetric('Eye certainty', detail && detail[4])
        ], 'Automated microwave/IR center-position retrieval'));
    }
    const mperc = cimssSegment(clean, /\b(?:MPERC|M-PERC)\b/i, [/\bMIMIC-TPW\b/i, /\bShear Analysis\b/i]);
    if (mperc) {
        const probabilities = mperc.match(/(\d+(?:\.\d+)?%)\s+(\d+(?:\.\d+)?%)/);
        products.push(cimssProduct('MPERC', 'M-PERC', sourceFor.MPERC, cimssTimestamp(mperc), [
            cimssMetric('ERC onset (full)', probabilities && probabilities[1]), cimssMetric('ERC onset (V-based)', probabilities && probabilities[2])
        ], 'Microwave probability of eyewall-replacement-cycle onset'));
    }
    const shear = cimssSegment(clean, /\bShear Analysis\b/i, [/\bTC-Scale AMVs\b/i]);
    if (shear) {
        const values = shear.match(/(\d+(?:\.\d+)?)\s*kts?\s+(\d+(?:\.\d+)?)\s*deg/i);
        products.push(cimssProduct('SHEAR', 'Vertical Shear', sourceFor.SHEAR, cimssTimestamp(shear), [
            cimssMetric('Magnitude', values && `${values[1]} kt`), cimssMetric('Direction', values && `${values[2]}°`)
        ], 'CIMSS AMV-aided deep-layer vertical wind shear'));
    }
    return products;
}

function referenceNameFromCimss(text) {
    const match = String(text).match(/Tropical Cyclone\s+\d{2}[A-Z]\s*\(([^)]+)\)/i);
    return match ? match[1].trim() : '';
}

function cimssBasinDirectory(id) {
    const letter = String(id).slice(-1).toUpperCase();
    return { L: 'atlantic', E: 'eastpac', C: 'eastpac', W: 'westpac', A: 'northindian', B: 'northindian', S: 'southindian', P: 'australia' }[letter] || 'westpac';
}

function mergeCimssProductMetrics(products, id, metrics) {
    const product = products.find(item => item.id === id);
    if (!product) return;
    metrics.filter(Boolean).forEach(metric => {
        if (!product.metrics.some(existing => existing.label === metric.label)) product.metrics.push(metric);
    });
}

function parseCimssAdtDetail(text) {
    const clean = cimssText(text);
    const position = clean.match(/Lat\s*:\s*([\d:]+\s*[NS])\s+Lon\s*:\s*([\d:]+\s*[EW])/i);
    const ci = clean.match(/CI#\s*\/Pressure\/ Vmax\s*\n?\s*(\d(?:\.\d+)?)\s*\/\s*([\d.]+)mb\s*\/\s*([\d.]+)kt/i);
    const tNumbers = clean.match(/Final T#\s+Adj T#\s+Raw T#\s*\n?\s*(\d(?:\.\d+)?)\s+(\d(?:\.\d+)?)\s+(\d(?:\.\d+)?)/i);
    const scene = clean.match(/Scene Type\s*:\s*([^\n]+)/i);
    const satellite = clean.match(/Satellite Name\s*:\s*([^\n]+)/i);
    const radii = [...clean.matchAll(/(?:NE|SE|SW|NW)\s*\n?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/gi)];
    return [
        cimssMetric('Latitude', position && position[1]), cimssMetric('Longitude', position && position[2]),
        cimssMetric('CI#', ci && ci[1]), cimssMetric('MSLP', ci && `${ci[2]} hPa`), cimssMetric('Vmax', ci && `${ci[3]} kt`),
        cimssMetric('Final T#', tNumbers && tNumbers[1]), cimssMetric('Adj T#', tNumbers && tNumbers[2]), cimssMetric('Raw T#', tNumbers && tNumbers[3]),
        cimssMetric('Scene detail', scene && scene[1]), cimssMetric('Satellite', satellite && satellite[1]),
        ...radii.flatMap((row, index) => ['NE', 'SE', 'SW', 'NW'].slice(index, index + 1).map(quadrant => cimssMetric(`${quadrant} R34/R50/R64`, `${row[1]}/${row[2]}/${row[3]} nm`)))
    ];
}

function parseCimssSatconDetail(text) {
    const clean = cimssText(text);
    const current = clean.match(/SATCON:\s*MSLP\s*=\s*([\d.]+)\s*hPa\s+MSW\s*=\s*([\d.]+)\s*knots/i);
    const consensus = clean.match(/SATCON Member Consensus:\s*([\d.]+)\s*knots/i);
    const pressureWind = clean.match(/Pressure\s*->\s*Wind Using SATCON MSLP:\s*([\d.]+)\s*knots/i);
    const outer = clean.match(/Distance to Outer Closed Isobar Used is\s*([\d.]+)\s*nm/i);
    const eye = clean.match(/Eye Size Correction Used is\s*([\d.]+)\s*knots/i);
    const memberLines = [...clean.matchAll(/(?:ADT|CIMSS AMSU|ATMS|SSMIS|CIRA ATMS):\s*([\d.]+)?\s*hPa\s*([\d.]+)?\s*knots[^\n]*/gi)];
    return [
        cimssMetric('MSLP', current && `${current[1]} hPa`), cimssMetric('Vmax', current && `${current[2]} kt`),
        cimssMetric('Member consensus', consensus && `${consensus[1]} kt`), cimssMetric('Pressure-wind', pressureWind && `${pressureWind[1]} kt`),
        cimssMetric('Outer closed isobar', outer && `${outer[1]} nm`), cimssMetric('Eye-size correction', eye && `${eye[1]} kt`),
        ...memberLines.map(item => cimssMetric(`Member ${item[0].split(':')[0]}`, item[0].replace(/\s+/g, ' ')))
    ];
}

async function fetchCimssProducts(reference) {
    const storm = cimssStormReference(reference);
    if (!storm) return { status: 'not_available', message: 'No CIMSS-compatible tropical-cyclone identifier can be formed for this storm.', source: CIMSS_BASE, products: [] };
    const summaryURL = `${CIMSS_BASE}/real-time/summary/summary.${storm.id}_${storm.year}.html`;
    try {
        const summary = await fetchOfficialPage(summaryURL, 16000);
        const products = parseCimssSummary(summary, storm, summaryURL);
        if (!products || !products.length) {
            return { status: 'not_published', message: 'CIMSS has no active product summary for this storm.', source: summaryURL, storm_id: storm.id, products: [] };
        }
        const [adtDetail, satconDetail] = await Promise.all([
            fetchOfficialPage(`${CIMSS_BASE}/real-time/adt/odt${storm.id}.html`, 16000).catch(() => ''),
            fetchOfficialPage(`${CIMSS_BASE}/real-time/satcon/${storm.year}${storm.id}.html`, 16000).catch(() => '')
        ]);
        if (adtDetail) mergeCimssProductMetrics(products, 'ADT', parseCimssAdtDetail(adtDetail));
        if (satconDetail) mergeCimssProductMetrics(products, 'SATCON', parseCimssSatconDetail(satconDetail));
        return {
            status: 'ok', message: '', source: summaryURL, storm_id: storm.id,
            fetched_at: new Date().toISOString(), products
        };
    } catch (error) {
        return { status: 'source_unavailable', message: 'The UW-CIMSS product summary could not be reached right now.', source: summaryURL, storm_id: storm.id, products: [] };
    }
}

// ---------------------------------------------------------------------------
// Last-published store (official values only, always labelled)
// ---------------------------------------------------------------------------
function lastGoodPath(reference) {
    const key = Buffer.from(`${reference.stormId}|${reference.product}`).toString('hex').slice(0, 48);
    return path.join(LAST_GOOD_DIR, `sat-dvorak-last-${key}.json`);
}

function saveLastGood(reference, payload) {
    try {
        fs.writeFileSync(lastGoodPath(reference), JSON.stringify({ savedAt: Date.now(), payload }));
    } catch (error) { /* a cache failure must never affect the response */ }
}

function readLastGood(reference) {
    try {
        const raw = JSON.parse(fs.readFileSync(lastGoodPath(reference), 'utf8'));
        if (!raw || !raw.payload || Date.now() - raw.savedAt > LAST_GOOD_TTL_MS) return null;
        return raw;
    } catch (error) {
        return null;
    }
}

function buildSuccess(reference, parsed, source, sourceKind) {
    return {
        status: 'ok',
        message: '',
        storm_id: reference.stormId,
        storm_name: reference.stormName,
        product_id: reference.product ? reference.product.replace('prog.txt', '').toUpperCase() : (reference.nhcId || '').toUpperCase() || null,
        agencies: parsed.agencies,
        automated: parsed.automated,
        source,
        source_kind: sourceKind,
        freshness: 'live',
        stale: false,
        issued: parsed.issued || null,
        fetched_at: new Date().toISOString(),
        cimss: null,
        agency_statuses: [],
        common_agencies: COMMON_AGENCIES,
        agency_catalog: AGENCY_CATALOG
    };
}

async function locateAndParse(reference) {
    const attempts = [];
    const agencyStatuses = [];
    const agencyFixes = [];
    const basin = basinForReference(reference);

    // Start independent publisher requests immediately. A slow JTWC failover
    // chain must not delay CWA, KMA, PAGASA, JMA, IMD, etc.
    const independentPromise = fetchIndependentAgencyFixes(reference);
    const cimssPromise = fetchCimssProducts(reference);

    // Only PGTW is read from a JTWC product. The published table can include
    // other agency names, but those rows are intentionally not copied into
    // their cards: each centre has to publish its own analysis below.
    if (reference.product) {
        const fetched = await fetchOfficialProduct(reference.product);
        attempts.push(...fetched.attempts);
        if (fetched.text) {
            const parsed = parseDvorakProduct(fetched.text);
            const pgtw = parsed.agencies.find(fix => fix.agency === 'PGTW');
            if (pgtw) {
                agencyFixes.push(officialFix('PGTW', {
                    ...pgtw,
                    source: fetched.source,
                    source_kind: fetched.sourceKind,
                    source_label: 'JTWC prognostic reasoning',
                    analysis_kind: 'dvorak'
                }));
                agencyStatuses.push(agencyStatus('PGTW', 'ok', '', fetched.source));
            } else {
                agencyStatuses.push(agencyStatus('PGTW', 'not_published', 'The current JTWC reasoning has no PGTW subjective Dvorak value.', fetched.source));
            }
        } else {
            agencyStatuses.push(agencyStatus('PGTW', 'source_unavailable', 'The current JTWC prognostic reasoning could not be reached.', null));
        }
    } else {
        agencyStatuses.push(agencyStatus('PGTW', 'outside_responsibility', 'JTWC has no prognostic-reasoning product for this basin.'));
    }

    const [independent, cimss] = await Promise.all([independentPromise, cimssPromise]);
    agencyFixes.push(...independent.fixes);
    agencyStatuses.push(...independent.statuses);

    const parsed = { agencies: agencyFixes, automated: [], issued: '' };
    if (agencyFixes.length) {
        const firstSource = agencyFixes[0].source || null;
        const payload = buildSuccess(reference, parsed, firstSource, agencyFixes[0].source_kind || 'official');
        payload.attempts = attempts;
        payload.agency_statuses = agencyStatuses;
        payload.cimss = cimss;
        payload.message = 'Each agency card is populated only from that agency’s own official publication. Operational-analysis values retain the agency’s published units.';
        saveLastGood(reference, payload);
        return payload;
    }

    const lastGood = readLastGood(reference);
    if (lastGood) {
        const ageMinutes = Math.round((Date.now() - lastGood.savedAt) / 60000);
        return {
            ...lastGood.payload,
            status: 'ok',
            freshness: 'last_published',
            stale: true,
            attempts,
            agency_statuses: agencyStatuses,
            cimss,
            retrieved_at: new Date(lastGood.savedAt).toISOString(),
            message: `Live agency sources are unreachable right now. Showing the last agency-published values (retrieved ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago); no value is estimated.`
        };
    }

    const payload = buildUnavailable(
        reference,
        basin ? 'No matching independent agency analysis is published for this storm right now. Values are never copied from JTWC into another agency card.' : 'No tropical-cyclone basin can be matched to this storm yet.',
        'not_available',
        attempts
    );
    payload.agency_statuses = agencyStatuses;
    payload.cimss = cimss;
    return payload;
}
async function dvorakService(searchParams) {
    const reference = parseStormReference(searchParams);
    const forceRefresh = searchParams.get('refresh') === '1';
    if (!reference.stormId && !reference.product) {
        return {
            statusCode: 400,
            payload: buildUnavailable(reference, 'A storm identifier is required.', 'invalid_request')
        };
    }
    const key = `${reference.stormId}|${reference.product}|${reference.stormName}`;
    const cached = cache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
        return { statusCode: 200, payload: { ...cached.payload, cache: 'hit' } };
    }
    const payload = await locateAndParse(reference);
    // Only a fresh live official table is cached, so a temporary outage never
    // sticks around for the whole cache window.
    if (payload.status === 'ok' && payload.freshness === 'live') {
        cache.set(key, { savedAt: Date.now(), payload });
    } else {
        cache.delete(key);
    }
    return { statusCode: 200, payload: { ...payload, cache: 'miss' } };
}

function contentType(filePath) {
    const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    };
    return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(ROOT, `.${requested}`);
    const relativePath = path.relative(ROOT, filePath);
    const hasHiddenPath = relativePath.split(path.sep).some(part => part.startsWith('.'));
    const isAllowedAsset = /\.(?:html|css|js|json|svg|png|jpe?g|webp|ico)$/i.test(filePath);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath) || hasHiddenPath || !isAllowedAsset) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }
    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType(filePath),
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
}

function createServer() {
    return http.createServer(async (req, res) => {
        const requestURL = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
            res.end();
            return;
        }
        if (req.method === 'GET' && (requestURL.pathname === '/fix.php' || requestURL.pathname === '/api/dvorak-fixes')) {
            try {
                const result = await dvorakService(requestURL.searchParams);
                sendJSON(res, result.statusCode, result.payload);
            } catch (error) {
                sendJSON(res, 502, {
                    status: 'source_unavailable',
                    message: 'The live official agency sources could not be reached right now. Please try again shortly.',
                    agencies: [],
                    automated: [],
                    source: null,
                    issued: null,
                    fetched_at: new Date().toISOString(),
                    common_agencies: COMMON_AGENCIES,
        agency_catalog: AGENCY_CATALOG
                });
            }
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Allow': 'GET, HEAD, OPTIONS', 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Method not allowed');
            return;
        }
        serveStatic(req, res, decodeURIComponent(requestURL.pathname));
    });
}

if (require.main === module) {
    createServer().listen(PORT, HOST, () => {
        console.log(`Satellite Viewer is running at http://${HOST}:${PORT}`);
        console.log('Agency analysis endpoint: /fix.php (independent official sources)');
    });
}

module.exports = {
    COMMON_AGENCIES,
    buildSourceCandidates,
    sanitiseMirrorText,
    looksLikeJtwcProduct,
    parseNhcDiscussion,
    parseCwaAnalysis,
    parseKmaAnalysis,
    parsePagasaAnalysis,
    parseCmaAnalysis,
    parseDemsBulletin,
    parseJmaTcaXml,
    parseCimssSummary,
    parseCimssAdtDetail,
    parseCimssSatconDetail,
    cimssStormReference,
    fetchCimssProducts,
    basinForReference,
    fetchIndependentAgencyFixes,
    AGENCY_CATALOG,
    normaliseAgency,
    parseStormReference,
    parseDvorakProduct,
    dvorakService,
    createServer
};
