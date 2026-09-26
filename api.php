<?php
/**
 * API Proxy for NRL Tropical Cyclone Microwave Satellite Viewer
 * Proxies requests to NRL's GeoIPS API
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: public, max-age=300');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$API_BASE = 'https://science.nrlmry.navy.mil/geoips/prod_api/tcweb4';

$action = isset($_GET['action']) ? $_GET['action'] : '';

$ch = curl_init();
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_ENCODING, '');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Accept: application/json',
    'User-Agent: SatelliteViewer/1.0'
]);

switch ($action) {
    case 'active_storms':
        curl_setopt($ch, CURLOPT_URL, $API_BASE . '/active-storms');
        break;

    case 'products':
        $year = isset($_GET['year']) ? intval($_GET['year']) : date('Y');
        $storm_id = isset($_GET['storm_id']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['storm_id']) : '';
        $limit = isset($_GET['limit']) ? min(intval($_GET['limit']), 200) : 50;
        $offset = isset($_GET['offset']) ? intval($_GET['offset']) : 0;
        $sort_order = isset($_GET['sort_order']) ? $_GET['sort_order'] : 'desc';
        
        $url = $API_BASE . '/products/' . $year . '?storm_id=' . urlencode($storm_id) . '&limit=' . $limit . '&offset=' . $offset . '&sort_order=' . $sort_order;
        
        if (!empty($_GET['platform'])) {
            $platforms = is_array($_GET['platform']) ? $_GET['platform'] : [$_GET['platform']];
            foreach ($platforms as $p) {
                $url .= '&platform=' . urlencode(preg_replace('/[^a-zA-Z0-9_\-]/', '', $p));
            }
        }
        if (!empty($_GET['sensor'])) {
            $sensors = is_array($_GET['sensor']) ? $_GET['sensor'] : [$_GET['sensor']];
            foreach ($sensors as $s) {
                $url .= '&sensor=' . urlencode(preg_replace('/[^a-zA-Z0-9_\-]/', '', $s));
            }
        }
        if (!empty($_GET['product'])) {
            $products = is_array($_GET['product']) ? $_GET['product'] : [$_GET['product']];
            foreach ($products as $p) {
                $url .= '&product=' . urlencode(preg_replace('/[^a-zA-Z0-9_\-]/', '', $p));
            }
        }
        if (!empty($_GET['start_datetime'])) {
            $url .= '&start_datetime=' . urlencode($_GET['start_datetime']);
        }
        if (!empty($_GET['end_datetime'])) {
            $url .= '&end_datetime=' . urlencode($_GET['end_datetime']);
        }
        
        curl_setopt($ch, CURLOPT_URL, $url);
        break;

    case 'platform_sensor_products':
        $storm_id = isset($_GET['storm_id']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['storm_id']) : '';
        curl_setopt($ch, CURLOPT_URL, $API_BASE . '/storms/' . urlencode($storm_id) . '/platform-sensor-products');
        break;

    case 'products_summary':
        $storm_id = isset($_GET['storm_id']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['storm_id']) : '';
        curl_setopt($ch, CURLOPT_URL, $API_BASE . '/products/summary/' . urlencode($storm_id));
        break;

    case 'products_history':
        $storm_id = isset($_GET['storm_id']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['storm_id']) : '';
        $output_format = isset($_GET['output_format']) ? $_GET['output_format'] : 'imagery_annotated';
        curl_setopt($ch, CURLOPT_URL, $API_BASE . '/products/summary/history/' . urlencode($storm_id) . '?output_format=' . urlencode($output_format));
        break;

    case 'storm_info':
        $storm_id = isset($_GET['storm_id']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['storm_id']) : '';
        curl_setopt($ch, CURLOPT_URL, $API_BASE . '/storms/' . urlencode($storm_id));
        break;

    case 'image':
        // Proxy the actual image
        $storm_id = isset($_GET['storm_id']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['storm_id']) : '';
        $product_id = isset($_GET['product_id']) ? intval($_GET['product_id']) : 0;
        if ($storm_id && $product_id) {
            curl_close($ch);
            $ch = curl_init();
            $img_url = $API_BASE . '/products/' . urlencode($storm_id) . '/' . $product_id;
            curl_setopt($ch, CURLOPT_URL, $img_url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
            curl_setopt($ch, CURLOPT_TIMEOUT, 60);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
            $img_data = curl_exec($ch);
            $content_type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
            $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            
            if ($http_code == 200 && $img_data) {
                header('Content-Type: ' . ($content_type ?: 'image/webp'));
                header('Cache-Control: public, max-age=86400');
                echo $img_data;
            } else {
                http_response_code(404);
                echo json_encode(['error' => 'Image not found']);
            }
            exit;
        }
        break;

    default:
        echo json_encode(['error' => 'Invalid action. Use: active_storms, products, platform_sensor_products, products_summary, products_history, storm_info, image']);
        exit;
}

$response = curl_exec($ch);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

if ($error) {
    http_response_code(500);
    echo json_encode(['error' => 'API request failed: ' . $error]);
} elseif ($http_code != 200) {
    http_response_code($http_code);
    echo $response;
} else {
    echo $response;
}
?>
