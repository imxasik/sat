<?php
/**
 * Live JTWC Dvorak-fix endpoint.
 *
 * This endpoint reads only official JTWC prognostic-reasoning products and
 * returns the agency table exactly as published. It is deliberately not a
 * generic URL proxy: the requested storm id can resolve only to an expected
 * JTWC product filename.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, max-age=0');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    header('Allow: GET, OPTIONS');
    http_response_code(405);
    echo json_encode(['status' => 'invalid_request', 'message' => 'Only GET requests are supported.']);
    exit;
}

const DVORAK_CACHE_SECONDS = 240;
const DVORAK_AGENCY_CATALOG = [
    ['id' => 'PGTW', 'label' => 'JTWC'],
    ['id' => 'DEMS', 'label' => 'DEMS'],
    ['id' => 'RJTD', 'label' => 'Japan Meteorological Agency'],
    ['id' => 'KNES', 'label' => 'NOAA Satellite Analysis Branch'],
    ['id' => 'NHC', 'label' => 'U.S. National Hurricane Center'],
    ['id' => 'PAGASA', 'label' => 'Philippines'],
    ['id' => 'RCTP', 'label' => 'Taiwan CWA'],
    ['id' => 'CMA', 'label' => 'China Meteorological Administration'],
    ['id' => 'KMA', 'label' => 'Korea Meteorological Administration'],
    ['id' => 'MFR', 'label' => 'Météo-France La Réunion'],
    ['id' => 'BOM', 'label' => 'Australian Bureau of Meteorology']
];
const DVORAK_COMMON_AGENCIES = ['PGTW', 'DEMS', 'RJTD', 'KNES', 'NHC', 'PAGASA', 'RCTP', 'CMA', 'KMA', 'MFR', 'BOM'];
const DVORAK_JTWC_HOSTS = [
    'https://www.metoc.dc3n.navy.mil/jtwc',
    'https://www.metoc.navy.mil/jtwc'
];

function dvorak_string_param(string $key, int $maxLength = 80): string {
    $value = isset($_GET[$key]) ? (string) $_GET[$key] : '';
    $value = preg_replace('/[\x00-\x1F<>]/', '', $value) ?? '';
    return substr(trim($value), 0, $maxLength);
}

function dvorak_storm_reference(): array {
    $stormId = strtolower(dvorak_string_param('storm_id'));
    $stormName = dvorak_string_param('storm_name');
    $basin = strtoupper(dvorak_string_param('basin'));
    $explicitProduct = strtolower(dvorak_string_param('product'));
    $product = '';

    // Keep the request constrained to a JTWC product filename. This endpoint
    // must never accept an arbitrary remote URL.
    if (preg_match('/^(?:wp|io|sh)[0-9]{4}prog\.txt$/', $explicitProduct)) {
        $product = $explicitProduct;
    }

    if ($product === '' && preg_match('/^([a-z]{2})(\d{2})(\d{4})/i', $stormId, $matches)) {
        $prefixMap = [
            'wp' => 'wp', 'ni' => 'io', 'io' => 'io',
            'si' => 'sh', 'sp' => 'sh', 'sh' => 'sh'
        ];
        $basinCode = strtolower($matches[1]);
        if (isset($prefixMap[$basinCode])) {
            $product = $prefixMap[$basinCode] . $matches[2] . substr($matches[3], -2) . 'prog.txt';
        }
    }

    return [
        'storm_id' => $stormId,
        'storm_name' => $stormName,
        'basin' => $basin,
        'product' => $product
    ];
}

function dvorak_unavailable(array $reference, string $message, string $status = 'not_available'): array {
    return [
        'status' => $status,
        'message' => $message,
        'storm_id' => $reference['storm_id'],
        'storm_name' => $reference['storm_name'],
        'product_id' => $reference['product'] !== '' ? strtoupper(str_replace('prog.txt', '', $reference['product'])) : null,
        'agencies' => [],
        'automated' => [],
        'source' => null,
        'issued' => null,
        'fetched_at' => gmdate('c'),
        'common_agencies' => DVORAK_COMMON_AGENCIES,
        'agency_catalog' => DVORAK_AGENCY_CATALOG
    ];
}

function dvorak_fetch_text(string $url): array {
    $curl = curl_init($url);
    if ($curl === false) {
        return ['status' => 0, 'text' => '', 'error' => 'Unable to initialise the JTWC request.'];
    }

    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 2,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 18,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => [
            'Accept: text/plain,text/html;q=0.9,*/*;q=0.1',
            'User-Agent: SatelliteViewer-Dvorak/1.0 (+https://www.metoc.navy.mil/)'
        ]
    ]);
    $text = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
    $error = curl_error($curl);
    curl_close($curl);

    if ($text === false) {
        return ['status' => $status, 'text' => '', 'error' => $error ?: 'The JTWC request failed.'];
    }
    if (strlen($text) > 800000) {
        return ['status' => 0, 'text' => '', 'error' => 'The official response exceeded the safety limit.'];
    }
    return ['status' => $status, 'text' => $text, 'error' => ''];
}

function dvorak_normalise_agency(string $agency): string {
    $canonical = strtoupper(trim(preg_replace('/\s+/', ' ', $agency) ?? ''));
    $aliases = [
        'KNHC' => 'NHC', 'NHC' => 'NHC', 'TAFB' => 'NHC', 'NHC/TAFB' => 'NHC', 'KNHC/TAFB' => 'NHC',
        'PAGASA' => 'PAGASA', 'RPHI' => 'PAGASA',
        'RCTP' => 'RCTP', 'CWA' => 'RCTP',
        'CMA' => 'CMA', 'BABJ' => 'CMA',
        'KMA' => 'KMA', 'RKSL' => 'KMA',
        'MFR' => 'MFR', 'FMEE' => 'MFR',
        'BOM' => 'BOM', 'ABRF' => 'BOM', 'APRF' => 'BOM', 'AMMC' => 'BOM'
    ];
    return $aliases[$canonical] ?? $canonical;
}

function dvorak_parse_product(string $text): array {
    $clean = str_replace("\r", '', $text);
    if (!preg_match('/AGENCY\s+DVORAK(?:\s+AND\s+AUTOMATED)?\s+FIXES\s*:/i', $clean, $heading, PREG_OFFSET_CAPTURE)) {
        return ['agencies' => [], 'automated' => [], 'issued' => ''];
    }

    $afterHeading = substr($clean, $heading[0][1]);
    if (preg_match('/\n\s*(?:FORECASTER\s+ASSESSMENT|ANALYSIS\s+CONFIDENCE|3\.\s*FORECAST|INITIAL\s+WIND\s+RADII)\b/i', $afterHeading, $end, PREG_OFFSET_CAPTURE)) {
        $block = substr($afterHeading, 0, $end[0][1]);
    } else {
        $block = $afterHeading;
    }

    $agencies = [];
    $automated = [];
    $seen = [];
    foreach (preg_split('/\n/', $block) as $line) {
        if (!preg_match('/^\s*([A-Z][A-Z0-9 .\/-]{1,34}):\s*(.+?)\s*$/i', $line, $matches)) {
            continue;
        }
        $sourceAgency = strtoupper(trim(preg_replace('/\s+/', ' ', $matches[1]) ?? ''));
        $raw = trim(preg_replace('/\s+/', ' ', $matches[2]) ?? '');
        $isAutomated = preg_match('/^(?:CIMSS|SATCON|ADT|AIDT|D-MINT|D-PRINT)/', $sourceAgency) === 1;
        $agency = $isAutomated ? $sourceAgency : dvorak_normalise_agency($sourceAgency);
        if ($agency === '' || isset($seen[$agency])) {
            continue;
        }
        $seen[$agency] = true;

        $fix = [
            'agency' => $agency,
            'source_agency' => $sourceAgency !== $agency ? $sourceAgency : null,
            't_number' => preg_match('/\bT\s*(\d(?:\.\d)?)/i', $raw, $tMatch) ? 'T' . $tMatch[1] : null,
            'knots' => preg_match('/\b(\d{1,3})\s*KTS?\b/i', $raw, $windMatch) ? (int) $windMatch[1] : null,
            'time' => preg_match('/\bAT\s+(\d{4,6}Z)\b/i', $raw, $timeMatch) ? strtoupper($timeMatch[1]) : null,
            'raw' => $raw
        ];

        if ($isAutomated) {
            $automated[] = $fix;
        } else {
            $agencies[] = $fix;
        }
    }

    $issued = preg_match('/\b(\d{2}\/\d{4}Z)\b/', $clean, $issuedMatch) ? $issuedMatch[1] : '';
    return ['agencies' => $agencies, 'automated' => $automated, 'issued' => $issued];
}

function dvorak_load_live(array $reference): array {
    if ($reference['product'] === '') {
        return dvorak_unavailable(
            $reference,
            'No JTWC prognostic-reasoning product can be matched to this storm yet. Agency values are never estimated or filled in.'
        );
    }

    $lastError = '';
    foreach (DVORAK_JTWC_HOSTS as $host) {
        $source = $host . '/products/' . $reference['product'];
        $response = dvorak_fetch_text($source);
        if ($response['error'] !== '') {
            $lastError = $response['error'];
            continue;
        }
        if ($response['status'] !== 200) {
            continue;
        }

        $parsed = dvorak_parse_product($response['text']);
        if (count($parsed['agencies']) === 0 && count($parsed['automated']) === 0) {
            return dvorak_unavailable(
                $reference,
                'JTWC has a current product for this storm, but its latest reasoning does not list an agency Dvorak-fix table.'
            );
        }

        return [
            'status' => 'ok',
            'message' => '',
            'storm_id' => $reference['storm_id'],
            'storm_name' => $reference['storm_name'],
            'product_id' => strtoupper(str_replace('prog.txt', '', $reference['product'])),
            'agencies' => $parsed['agencies'],
            'automated' => $parsed['automated'],
            'source' => $source,
            'issued' => $parsed['issued'] !== '' ? $parsed['issued'] : null,
            'fetched_at' => gmdate('c'),
            'common_agencies' => DVORAK_COMMON_AGENCIES,
        'agency_catalog' => DVORAK_AGENCY_CATALOG
        ];
    }

    if ($lastError !== '') {
        return dvorak_unavailable(
            $reference,
            'The live JTWC source could not be reached right now. Please refresh in a moment; no stale or inferred fix is shown.',
            'source_unavailable'
        );
    }
    return dvorak_unavailable(
        $reference,
        'JTWC is not currently publishing a matching prognostic-reasoning product for this storm. Agency values are shown only when officially reported.'
    );
}

$reference = dvorak_storm_reference();
if ($reference['storm_id'] === '' && $reference['product'] === '') {
    http_response_code(400);
    echo json_encode(dvorak_unavailable($reference, 'A storm identifier is required.', 'invalid_request'), JSON_UNESCAPED_SLASHES);
    exit;
}

$forceRefresh = isset($_GET['refresh']) && (string) $_GET['refresh'] === '1';
$cacheKey = hash('sha256', implode('|', [$reference['storm_id'], $reference['product'], $reference['storm_name']]));
$cacheFile = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'sat-dvorak-' . $cacheKey . '.json';
if (!$forceRefresh && is_file($cacheFile) && (time() - filemtime($cacheFile) < DVORAK_CACHE_SECONDS)) {
    $cached = file_get_contents($cacheFile);
    if ($cached !== false) {
        $cachedData = json_decode($cached, true);
        if (is_array($cachedData)) {
            $cachedData['cache'] = 'hit';
            echo json_encode($cachedData, JSON_UNESCAPED_SLASHES);
            exit;
        }
    }
}

$payload = dvorak_load_live($reference);
$payload['cache'] = 'miss';
// Best-effort short cache: it protects the official source while still keeping
// the "Refresh" action meaningfully live. Cache failures must not affect data.
@file_put_contents($cacheFile, json_encode($payload, JSON_UNESCAPED_SLASHES), LOCK_EX);
echo json_encode($payload, JSON_UNESCAPED_SLASHES);
