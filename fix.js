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
const cache = new Map();
const JTWC_HOSTS = [
    'https://www.metoc.dc3n.navy.mil/jtwc',
    'https://www.metoc.navy.mil/jtwc'
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

    return { stormId, basin, stormName, product };
}

function fetchText(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 2) {
            reject(new Error('Too many redirects from the official JTWC source.'));
            return;
        }
        const request = https.get(url, {
            headers: {
                'Accept': 'text/plain,text/html;q=0.9,*/*;q=0.1',
                'User-Agent': 'SatelliteViewer-Dvorak/1.0 (+https://www.metoc.navy.mil/)'
            },
            timeout: 15000
        }, response => {
            const { statusCode = 502, headers } = response;
            if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                response.resume();
                const nextURL = new URL(headers.location, url).toString();
                fetchText(nextURL, redirects + 1).then(resolve, reject);
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
        const isAutomated = /^(?:CIMSS|SATCON|ADT|AIDT|D-MINT|D-PRINT)/.test(sourceAgency);
        const agency = isAutomated ? sourceAgency : normaliseAgency(sourceAgency);
        if (!agency || seen.has(agency)) return;
        seen.add(agency);

        const tMatch = raw.match(/\bT\s*(\d(?:\.\d)?)/i);
        const windMatch = raw.match(/\b(\d{1,3})\s*KTS?\b/i);
        const timeMatch = raw.match(/\bAT\s+(\d{4,6}Z)\b/i);
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

function buildUnavailable(reference, message, status = 'not_available') {
    return {
        status,
        message,
        storm_id: reference.stormId,
        storm_name: reference.stormName,
        product_id: reference.product ? reference.product.replace('prog.txt', '').toUpperCase() : null,
        agencies: [],
        automated: [],
        source: null,
        issued: null,
        fetched_at: new Date().toISOString(),
        common_agencies: COMMON_AGENCIES,
        agency_catalog: AGENCY_CATALOG
    };
}

async function locateAndParse(reference) {
    if (!reference.product) {
        return buildUnavailable(
            reference,
            'No JTWC prognostic-reasoning product can be matched to this storm yet. Agency values are never estimated or filled in.'
        );
    }

    let lastError = null;
    for (const host of JTWC_HOSTS) {
        const source = `${host}/products/${reference.product}`;
        try {
            const response = await fetchText(source);
            if (response.status !== 200) continue;
            const parsed = parseDvorakProduct(response.text);
            if (!parsed.agencies.length && !parsed.automated.length) {
                return buildUnavailable(
                    reference,
                    'JTWC has a current product for this storm, but its latest reasoning does not list an agency Dvorak-fix table.',
                    'not_available'
                );
            }
            return {
                status: 'ok',
                message: '',
                storm_id: reference.stormId,
                storm_name: reference.stormName,
                product_id: reference.product.replace('prog.txt', '').toUpperCase(),
                agencies: parsed.agencies,
                automated: parsed.automated,
                source,
                issued: parsed.issued || null,
                fetched_at: new Date().toISOString(),
                common_agencies: COMMON_AGENCIES,
        agency_catalog: AGENCY_CATALOG
            };
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        return buildUnavailable(
            reference,
            'The live JTWC source could not be reached right now. Please refresh in a moment; no stale or inferred fix is shown.',
            'source_unavailable'
        );
    }
    return buildUnavailable(
        reference,
        'JTWC is not currently publishing a matching prognostic-reasoning product for this storm. Agency values are shown only when officially reported.',
        'not_available'
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
    cache.set(key, { savedAt: Date.now(), payload });
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
    AGENCY_CATALOG,
    normaliseAgency,
    parseStormReference,
    parseDvorakProduct,
    dvorakService,
    createServer
};
