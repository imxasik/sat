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
const DVORAK_LAST_GOOD_SECONDS = 86400;
const DVORAK_JTWC_HOSTS = [
    'https://www.metoc.navy.mil/jtwc',
    'https://www.metoc.dc3n.navy.mil/jtwc',
    'http://www.metoc.navy.mil/jtwc',
    'http://www.metoc.dc3n.navy.mil/jtwc'
];
// Public read-only text mirrors of the very same official file. They are tried
// only after every official host fails (geo-blocking, TLS or firewall issues on
// shared hosting are the usual cause of an empty panel).
const DVORAK_MIRROR_TEMPLATES = [
    'https://r.jina.ai/{url}',
    'https://api.allorigins.win/raw?url={enc}',
    'https://api.codetabs.com/v1/proxy?quest={enc}',
    'https://thingproxy.freeboard.io/fetch/{url}'
];
const DVORAK_NHC_CURRENT_STORMS = [
    'https://www.nhc.noaa.gov/CurrentStorms.json',
    'https://r.jina.ai/https://www.nhc.noaa.gov/CurrentStorms.json'
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

    $nhcId = preg_match('/^(al|ep|cp)(\d{2})(\d{4})/i', $stormId, $nhcMatch)
        ? strtolower($nhcMatch[1] . $nhcMatch[2] . $nhcMatch[3])
        : '';

    return [
        'storm_id' => $stormId,
        'storm_name' => $stormName,
        'basin' => $basin,
        'product' => $product,
        'nhc_id' => $nhcId
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
        'source_kind' => null,
        'freshness' => 'unavailable',
        'stale' => false,
        'issued' => null,
        'fetched_at' => gmdate('c'),
        'common_agencies' => DVORAK_COMMON_AGENCIES,
        'agency_catalog' => DVORAK_AGENCY_CATALOG
    ];
}

function dvorak_fetch_text(string $url, int $timeout = 14): array {
    $curl = curl_init($url);
    if ($curl === false) {
        return ['status' => 0, 'text' => '', 'error' => 'Unable to initialise the JTWC request.'];
    }

    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 2,
        CURLOPT_CONNECTTIMEOUT => max(4, (int) round($timeout / 2)),
        CURLOPT_TIMEOUT => $timeout,
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
        $isAutomated = preg_match('/^(?:CIMSS|SATCON|ADT|AIDT|AIDTC|AIDTM|D-MINT|D-PRINT|DMINT|DPRINT)/', $sourceAgency) === 1;
        $agency = $isAutomated ? $sourceAgency : dvorak_normalise_agency($sourceAgency);
        if ($agency === '' || isset($seen[$agency])) {
            continue;
        }
        $seen[$agency] = true;

        $fix = [
            'agency' => $agency,
            'source_agency' => $sourceAgency !== $agency ? $sourceAgency : null,
            't_number' => (preg_match('/\bT\s*(\d(?:\.\d)?)/i', $raw, $tMatch) || preg_match('/^\s*(\d\.\d)\s*\//', $raw, $tMatch)) ? 'T' . $tMatch[1] : null,
            'knots' => (preg_match('/\b(\d{1,3})\s*KTS?\b/i', $raw, $windMatch) || preg_match('#/\s*(\d{1,3})\s*(?:KTS?)?\b#i', $raw, $windMatch)) ? (int) $windMatch[1] : null,
            'time' => (preg_match('/\bAT\s+(\d{4,6}Z)\b/i', $raw, $timeMatch) || preg_match('/\b(\d{6}Z)\b/', $raw, $timeMatch)) ? strtoupper($timeMatch[1]) : null,
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

function dvorak_source_candidates(string $product): array {
    $official = [];
    foreach (DVORAK_JTWC_HOSTS as $host) {
        $official[] = $host . '/products/' . $product;
    }
    $candidates = [];
    foreach ($official as $url) {
        $candidates[] = ['url' => $url, 'official' => $url, 'kind' => 'official'];
    }
    $primary = $official[0];
    foreach (DVORAK_MIRROR_TEMPLATES as $template) {
        $candidates[] = [
            'url' => str_replace(['{url}', '{enc}'], [$primary, rawurlencode($primary)], $template),
            'official' => $primary,
            'kind' => 'mirror'
        ];
    }
    return $candidates;
}

function dvorak_sanitise_mirror_text(string $text): string {
    $clean = str_replace("\r", '', $text);
    $marker = strpos($clean, 'Markdown Content:');
    if ($marker !== false) {
        $clean = substr($clean, $marker + strlen('Markdown Content:'));
    }
    $clean = preg_replace('/^\s*(?:Title|URL Source|Published Time|Warning):.*$/mi', '', $clean) ?? $clean;
    $clean = preg_replace('/^\s*```[a-z]*\s*$/mi', '', $clean) ?? $clean;
    return trim($clean);
}

function dvorak_looks_like_product(string $text): bool {
    $probe = strtoupper($text);
    $length = strlen($probe);
    if ($length < 80 || $length > 800000) {
        return false;
    }
    if (preg_match('/<HTML|<!DOCTYPE HTML|CLOUDFLARE|ACCESS DENIED|API KEY IS REQUIRED/', $probe)) {
        return false;
    }
    return (bool) (preg_match('/AGENCY\s+DVORAK/', $probe)
        || (strpos($probe, 'PGTW') !== false && preg_match('/PROGNOSTIC\s+REASONING/', $probe)));
}

function dvorak_fetch_official_product(string $product): array {
    $attempts = [];
    foreach (dvorak_source_candidates($product) as $candidate) {
        $response = dvorak_fetch_text($candidate['url'], $candidate['kind'] === 'official' ? 12 : 20);
        if ($response['error'] !== '') {
            $attempts[] = ['url' => $candidate['url'], 'kind' => $candidate['kind'], 'result' => 'error', 'detail' => substr($response['error'], 0, 120)];
            continue;
        }
        if ($response['status'] !== 200) {
            $attempts[] = ['url' => $candidate['url'], 'kind' => $candidate['kind'], 'result' => 'http_' . $response['status']];
            continue;
        }
        $text = $candidate['kind'] === 'mirror' ? dvorak_sanitise_mirror_text($response['text']) : $response['text'];
        if (!dvorak_looks_like_product($text)) {
            $attempts[] = ['url' => $candidate['url'], 'kind' => $candidate['kind'], 'result' => 'unrecognised_content'];
            continue;
        }
        $attempts[] = ['url' => $candidate['url'], 'kind' => $candidate['kind'], 'result' => 'ok'];
        return ['text' => $text, 'source' => $candidate['official'], 'source_kind' => $candidate['kind'], 'attempts' => $attempts];
    }
    return ['text' => '', 'source' => null, 'source_kind' => null, 'attempts' => $attempts];
}

function dvorak_parse_nhc_discussion(string $text): array {
    $clean = preg_replace('/<[^>]+>/', ' ', str_replace("\r", '', $text)) ?? '';
    $agencies = [];
    $seen = [];
    $tokenMap = ['TAFB' => 'TAFB', 'SAB' => 'KNES', 'KNES' => 'KNES', 'AFWA' => 'AFWA'];

    foreach (preg_split('/(?<=\.)\s+/', $clean) as $sentence) {
        if (!preg_match('/dvorak|satellite intensity|subjective/i', $sentence)) {
            continue;
        }
        if (!preg_match_all('/\bT?(\d(?:\.\d)?)\s*\/\s*(\d{2,3})\s*kt\b/i', $sentence, $estimateMatches, PREG_SET_ORDER)) {
            continue;
        }
        preg_match_all('/\b(TAFB|SAB|KNES|AFWA)\b/', strtoupper($sentence), $tokenMatches);
        foreach ($tokenMatches[1] as $index => $token) {
            $estimate = $estimateMatches[$index] ?? (count($estimateMatches) === 1 ? $estimateMatches[0] : null);
            if ($estimate === null) {
                continue;
            }
            $agency = $tokenMap[$token] ?? $token;
            if (isset($seen[$agency])) {
                continue;
            }
            $seen[$agency] = true;
            $agencies[] = [
                'agency' => $agency,
                'source_agency' => $agency === $token ? null : $token,
                't_number' => 'T' . number_format((float) $estimate[1], 1),
                'knots' => (int) $estimate[2],
                'time' => null,
                'raw' => trim($estimate[0]) . ' (' . $token . ')'
            ];
        }
    }

    $issued = preg_match('/\b(\d{3,4}\s*(?:AM|PM)\s+[A-Z]{2,4})\b/', $clean, $issuedMatch) ? $issuedMatch[1] : '';
    return ['agencies' => $agencies, 'automated' => [], 'issued' => $issued];
}

function dvorak_fetch_nhc(array $reference): array {
    $attempts = [];
    $storms = null;
    foreach (DVORAK_NHC_CURRENT_STORMS as $url) {
        $response = dvorak_fetch_text($url, 15);
        if ($response['error'] !== '' || $response['status'] !== 200) {
            $attempts[] = ['url' => $url, 'kind' => 'official', 'result' => $response['error'] !== '' ? 'error' : 'http_' . $response['status']];
            continue;
        }
        $body = strpos($url, 'r.jina.ai') !== false ? dvorak_sanitise_mirror_text($response['text']) : $response['text'];
        $jsonStart = strpos($body, '{');
        $decoded = json_decode($jsonStart === false ? $body : substr($body, $jsonStart), true);
        if (is_array($decoded) && isset($decoded['activeStorms'])) {
            $storms = $decoded['activeStorms'];
            $attempts[] = ['url' => $url, 'kind' => 'official', 'result' => 'ok'];
            break;
        }
        $attempts[] = ['url' => $url, 'kind' => 'official', 'result' => 'unrecognised_content'];
    }
    if (!is_array($storms)) {
        return ['parsed' => null, 'source' => null, 'attempts' => $attempts];
    }

    $wanted = substr($reference['storm_id'], 0, 8);
    $discussionUrl = '';
    foreach ($storms as $storm) {
        $id = strtolower((string) ($storm['id'] ?? ''));
        $name = strtoupper((string) ($storm['name'] ?? ''));
        $matchesName = $reference['storm_name'] !== '' && $name === strtoupper($reference['storm_name']);
        if ($id === $wanted || $matchesName) {
            $discussionUrl = (string) ($storm['forecastDiscussion']['url'] ?? '');
            if ($discussionUrl !== '') {
                break;
            }
        }
    }
    if ($discussionUrl === '') {
        return ['parsed' => null, 'source' => null, 'attempts' => $attempts];
    }

    foreach ([$discussionUrl, 'https://r.jina.ai/' . $discussionUrl] as $url) {
        $response = dvorak_fetch_text($url, 15);
        if ($response['error'] !== '' || $response['status'] !== 200) {
            $attempts[] = ['url' => $url, 'kind' => 'official', 'result' => $response['error'] !== '' ? 'error' : 'http_' . $response['status']];
            continue;
        }
        $parsed = dvorak_parse_nhc_discussion($response['text']);
        $attempts[] = ['url' => $url, 'kind' => 'official', 'result' => count($parsed['agencies']) > 0 ? 'ok' : 'no_table'];
        if (count($parsed['agencies']) > 0) {
            return ['parsed' => $parsed, 'source' => $discussionUrl, 'attempts' => $attempts];
        }
    }
    return ['parsed' => null, 'source' => null, 'attempts' => $attempts];
}

function dvorak_last_good_path(array $reference): string {
    $key = hash('sha256', $reference['storm_id'] . '|' . $reference['product'] . '|' . $reference['nhc_id']);
    return rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'sat-dvorak-last-' . $key . '.json';
}

function dvorak_save_last_good(array $reference, array $payload): void {
    @file_put_contents(
        dvorak_last_good_path($reference),
        json_encode(['saved_at' => time(), 'payload' => $payload], JSON_UNESCAPED_SLASHES),
        LOCK_EX
    );
}

function dvorak_read_last_good(array $reference): ?array {
    $path = dvorak_last_good_path($reference);
    if (!is_file($path)) {
        return null;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !isset($decoded['payload']) || !is_array($decoded['payload'])) {
        return null;
    }
    if (time() - (int) ($decoded['saved_at'] ?? 0) > DVORAK_LAST_GOOD_SECONDS) {
        return null;
    }
    return $decoded;
}

function dvorak_success(array $reference, array $parsed, ?string $source, ?string $sourceKind): array {
    $productId = $reference['product'] !== ''
        ? strtoupper(str_replace('prog.txt', '', $reference['product']))
        : ($reference['nhc_id'] !== '' ? strtoupper($reference['nhc_id']) : null);

    return [
        'status' => 'ok',
        'message' => '',
        'storm_id' => $reference['storm_id'],
        'storm_name' => $reference['storm_name'],
        'product_id' => $productId,
        'agencies' => $parsed['agencies'],
        'automated' => $parsed['automated'],
        'source' => $source,
        'source_kind' => $sourceKind,
        'freshness' => 'live',
        'stale' => false,
        'issued' => ($parsed['issued'] ?? '') !== '' ? $parsed['issued'] : null,
        'fetched_at' => gmdate('c'),
        'common_agencies' => DVORAK_COMMON_AGENCIES,
        'agency_catalog' => DVORAK_AGENCY_CATALOG
    ];
}

function dvorak_load_live(array $reference): array {
    $attempts = [];

    if ($reference['product'] !== '') {
        $fetched = dvorak_fetch_official_product($reference['product']);
        $attempts = array_merge($attempts, $fetched['attempts']);
        if ($fetched['text'] !== '') {
            $parsed = dvorak_parse_product($fetched['text']);
            if (count($parsed['agencies']) > 0 || count($parsed['automated']) > 0) {
                $payload = dvorak_success($reference, $parsed, $fetched['source'], $fetched['source_kind']);
                $payload['attempts'] = $attempts;
                dvorak_save_last_good($reference, $payload);
                return $payload;
            }
            $unavailable = dvorak_unavailable(
                $reference,
                'JTWC has a current product for this storm, but its latest reasoning does not list an agency Dvorak-fix table.'
            );
            $unavailable['attempts'] = $attempts;
            return $unavailable;
        }
    }

    if ($reference['nhc_id'] !== '') {
        $nhc = dvorak_fetch_nhc($reference);
        $attempts = array_merge($attempts, $nhc['attempts']);
        if (is_array($nhc['parsed'])) {
            $payload = dvorak_success($reference, $nhc['parsed'], $nhc['source'], 'official');
            $payload['attempts'] = $attempts;
            dvorak_save_last_good($reference, $payload);
            return $payload;
        }
    }

    // Every live route failed. Re-serve the last table that was officially
    // published for this storm instead of blanking the panel. It stays an
    // official value and is always flagged as "last published".
    $lastGood = dvorak_read_last_good($reference);
    if ($lastGood !== null) {
        $ageMinutes = max(0, (int) round((time() - (int) $lastGood['saved_at']) / 60));
        $payload = $lastGood['payload'];
        $payload['status'] = 'ok';
        $payload['freshness'] = 'last_published';
        $payload['stale'] = true;
        $payload['attempts'] = $attempts;
        $payload['retrieved_at'] = gmdate('c', (int) $lastGood['saved_at']);
        $payload['message'] = 'Live official sources are unreachable right now. Showing the last officially published table (retrieved '
            . $ageMinutes . ' minute' . ($ageMinutes === 1 ? '' : 's') . ' ago); no value is estimated.';
        return $payload;
    }

    if ($reference['product'] === '' && $reference['nhc_id'] === '') {
        $payload = dvorak_unavailable(
            $reference,
            'No official prognostic-reasoning or discussion product can be matched to this storm yet. Agency values are never estimated or filled in.'
        );
        $payload['attempts'] = $attempts;
        return $payload;
    }

    $payload = dvorak_unavailable(
        $reference,
        'Every official source and mirror failed for this storm right now. Please refresh in a moment; no stale or inferred fix is shown.',
        'source_unavailable'
    );
    $payload['attempts'] = $attempts;
    return $payload;
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
