<?php
/**
 * Independent official tropical-cyclone analysis endpoint.
 *
 * A card is populated only from that centre's own website/bulletin.  In
 * particular, a JTWC prognostic-reasoning table can populate PGTW only; it is
 * never used as a proxy for DEMS, JMA, CWA, CMA, KMA, PAGASA, etc.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, max-age=0');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    header('Allow: GET, OPTIONS'); http_response_code(405);
    echo json_encode(['status' => 'invalid_request', 'message' => 'Only GET requests are supported.']); exit;
}

const DVORAK_CACHE_SECONDS = 240;
const DVORAK_LAST_GOOD_SECONDS = 86400;
const JTWC_HOSTS = [
    'https://www.metoc.navy.mil/jtwc', 'https://www.metoc.dc3n.navy.mil/jtwc',
    'http://www.metoc.navy.mil/jtwc', 'http://www.metoc.dc3n.navy.mil/jtwc'
];
const JTWC_MIRRORS = [
    'https://r.jina.ai/{url}', 'https://api.allorigins.win/raw?url={enc}',
    'https://api.codetabs.com/v1/proxy?quest={enc}'
];
const AGENCY_CATALOG = [
    ['id'=>'PGTW','label'=>'JTWC','source_label'=>'JTWC prognostic reasoning','source_url'=>'https://www.metoc.navy.mil/jtwc/jtwc.html','analysis_kind'=>'dvorak','basins'=>['WP','NI','IO','SI','SP','SH']],
    ['id'=>'DEMS','label'=>'India Meteorological Department','source_label'=>'IMD satellite / satellite-fix bulletin','source_url'=>'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=MjI%3D&menu_id=Mg%3D%3D','analysis_kind'=>'dvorak','basins'=>['NI','IO']],
    ['id'=>'RJTD','label'=>'Japan Meteorological Agency','source_label'=>'JMA / TCAC Tokyo advisory','source_url'=>'https://www.data.jma.go.jp/tca/data/index.html','analysis_kind'=>'official_analysis','basins'=>['WP']],
    ['id'=>'KNES','label'=>'NOAA Satellite Analysis Branch','source_label'=>'NOAA OSPO tropical products','source_url'=>'https://ospo.noaa.gov/products/ocean/tropical/tdpositions.html','analysis_kind'=>'dvorak','basins'=>['GLOBAL']],
    ['id'=>'NHC','label'=>'U.S. National Hurricane Center','source_label'=>'NHC forecast discussion / TAFB analysis','source_url'=>'https://www.nhc.noaa.gov/','analysis_kind'=>'dvorak','basins'=>['AL','EP','CP']],
    ['id'=>'PAGASA','label'=>'PAGASA','source_label'=>'PAGASA tropical cyclone bulletin','source_url'=>'https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin','analysis_kind'=>'official_analysis','basins'=>['WP']],
    ['id'=>'RCTP','label'=>'Taiwan CWA','source_label'=>'CWA typhoon analysis and forecast','source_url'=>'https://www.cwa.gov.tw/V8/E/P/Typhoon/TY_NEWS.html','analysis_kind'=>'official_analysis','basins'=>['WP']],
    ['id'=>'CMA','label'=>'China Meteorological Administration','source_label'=>'CMA / NMC Typhoon Network','source_url'=>'https://typhoon.nmc.cn/web.html','analysis_kind'=>'official_analysis','basins'=>['WP']],
    ['id'=>'KMA','label'=>'Korea Meteorological Administration','source_label'=>'KMA typhoon analysis','source_url'=>'https://www.weather.go.kr/neng/typhoon/typhoon-information.do','analysis_kind'=>'official_analysis','basins'=>['WP']],
    ['id'=>'MFR','label'=>'Météo-France La Réunion','source_label'=>'RSMC La Réunion cyclone activity','source_url'=>'https://meteofrance.re/fr/cyclone/activite-cyclonique-en-cours','analysis_kind'=>'official_analysis','basins'=>['SI','SH']],
    ['id'=>'BOM','label'=>'Australian Bureau of Meteorology','source_label'=>'BoM tropical cyclone warnings','source_url'=>'https://www.bom.gov.au/weather-and-climate/specialised-forecasts-and-observations/tropical-cyclone','analysis_kind'=>'official_analysis','basins'=>['SI','SP','SH']]
];
const COMMON_AGENCIES = ['PGTW','DEMS','RJTD','KNES','NHC','PAGASA','RCTP','CMA','KMA','MFR','BOM'];
const SOURCE_URLS = [
    'dems_archive'=>'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=MjI%3D&menu_id=Mg%3D%3D',
    'dems_special'=>'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=NzM%3D&menu_id=OQ%3D%3D',
    'jma'=>'https://www.data.jma.go.jp/tca/data/index.html',
    'pagasa'=>'https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin',
    'cwa'=>'https://www.cwa.gov.tw/V8/E/P/Typhoon/TY_NEWS.html',
    'cma'=>'https://typhoon.nmc.cn/web.html',
    'kma'=>'https://www.weather.go.kr/neng/typhoon/typhoon-information.do',
    'mfr'=>'https://meteofrance.re/fr/cyclone/activite-cyclonique-en-cours',
    'bom'=>'https://www.bom.gov.au/weather-and-climate/specialised-forecasts-and-observations/tropical-cyclone'
];

function param(string $key, int $max = 80): string {
    $value = isset($_GET[$key]) ? (string)$_GET[$key] : '';
    return substr(trim((string)preg_replace('/[\x00-\x1F<>]/', '', $value)), 0, $max);
}
function agency_info(string $id): array {
    foreach (AGENCY_CATALOG as $item) if ($item['id'] === $id) return $item;
    return ['id'=>$id,'label'=>$id,'source_label'=>$id,'source_url'=>null,'analysis_kind'=>'official_analysis','basins'=>[]];
}
function status_for(string $id, string $status, string $message, ?string $source = null): array {
    $item = agency_info($id);
    return ['agency'=>$id,'status'=>$status,'message'=>$message,'source'=>$source ?? $item['source_url'],
        'source_label'=>$item['source_label'],'analysis_kind'=>$item['analysis_kind']];
}
function reference(): array {
    $id = strtolower(param('storm_id'));
    $product = strtolower(param('product'));
    if (!preg_match('/^(?:wp|io|sh)[0-9]{4}prog\.txt$/', $product)) {
        $product = '';
        if (preg_match('/^([a-z]{2})(\d{2})(\d{4})/', $id, $m)) {
            $map = ['wp'=>'wp','ni'=>'io','io'=>'io','si'=>'sh','sp'=>'sh','sh'=>'sh'];
            if (isset($map[strtolower($m[1])])) $product = $map[strtolower($m[1])] . $m[2] . substr($m[3], -2) . 'prog.txt';
        }
    }
    $nhc = preg_match('/^(al|ep|cp)(\d{2})(\d{4})/', $id, $m) ? strtolower($m[1].$m[2].$m[3]) : '';
    $lat = filter_var(param('lat', 24), FILTER_VALIDATE_FLOAT);
    $lon = filter_var(param('lon', 24), FILTER_VALIDATE_FLOAT);
    return ['storm_id'=>$id,'storm_name'=>param('storm_name'),'basin'=>strtoupper(param('basin')),
        'product'=>$product,'nhc_id'=>$nhc,
        'latitude'=>($lat !== false && abs($lat) <= 90) ? (float)$lat : null,
        'longitude'=>($lon !== false && abs($lon) <= 180) ? (float)$lon : null];
}
function basin(array $ref): string {
    $raw = strtoupper((string)(preg_split('/\s+/', $ref['basin'])[0] ?? ''));
    $fromParameter = ['B'=>'NI','AS'=>'NI','ARABIAN'=>'NI','BOB'=>'NI'][$raw] ?? $raw;
    if (in_array($fromParameter, ['AL','EP','CP','WP','NI','IO','SI','SP','SH'], true)) return $fromParameter;
    $p = strtoupper(substr($ref['storm_id'], 0, 2));
    return in_array($p, ['AL','EP','CP','WP','NI','IO','SI','SP','SH'], true) ? $p : '';
}
function is_covered(array $agency, array $ref): bool {
    return in_array('GLOBAL', $agency['basins'], true) || in_array(basin($ref), $agency['basins'], true);
}
function fetch_text(string $url, int $timeout = 12): array {
    $curl = curl_init($url);
    if ($curl === false) return ['status'=>0,'text'=>'','error'=>'Unable to initialise request.'];
    curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_FOLLOWLOCATION=>true, CURLOPT_MAXREDIRS=>3,
        CURLOPT_CONNECTTIMEOUT=>max(4, (int)round($timeout / 2)), CURLOPT_TIMEOUT=>$timeout,
        CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2, CURLOPT_ENCODING=>'', CURLOPT_HTTPHEADER=>[
            'Accept: text/plain,text/html,application/xml;q=0.9,*/*;q=0.1','User-Agent: SatelliteViewer-AgencyAnalysis/2.0']]);
    $text = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); $error = curl_error($curl); curl_close($curl);
    if ($text === false) return ['status'=>$status,'text'=>'','error'=>$error ?: 'Official request failed.'];
    if (strlen($text) > 900000) return ['status'=>0,'text'=>'','error'=>'Official response exceeded safety limit.'];
    return ['status'=>$status,'text'=>$text,'error'=>''];
}
function fetch_many(array $urls, int $timeout = 12): array {
    $multi = curl_multi_init(); $handles = [];
    foreach ($urls as $key => $url) {
        $curl = curl_init($url);
        if ($curl === false) continue;
        curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_FOLLOWLOCATION=>true, CURLOPT_MAXREDIRS=>3,
            CURLOPT_CONNECTTIMEOUT=>max(4, (int)round($timeout / 2)), CURLOPT_TIMEOUT=>$timeout,
            CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2, CURLOPT_ENCODING=>'', CURLOPT_HTTPHEADER=>[
                'Accept: text/plain,text/html,application/xml;q=0.9,*/*;q=0.1','User-Agent: SatelliteViewer-AgencyAnalysis/2.0']]);
        curl_multi_add_handle($multi, $curl); $handles[$key] = $curl;
    }
    $running = null;
    do { $code = curl_multi_exec($multi, $running); if ($running) curl_multi_select($multi, 1.0); } while ($running && $code === CURLM_OK);
    $results = [];
    foreach ($handles as $key => $curl) {
        $text = curl_multi_getcontent($curl); $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); $error = curl_error($curl);
        if ($text === false || $error !== '') $results[$key] = ['status'=>$status,'text'=>'','error'=>$error ?: 'Official request failed.'];
        elseif (strlen($text) > 900000) $results[$key] = ['status'=>0,'text'=>'','error'=>'Official response exceeded safety limit.'];
        else $results[$key] = ['status'=>$status,'text'=>$text,'error'=>''];
        curl_multi_remove_handle($multi, $curl); curl_close($curl);
    }
    curl_multi_close($multi); return $results;
}
function plain_text(string $text): string {
    $text = preg_replace('/<script\b[^>]*>.*?<\/script>/is', ' ', $text) ?? $text;
    $text = preg_replace('/<style\b[^>]*>.*?<\/style>/is', ' ', $text) ?? $text;
    $text = html_entity_decode(strip_tags($text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string)preg_replace('/\s+/', ' ', $text));
}
function norm(string $text): string { return trim((string)preg_replace('/[^A-Z0-9]+/', ' ', strtoupper($text))); }
function storm_name_in(string $text, array $ref): bool {
    $name = norm($ref['storm_name']);
    if ($name === '' || preg_match('/^(INVEST|UNKNOWN|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)$/', $name)) return false;
    return strpos(norm($text), $name) !== false;
}
function coord_near(string $text, array $ref, float $distance = 4.0): bool {
    if (!is_float($ref['latitude']) || !is_float($ref['longitude'])) return false;
    if (!preg_match_all('/(\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])\s*\/?\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])/i', $text, $matches, PREG_SET_ORDER)) return false;
    foreach ($matches as $m) {
        $lat = (float)$m[1] * (strtoupper($m[2]) === 'S' ? -1 : 1); $lon = (float)$m[3] * (strtoupper($m[4]) === 'W' ? -1 : 1);
        $dLon = min(abs($lon - $ref['longitude']), 360 - abs($lon - $ref['longitude']));
        if (abs($lat - $ref['latitude']) <= $distance && $dLon <= $distance) return true;
    }
    return false;
}
function official_fix(string $agency, array $values = []): array {
    $item = agency_info($agency);
    return ['agency'=>$agency,'source_agency'=>$values['source_agency'] ?? null,'t_number'=>$values['t_number'] ?? null,
        'knots'=>$values['knots'] ?? null,'wind_ms'=>$values['wind_ms'] ?? null,'wind_kmh'=>$values['wind_kmh'] ?? null,
        'intensity_label'=>$values['intensity_label'] ?? null,'pressure_hpa'=>$values['pressure_hpa'] ?? null,
        'time'=>$values['time'] ?? null,'raw'=>substr(trim((string)preg_replace('/\s+/', ' ', $values['raw'] ?? '')), 0, 400),
        'source'=>$values['source'] ?? $item['source_url'],'source_kind'=>$values['source_kind'] ?? 'official',
        'source_label'=>$values['source_label'] ?? $item['source_label'],'analysis_kind'=>$values['analysis_kind'] ?? $item['analysis_kind']];
}
function unavailable(array $ref, string $message, string $status = 'not_available', array $attempts = [], array $agencyStatuses = []): array {
    return ['status'=>$status,'message'=>$message,'storm_id'=>$ref['storm_id'],'storm_name'=>$ref['storm_name'],
        'product_id'=>$ref['product'] !== '' ? strtoupper(str_replace('prog.txt', '', $ref['product'])) : ($ref['nhc_id'] !== '' ? strtoupper($ref['nhc_id']) : null),
        'agencies'=>[],'automated'=>[],'source'=>null,'source_kind'=>null,'freshness'=>'unavailable','stale'=>false,'issued'=>null,
        'fetched_at'=>gmdate('c'),'attempts'=>$attempts,'agency_statuses'=>$agencyStatuses,
        'common_agencies'=>COMMON_AGENCIES,'agency_catalog'=>AGENCY_CATALOG];
}
function success(array $ref, array $fixes, array $statuses, array $attempts): array {
    $first = $fixes[0] ?? [];
    return ['status'=>'ok','message'=>'Each agency card is populated only from that agency’s own official publication. Operational-analysis values retain the agency’s published units.',
        'storm_id'=>$ref['storm_id'],'storm_name'=>$ref['storm_name'],
        'product_id'=>$ref['product'] !== '' ? strtoupper(str_replace('prog.txt', '', $ref['product'])) : ($ref['nhc_id'] !== '' ? strtoupper($ref['nhc_id']) : null),
        'agencies'=>$fixes,'automated'=>[],'source'=>$first['source'] ?? null,'source_kind'=>$first['source_kind'] ?? null,
        'freshness'=>'live','stale'=>false,'issued'=>null,'fetched_at'=>gmdate('c'),'attempts'=>$attempts,
        'agency_statuses'=>$statuses,'common_agencies'=>COMMON_AGENCIES,'agency_catalog'=>AGENCY_CATALOG];
}

// JTWC parsing is retained for the PGTW card only.
function jtwc_candidates(string $product): array {
    $official = []; foreach (JTWC_HOSTS as $host) $official[] = $host . '/products/' . $product; $items = [];
    foreach ($official as $url) $items[] = ['url'=>$url,'official'=>$url,'kind'=>'official'];
    foreach (JTWC_MIRRORS as $template) $items[] = ['url'=>str_replace(['{url}','{enc}'], [$official[0], rawurlencode($official[0])], $template),'official'=>$official[0],'kind'=>'mirror'];
    return $items;
}
function valid_jtwc(string $text): bool {
    $p = strtoupper($text); return strlen($p) >= 80 && strlen($p) < 900000 && !preg_match('/<HTML|<!DOCTYPE|CLOUDFLARE|ACCESS DENIED|API KEY IS REQUIRED/', $p)
        && (bool)(preg_match('/AGENCY\s+DVORAK/', $p) || (strpos($p, 'PGTW') !== false && preg_match('/PROGNOSTIC\s+REASONING/', $p)));
}
function clean_mirror(string $text): string {
    $at = strpos($text, 'Markdown Content:'); if ($at !== false) $text = substr($text, $at + 17);
    $text = preg_replace('/^\s*(?:Title|URL Source|Published Time|Warning):.*$/mi', '', $text) ?? $text;
    return trim((string)preg_replace('/^\s*```[a-z]*\s*$/mi', '', $text));
}
function fetch_pgtw(array $ref, array &$attempts): ?array {
    if ($ref['product'] === '') return null;
    foreach (jtwc_candidates($ref['product']) as $candidate) {
        $response = fetch_text($candidate['url'], $candidate['kind'] === 'official' ? 12 : 20);
        if ($response['error'] !== '' || $response['status'] !== 200) { $attempts[]=['url'=>$candidate['url'],'kind'=>$candidate['kind'],'result'=>$response['error'] ? 'error' : 'http_'.$response['status']]; continue; }
        $text = $candidate['kind'] === 'mirror' ? clean_mirror($response['text']) : $response['text'];
        if (!valid_jtwc($text)) { $attempts[]=['url'=>$candidate['url'],'kind'=>$candidate['kind'],'result'=>'unrecognised_content']; continue; }
        $block = preg_match('/AGENCY\s+DVORAK(?:\s+AND\s+AUTOMATED)?\s+FIXES\s*:(.*?)(?:\n\s*(?:FORECASTER\s+ASSESSMENT|ANALYSIS\s+CONFIDENCE|3\.\s*FORECAST)\b|$)/is', $text, $m) ? $m[1] : '';
        if (preg_match('/^\s*PGTW:\s*(.+?)\s*$/mi', $block, $m)) {
            $raw = trim((string)preg_replace('/\s+/', ' ', $m[1]));
            preg_match('/\bT\s*(\d(?:\.\d)?)/i', $raw, $t); preg_match('/\b(\d{1,3})\s*KTS?\b/i', $raw, $w); preg_match('/\b(\d{4,6}Z)\b/i', $raw, $time);
            $attempts[]=['url'=>$candidate['url'],'kind'=>$candidate['kind'],'result'=>'ok'];
            return official_fix('PGTW',['t_number'=>isset($t[1])?'T'.$t[1]:null,'knots'=>isset($w[1])?(int)$w[1]:null,'time'=>$time[1]??null,'raw'=>$raw,'source'=>$candidate['official'],'source_kind'=>$candidate['kind'],'analysis_kind'=>'dvorak']);
        }
        $attempts[]=['url'=>$candidate['url'],'kind'=>$candidate['kind'],'result'=>'no_pgtw']; return null;
    }
    return null;
}

function parse_cwa(string $text, array $ref, string $source): ?array {
    $clean = plain_text($text); if (!storm_name_in($clean, $ref)) return null;
    preg_match('/(?:Analysis[\s\S]{0,700}?|Current Western[\s\S]{0,700}?)(?:Maximum Wind Speed|Max sustained winds near center)\s*(\d{1,3})\s*(?:meter|m)\s*(?:per\s*second|\/s(?:ec(?:ond)?)?)/i', $clean, $wind);
    preg_match('/Analysis[\s\S]{0,700}?(?:Minimum Pressure|Minimum pressure)\s*(\d{3,4})\s*hPa/i', $clean, $pressure);
    preg_match('/Analysis\s+(\d{4})\s*UTC\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i', $clean, $time);
    if (!$wind && !$pressure) return null;
    return official_fix('RCTP',['wind_ms'=>isset($wind[1])?(int)$wind[1]:null,'pressure_hpa'=>isset($pressure[1])?(int)$pressure[1]:null,'time'=>isset($time[1])?$time[1].'Z '.$time[2]:null,'raw'=>$wind[0]??$pressure[0],'source'=>$source]);
}
function parse_kma(string $text, array $ref, string $source): ?array {
    $clean = plain_text($text); if (!storm_name_in($clean, $ref)) return null;
    if (!preg_match('/([A-Z][a-z]{2},\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4},\s*\d{2}:\d{2})\s+Analysis\s+(?:[A-Z]|\d+)\s+(\d{1,3})\s+(\d{1,3})\s+(\d{3,4})\s+(\d{1,2}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)/', $clean, $m)) return null;
    return official_fix('KMA',['wind_ms'=>(int)$m[2],'wind_kmh'=>(int)$m[3],'pressure_hpa'=>(int)$m[4],'time'=>$m[1],'raw'=>$m[0],'source'=>$source]);
}
function parse_pagasa(string $text, array $ref, string $source): ?array {
    $clean = plain_text($text); if (!storm_name_in($clean, $ref) || !preg_match('/Maximum sustained winds of\s*(\d{1,3})\s*km\/h/i', $clean, $wind)) return null;
    preg_match('/Issued at\s+([^|]{5,80}?\d{4})/i', $clean, $issued);
    return official_fix('PAGASA',['wind_kmh'=>(int)$wind[1],'time'=>$issued[1]??null,'raw'=>$wind[0],'source'=>$source]);
}
function parse_cma(string $text, array $ref, string $source): ?array {
    $clean = plain_text($text); if (!storm_name_in($clean, $ref)) return null;
    preg_match('/(?:中心附近)?最大风力\s*(\d{1,2})\s*级/i', $clean, $force);
    if (!$force) return null;
    return official_fix('CMA',['intensity_label'=>'Force '.$force[1],'raw'=>$force[0],'source'=>$source]);
}
function parse_dems(string $text, array $ref, string $source): ?array {
    $clean = plain_text($text); if (!preg_match('/(?:\bFT\b|FINAL\s*T(?:ROPICAL)?\s*(?:NUMBER|NO\.?)?)\s*(?:=|:|IS)?\s*(\d(?:\.\d)?)/i', $clean, $t)) return null;
    if (!storm_name_in($clean, $ref) && !coord_near($clean, $ref)) return null;
    preg_match('/(?:MAX(?:IMUM)?\s+SUSTAINED\s+WINDS?|MSW)\D{0,35}(\d{1,3})\s*(KTS?|KT|KM\/?H|M\/?S)/i', $clean, $wind);
    preg_match('/TCIN\d+\s+DEMS\s+(\d{6})/i', $clean, $issued);
    $unit = strtoupper($wind[2] ?? '');
    return official_fix('DEMS',['t_number'=>'T'.$t[1],'knots'=>isset($wind[1]) && strpos($unit, 'KT') === 0?(int)$wind[1]:null,'wind_kmh'=>isset($wind[1]) && strpos($unit, 'KM') !== false?(int)$wind[1]:null,'wind_ms'=>isset($wind[1]) && strpos($unit, 'M/S') !== false?(int)$wind[1]:null,'time'=>isset($issued[1])?$issued[1].'Z':null,'raw'=>substr($clean,max(0,(int)strpos($clean,$t[0])-130),300),'source'=>$source,'source_kind'=>'official_text_render','analysis_kind'=>'dvorak']);
}
function parse_named_wind(string $text, array $ref, string $agency, string $source): ?array {
    $clean = plain_text($text); if (!storm_name_in($clean, $ref)) return null;
    preg_match('/(?:maximum sustained winds?|winds near the centre|vent maximum)\D{0,45}(\d{1,3})\s*(?:knots?|kt)\b/i', $clean, $knots);
    preg_match('/(?:maximum sustained winds?|winds near the centre|vent maximum)\D{0,45}(\d{1,3})\s*km\/?h/i', $clean, $kmh);
    if (!$knots && !$kmh) return null;
    return official_fix($agency,['knots'=>isset($knots[1])?(int)$knots[1]:null,'wind_kmh'=>isset($kmh[1])?(int)$kmh[1]:null,'raw'=>$knots[0]??$kmh[0],'source'=>$source]);
}
function fetch_dems(array $ref): array {
    $pdfs = [];
    foreach ([SOURCE_URLS['dems_special'], SOURCE_URLS['dems_archive']] as $index) {
        $r = fetch_text($index, 13); if ($r['status'] !== 200) continue;
        preg_match_all("#(?:https?://[^\"'\\s<>]+|/?uploads/[^\"'\\s<>]+)(?:satbltn|splbltn)\\.pdf#i", $r['text'], $m);
        foreach ($m[0] as $url) {
            $url = html_entity_decode($url);
            if (!preg_match('#^https?://#i', $url)) $url = 'https://rsmcnewdelhi.imd.gov.in/'.ltrim($url, '/');
            if (!in_array($url, $pdfs, true)) $pdfs[] = $url;
        }
    }
    foreach (array_slice($pdfs, 0, 8) as $pdf) {
        $r = fetch_text('https://r.jina.ai/'.$pdf, 20); if ($r['status'] !== 200) continue;
        $fix = parse_dems($r['text'], $ref, $pdf); if ($fix) return ['fix'=>$fix,'status'=>status_for('DEMS','ok','',$pdf)];
    }
    return ['fix'=>null,'status'=>status_for('DEMS','not_published','No matching IMD satellite-fix bulletin is currently published for this storm.')];
}
function fetch_jma(array $ref): array {
    $r = fetch_text(SOURCE_URLS['jma'], 12); if ($r['status'] !== 200) return ['fix'=>null,'status'=>status_for('RJTD','source_unavailable','The JMA/TCAC Tokyo official advisory could not be reached.')];
    if (!storm_name_in(plain_text($r['text']), $ref)) return ['fix'=>null,'status'=>status_for('RJTD','not_published','JMA/TCAC Tokyo has no matching current advisory for this storm.')];
    preg_match_all("/(?:href=[\"'])?([^\"'\\s<>]+\\.xml)(?:[\"'])?/i", $r['text'], $urls);
    foreach (array_slice($urls[1] ?? [], 0, 6) as $url) {
        $url = html_entity_decode($url); if (!preg_match('#^https?://#i',$url)) $url = 'https://www.data.jma.go.jp/tca/data/'.ltrim($url,'/');
        $xml = fetch_text($url, 12); if ($xml['status'] !== 200 || !storm_name_in(plain_text($xml['text']),$ref)) continue;
        preg_match('/<[^>]*(?:surfaceWindSpeed|maximumWindSpeed|maxWindSpeed|windSpeed)[^>]*>\s*([^<]+)/i',$xml['text'],$wind);
        preg_match('/<[^>]*(?:centralPressure|pressure)[^>]*>\s*([^<]+)/i',$xml['text'],$pressure);
        if (!$wind && !$pressure) continue;
        $isKt = preg_match('/(?:surfaceWindSpeed|maximumWindSpeed|maxWindSpeed|windSpeed)[^>]+(?:kn|kt|knot)/i',$xml['text']) === 1;
        return ['fix'=>official_fix('RJTD',['knots'=>$wind && $isKt?(float)$wind[1]:null,'wind_ms'=>$wind && !$isKt?(float)$wind[1]:null,'pressure_hpa'=>$pressure?(float)$pressure[1]:null,'raw'=>'JMA TCAC Tokyo tropical cyclone advisory','source'=>$url]),'status'=>status_for('RJTD','ok','',$url)];
    }
    return ['fix'=>null,'status'=>status_for('RJTD','not_published','JMA/TCAC Tokyo’s current advisory did not contain a readable analysis value.')];
}
function fetch_nhc(array $ref): array {
    $list = fetch_text('https://www.nhc.noaa.gov/CurrentStorms.json', 14);
    if ($list['status'] !== 200) return ['fix'=>null,'status'=>status_for('NHC','source_unavailable','The NHC active-storm listing could not be reached.')];
    $json = json_decode($list['text'], true); $storm = null; $wanted = substr($ref['storm_id'],0,8);
    foreach (($json['activeStorms'] ?? []) as $item) if (strtolower((string)($item['id']??'')) === $wanted || ($ref['storm_name'] !== '' && strtoupper((string)($item['name']??'')) === strtoupper($ref['storm_name']))) { $storm=$item; break; }
    $url = (string)($storm['forecastDiscussion']['url'] ?? ''); if ($url === '') return ['fix'=>null,'status'=>status_for('NHC','not_published','NHC has no matching current forecast discussion for this storm.')];
    $r = fetch_text($url, 14); if ($r['status'] !== 200) return ['fix'=>null,'status'=>status_for('NHC','source_unavailable','The NHC forecast discussion could not be reached.',$url)];
    $clean=plain_text($r['text']);
    if (!preg_match('/(?:TAFB|SAB|KNES)[\s\S]{0,260}?\bT?(\d(?:\.\d)?)\s*\/\s*(\d{2,3})\s*kt\b/i',$clean,$m)) return ['fix'=>null,'status'=>status_for('NHC','not_published','NHC’s current discussion did not list a subjective satellite estimate.',$url)];
    preg_match('/\b(TAFB|SAB|KNES)\b/i',$m[0],$who);
    return ['fix'=>official_fix('NHC',['source_agency'=>strtoupper($who[1]??'TAFB'),'t_number'=>'T'.number_format((float)$m[1],1),'knots'=>(int)$m[2],'raw'=>$m[0],'source'=>$url,'analysis_kind'=>'dvorak']),'status'=>status_for('NHC','ok','',$url)];
}
function independent_fixes(array $ref): array {
    $b = basin($ref); $results=[];
    if (in_array($b,['NI','IO'],true)) $results[] = fetch_dems($ref);
    if ($b === 'WP') {
        // Independent publishers are requested concurrently. A slow agency page
        // must not delay every other agency or push the browser request past its timeout.
        $results[] = fetch_jma($ref);
        $definitions = [['PAGASA','pagasa','parse_pagasa'],['RCTP','cwa','parse_cwa'],['CMA','cma','parse_cma'],['KMA','kma','parse_kma']];
        $urls = []; foreach ($definitions as $definition) $urls[$definition[1]] = SOURCE_URLS[$definition[1]];
        $pages = fetch_many($urls, 12);
        foreach ($definitions as [$id,$key,$parser]) {
            $r=$pages[$key] ?? ['status'=>0,'text'=>'','error'=>'Official request did not start.'];
            $fix=$r['status']===200 ? $parser($r['text'],$ref,SOURCE_URLS[$key]) : null;
            $results[]=['fix'=>$fix,'status'=>status_for($id,$fix?'ok':($r['status']===200?'not_published':'source_unavailable'),$fix?'':'The agency page has no matching current analysis for this storm.',SOURCE_URLS[$key])];
        }
    }
    if (in_array($b,['AL','EP','CP'],true)) $results[] = fetch_nhc($ref);
    if (in_array($b,['SI','SH'],true)) { $r=fetch_text(SOURCE_URLS['mfr'],12); $results[]=['fix'=>$r['status']===200?parse_named_wind($r['text'],$ref,'MFR',SOURCE_URLS['mfr']):null,'status'=>status_for('MFR',$r['status']===200?'not_published':'source_unavailable','The agency page has no matching current analysis for this storm.',SOURCE_URLS['mfr'])]; }
    if (in_array($b,['SI','SP','SH'],true)) { $r=fetch_text(SOURCE_URLS['bom'],12); $results[]=['fix'=>$r['status']===200?parse_named_wind($r['text'],$ref,'BOM',SOURCE_URLS['bom']):null,'status'=>status_for('BOM',$r['status']===200?'not_published':'source_unavailable','The agency page has no matching current analysis for this storm.',SOURCE_URLS['bom'])]; }
    $byId=[]; foreach ($results as $r) $byId[$r['status']['agency']]=$r;
    $statuses=[]; foreach (AGENCY_CATALOG as $agency) {
        if ($agency['id']==='PGTW') continue;
        if ($agency['id']==='KNES') {$statuses[]=status_for('KNES','discontinued','NOAA OSPO retired manual SAB Dvorak estimates in September 2026; no replacement value is inferred.'); continue;}
        $statuses[]=$byId[$agency['id']]['status'] ?? (is_covered($agency,$ref) ? status_for($agency['id'],'not_checked','No independent source adapter is available for this storm yet.') : status_for($agency['id'],'outside_responsibility','Outside this centre’s published tropical-cyclone responsibility area.'));
    }
    $fixes = []; foreach ($results as $result) if ($result['fix'] !== null) $fixes[] = $result['fix'];
    return ['fixes'=>$fixes,'statuses'=>$statuses];
}

function cache_path(array $ref, string $prefix): string { return rtrim(sys_get_temp_dir(),DIRECTORY_SEPARATOR).DIRECTORY_SEPARATOR.$prefix.hash('sha256',$ref['storm_id'].'|'.$ref['product'].'|'.$ref['storm_name']).'.json'; }
function last_good(array $ref): ?array { $path=cache_path($ref,'sat-agency-last-'); if (!is_file($path)) return null; $raw=json_decode((string)@file_get_contents($path),true); return is_array($raw)&&is_array($raw['payload']??null)&&time()-(int)($raw['saved_at']??0)<=DVORAK_LAST_GOOD_SECONDS?$raw:null; }
function save_good(array $ref,array $payload): void { @file_put_contents(cache_path($ref,'sat-agency-last-'),json_encode(['saved_at'=>time(),'payload'=>$payload],JSON_UNESCAPED_SLASHES),LOCK_EX); }
function load_live(array $ref): array {
    $attempts=[]; $statuses=[]; $fixes=[];
    $pgtw=fetch_pgtw($ref,$attempts);
    if ($pgtw) {$fixes[]=$pgtw; $statuses[]=status_for('PGTW','ok','',$pgtw['source']);}
    else $statuses[]=status_for('PGTW',$ref['product']!==''?'not_published':'outside_responsibility',$ref['product']!==''?'The current JTWC reasoning has no PGTW subjective Dvorak value.':'JTWC has no prognostic-reasoning product for this basin.');
    $independent=independent_fixes($ref); $fixes=array_merge($fixes,$independent['fixes']); $statuses=array_merge($statuses,$independent['statuses']);
    if ($fixes) { $payload=success($ref,$fixes,$statuses,$attempts); save_good($ref,$payload); return $payload; }
    $old=last_good($ref); if ($old) { $payload=$old['payload']; $payload['freshness']='last_published';$payload['stale']=true;$payload['agency_statuses']=$statuses;$payload['attempts']=$attempts;$payload['message']='Live agency sources are unreachable right now. Showing last agency-published values; no value is estimated.';return $payload; }
    return unavailable($ref,basin($ref)!==''?'No matching independent agency analysis is published for this storm right now. Values are never copied from JTWC into another agency card.':'No tropical-cyclone basin can be matched to this storm yet.','not_available',$attempts,$statuses);
}

$ref=reference();
if ($ref['storm_id']==='' && $ref['product']==='') { http_response_code(400); echo json_encode(unavailable($ref,'A storm identifier is required.','invalid_request'),JSON_UNESCAPED_SLASHES); exit; }
$cache=cache_path($ref,'sat-agency-');
if (param('refresh')!=='1' && is_file($cache) && time()-filemtime($cache)<DVORAK_CACHE_SECONDS) {
    $cached=json_decode((string)file_get_contents($cache),true); if (is_array($cached)) {$cached['cache']='hit'; echo json_encode($cached,JSON_UNESCAPED_SLASHES); exit;}
}
$payload=load_live($ref); $payload['cache']='miss'; @file_put_contents($cache,json_encode($payload,JSON_UNESCAPED_SLASHES),LOCK_EX); echo json_encode($payload,JSON_UNESCAPED_SLASHES);
