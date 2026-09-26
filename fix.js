#!/usr/bin/env node
/**
 * Local development server and JTWC Dvorak-fix proxy.
 *
 * Run with: node fix.js
 * The browser calls /fix.php, matching the production PHP endpoint.  This
 * server deliberately exposes only static files in this folder and the one
 * read-only Dvorak endpoint.
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
const AGENCY_CATALOG = [
    { id: 'PGTW', label: 'JTWC' },
    { id: 'DEMS', label: 'DEMS' },
    { id: 'RJTD', label: 'Japan Meteorological Agency' },
    { id: 'KNES', label: 'NOAA Satellite Analysis Branch' },
    { id: 'NHC', label: 'U.S. National Hurricane Center' },
    { id: 'PAGASA', label: 'Philippines' },
    { id: 'RCTP', label: 'Taiwan CWA' },
    { id: 'CMA', label: 'China Meteorological Administration' },
    { id: 'KMA', label: 'Korea Meteorological Administration' },
    { id: 'MFR', label: 'Météo-France La Réunion' },
    { id: 'BOM', label: 'Australian Bureau of Meteorology' }
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

    return { stormId, basin, stormName, product, nhcId };
}

function fetchText(url, redirects = 0, timeout = 12000) {
    return new Promise((resolve, reject) => {
        if (redirects > 3) {
            reject(new Error('Too many redirects from the official JTWC source.'));
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
        request.once('timeout', () => request.destroy(new Error('The official JTWC source timed out.')));
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
        common_agencies: COMMON_AGENCIES,
        agency_catalog: AGENCY_CATALOG
    };
}

async function locateAndParse(reference) {
    const attempts = [];

    if (reference.product) {
        const fetched = await fetchOfficialProduct(reference.product);
        attempts.push(...fetched.attempts);
        if (fetched.text) {
            const parsed = parseDvorakProduct(fetched.text);
            if (parsed.agencies.length || parsed.automated.length) {
                const payload = buildSuccess(reference, parsed, fetched.source, fetched.sourceKind);
                payload.attempts = attempts;
                saveLastGood(reference, payload);
                return payload;
            }
            return buildUnavailable(
                reference,
                'JTWC has a current product for this storm, but its latest reasoning does not list an agency Dvorak-fix table.',
                'not_available',
                attempts
            );
        }
    }

    if (reference.nhcId) {
        const nhc = await fetchNhcFixes(reference);
        attempts.push(...nhc.attempts);
        if (nhc.parsed) {
            const payload = buildSuccess(reference, nhc.parsed, nhc.source, 'official');
            payload.attempts = attempts;
            saveLastGood(reference, payload);
            return payload;
        }
    }

    // Every live route failed. Rather than blanking the panel, re-serve the last
    // table that was officially published for this storm, clearly flagged.
    const lastGood = readLastGood(reference);
    if (lastGood) {
        const ageMinutes = Math.round((Date.now() - lastGood.savedAt) / 60000);
        return {
            ...lastGood.payload,
            status: 'ok',
            freshness: 'last_published',
            stale: true,
            attempts,
            retrieved_at: new Date(lastGood.savedAt).toISOString(),
            message: `Live official sources are unreachable right now. Showing the last officially published table (retrieved ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago); no value is estimated.`
        };
    }

    if (!reference.product && !reference.nhcId) {
        return buildUnavailable(
            reference,
            'No official prognostic-reasoning or discussion product can be matched to this storm yet. Agency values are never estimated or filled in.',
            'not_available',
            attempts
        );
    }
    return buildUnavailable(
        reference,
        'Every official source and mirror failed for this storm right now. Please refresh in a moment; no stale or inferred fix is shown.',
        'source_unavailable',
        attempts
    );
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
                    message: 'The live JTWC source could not be reached right now. Please try again shortly.',
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
        console.log('Dvorak endpoint: /fix.php (JTWC live proxy)');
    });
}

module.exports = {
    COMMON_AGENCIES,
    buildSourceCandidates,
    sanitiseMirrorText,
    looksLikeJtwcProduct,
    parseNhcDiscussion,
    AGENCY_CATALOG,
    normaliseAgency,
    parseStormReference,
    parseDvorakProduct,
    dvorakService,
    createServer
};
