/**
 * NRL Microwave Satellite Viewer - Main Application
 * Professional, Fast, Mobile-Friendly Satellite Image Viewer
 * Direct API calls to NRL GeoIPS (CORS enabled)
 */

(function() {
    'use strict';

    // === Configuration ===
    const API_BASE = 'https://science.nrlmry.navy.mil/geoips/prod_api/tcweb4';
    // Same-origin endpoint. In PHP hosting this is fix.php; the local Node
    // server mirrors the same route so the feature can be previewed locally.
    const DVORAK_ENDPOINT = 'fix.php';
    // The panel lists the requested operational centres for every storm.
    // A number is shown only if it appears in the current official source.
    const DVORAK_AGENCY_CATALOG = [
        { id: 'PGTW', label: 'JTWC', source_label: 'JTWC prognostic reasoning', source_url: 'https://www.metoc.navy.mil/jtwc/jtwc.html', analysis_kind: 'dvorak' },
        { id: 'DEMS', label: 'India Meteorological Department', source_label: 'IMD satellite / satellite-fix bulletin', source_url: 'https://rsmcnewdelhi.imd.gov.in/archive-information.php?internal_menu=MjI%3D&menu_id=Mg%3D%3D', analysis_kind: 'dvorak' },
        { id: 'RJTD', label: 'Japan Meteorological Agency', source_label: 'JMA / TCAC Tokyo advisory', source_url: 'https://www.data.jma.go.jp/tca/data/index.html', analysis_kind: 'official_analysis' },
        { id: 'KNES', label: 'NOAA Satellite Analysis Branch', source_label: 'NOAA OSPO tropical products', source_url: 'https://ospo.noaa.gov/products/ocean/tropical/tdpositions.html', analysis_kind: 'dvorak' },
        { id: 'NHC', label: 'U.S. National Hurricane Center', source_label: 'NHC forecast discussion / TAFB analysis', source_url: 'https://www.nhc.noaa.gov/', analysis_kind: 'dvorak' },
        { id: 'PAGASA', label: 'PAGASA', source_label: 'PAGASA tropical cyclone bulletin', source_url: 'https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin', analysis_kind: 'official_analysis' },
        { id: 'RCTP', label: 'Taiwan CWA', source_label: 'CWA typhoon analysis and forecast', source_url: 'https://www.cwa.gov.tw/V8/E/P/Typhoon/TY_NEWS.html', analysis_kind: 'official_analysis' },
        { id: 'CMA', label: 'China Meteorological Administration', source_label: 'CMA / NMC Typhoon Network', source_url: 'https://typhoon.nmc.cn/web.html', analysis_kind: 'official_analysis' },
        { id: 'KMA', label: 'Korea Meteorological Administration', source_label: 'KMA typhoon analysis', source_url: 'https://www.weather.go.kr/neng/typhoon/typhoon-information.do', analysis_kind: 'official_analysis' },
        { id: 'MFR', label: 'Météo-France La Réunion', source_label: 'RSMC La Réunion cyclone activity', source_url: 'https://meteofrance.re/fr/cyclone/activite-cyclonique-en-cours', analysis_kind: 'official_analysis' },
        { id: 'BOM', label: 'Australian Bureau of Meteorology', source_label: 'BoM tropical cyclone warnings', source_url: 'https://www.bom.gov.au/weather-and-climate/specialised-forecasts-and-observations/tropical-cyclone', analysis_kind: 'official_analysis' }
    ];
    const COMMON_DVORAK_AGENCIES = DVORAK_AGENCY_CATALOG.map(agency => agency.id);
    const DVORAK_AGENCY_INFO = Object.fromEntries(
        DVORAK_AGENCY_CATALOG.map(agency => [agency.id, agency.label])
    );
    
    // === Cache Busting for API Calls ===
    const BUILD_TIMESTAMP = Date.now();
    
    // === Auto-Retry Configuration ===
    const RETRY_CONFIG = {
        maxAttempts: 5,
        initialDelay: 5000,      // 5 seconds
        maxDelay: 30000,         // 30 seconds max
        backoffMultiplier: 1.5,  // exponential backoff
        currentAttempt: 0,
        retryTimer: null
    };
    
    // === State Management ===
    const state = {
        storms: [],
        activeStorm: null,
        activeStormData: null,
        products: [],
        platforms: [],
        sensors: [],
        products_list: [],
        selectedPlatforms: [],
        selectedSensors: [],
        selectedProducts: [],
        currentOffset: 0,
        pageSize: 36,
        totalProducts: 0,
        isLoading: false,
        isLoadingMore: false,
        viewMode: 'grid',
        sortOrder: 'desc',
        filtersOpen: false,
        currentYear: new Date().getFullYear(),
        modalOpen: false,
        modalIndex: 0,
        loadedImages: new Set(),
        lastUpdated: null,
        dvorakRequestId: 0,
        dvorakLoading: false,
        // Track latest update time per platform/sensor/product
        freshness: {
            platforms: {},  // { platformName: timestamp }
            sensors: {},    // { sensorName: timestamp }
            products: {}    // { productName: timestamp }
        }
    };

    // === Constants ===
    const MICROWAVE_SENSORS = new Set([
        'ssmis', 'gmi', 'atms', 'amsu-a_mhs', 'mhs', 'mwr',
        'ascat', 'ascatuhr', 'smap-spd', 'smos-spd', 'sar-spd',
        'mwi', 'oscat'
    ]);

    const MICROWAVE_PLATFORMS = new Set([
        'F16', 'F17', 'F18', 'GPM', 'metop-b', 'metop-c',
        'noaa-20', 'NOAA-20', 'noaa-21', 'NOAA-21', 'npp',
        'Suomi-NPP', 'smap', 'smos', 'rcm-3', 'oceansat-3'
    ]);

    const MICROWAVE_PRODUCTS = new Set([
        'TB165', 'TB180', 'TB325-1', 'TB50', 'TB89', '150H', '183-1H',
        '183-3H', '190V', '37H', '37H-Physical', '37V', '91H', '91H-Physical',
        '91HW', '91pct', 'color37', 'color91', '37H-Legacy', '89H',
        '89H-Physical', '89HW', '89pct', 'color89', 'Rain', 'RainRate',
        'windspeed', 'nrcs', '157V', '89V', '165H', '183H', '37pct',
        '89V-Physical', '91V-Physical'
    ]);

    const STORM_ICONS = {
        'HU': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_HU_Symbol.webp',
        'TY': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_HU_Symbol.webp',
        'ST': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_HU_Symbol.webp',
        'TC': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_HU_Symbol.webp',
        'TS': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_TS_Symbol.webp',
        'SS': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_TS_Symbol.webp',
        'TD': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_TD_Symbol.webp',
        'SD': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_TD_Symbol.webp',
        'DB': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_High_Chance_Symbol.webp',
        'LO': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/Low_pressure_symbol.svg',
        'WV': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_Low_Chance_Symbol.webp',
        'EX': 'https://science.nrlmry.navy.mil/geoips/tcweb4/assets/NHC_Low_Chance_Symbol.webp'
    };

    const TYPE_NAMES = {
        'HU': 'Hurricane', 'TY': 'Typhoon', 'ST': 'Super Typhoon',
        'TC': 'Cyclone', 'TS': 'Trop Storm', 'SS': 'Subtro Storm',
        'TD': 'Trop Dep', 'SD': 'Subtro Dep', 'DB': 'Disturbance',
        'LO': 'Low', 'WV': 'Wave', 'EX': 'Extra-Trop', 'MD': 'Monsoon'
    };

    const TYPE_COLORS = {
        'HU': '#ef4444', 'TY': '#ef4444', 'ST': '#ef4444', 'TC': '#ef4444',
        'TS': '#f59e0b', 'SS': '#f59e0b',
        'TD': '#3b82f6', 'SD': '#3b82f6',
        'DB': '#8b5cf6', 'LO': '#6b7a9e', 'WV': '#06b6d4'
    };

    // Basin code mapping for Invest designation (IO01, WP95 style)
    const INVEST_BASIN_CODES = {
        'AL': 'AL',   // Atlantic
        'EP': 'EP',   // Eastern Pacific
        'CP': 'CP',   // Central Pacific
        'WP': 'WP',   // Western Pacific
        'NI': 'IO',   // North Indian → IO
        'SI': 'IO',   // South Indian → IO
        'SP': 'SP',   // South Pacific
        'IO': 'IO'    // Indian Ocean → IO
    };

    const BASIN_FULL_NAMES = {
        'AL': 'Atlantic', 'EP': 'E. Pacific', 'CP': 'C. Pacific',
        'WP': 'W. Pacific', 'NI': 'N. Indian Ocean', 'SI': 'S. Indian Ocean',
        'SP': 'S. Pacific', 'IO': 'Indian Ocean', 'B': 'Bay of Bengal'
    };

    // === DOM Cache ===
    const $ = id => document.getElementById(id);
    let DOM = {};

    function initDOM() {
        DOM = {
            stormGrid: $('stormGrid'),
            gallery: $('gallery'),
            filtersBody: $('filtersBody'),
            filtersToggle: $('filtersToggle'),
            platformChips: $('platformChips'),
            sensorChips: $('sensorChips'),
            productChips: $('productChips'),
            resultCount: $('resultCount'),
            sortSelect: $('sortSelect'),
            viewGridBtn: $('viewGrid'),
            viewListBtn: $('viewList'),
            loadMoreBtn: $('loadMoreBtn'),
            loadMoreContainer: $('loadMoreContainer'),
            modalOverlay: $('imageModal'),
            modalImage: $('modalImage'),
            modalInfo: $('modalInfo'),
            stormCount: $('stormCount'),
            dvorakPanel: $('dvorakPanel'),
            dvorakStatus: $('dvorakStatus'),
            dvorakGrid: $('dvorakGrid'),
            dvorakMeta: $('dvorakMeta'),
            dvorakRefresh: $('dvorakRefresh'),
            cimssPanel: $('cimssPanel'),
            cimssStatus: $('cimssStatus'),
            cimssGrid: $('cimssGrid'),
            cimssMeta: $('cimssMeta')
        };
    }

    // =====================================================
    // INVEST ID PARSING — Extract "92W" from storm_id
    // =====================================================
    function getInvestDesignation(storm) {
        const p = storm.properties;
        const stormId = p.storm_id || '';
        const basin = (p.sub_basin || '').toUpperCase();
        const code = INVEST_BASIN_CODES[basin] || basin;
        
        // Parse invest number from storm_id
        // Patterns: wp9220262026092300 → 92, io012026 → 01, al902026 → 90
        let investNum = '';
        
        if (stormId.length > 4) {
            const match = stormId.match(/^[a-z]{2}(\d{2})/);
            if (match) investNum = match[1];
        }
        
        // If no number found, use fallback
        if (!investNum) investNum = '90';
        
        // Format: IO01, WP95 (code + number)
        return `${code}${investNum}`;
    }

    function getStormDisplayName(storm) {
        const p = storm.properties;
        const name = p.storm_name || 'Unknown';
        
        // For INVEST storms, append designation
        if (name.toUpperCase() === 'INVEST') {
            return `INVEST ${getInvestDesignation(storm)}`;
        }
        // For disturbances with generic names
        if (name.toUpperCase() === 'ONE' || name.toUpperCase() === 'TWO' ||
            name.toUpperCase() === 'THREE' || name.toUpperCase() === 'FOUR' ||
            name.toUpperCase() === 'FIVE' || name.toUpperCase() === 'SIX' ||
            name.toUpperCase() === 'SEVEN' || name.toUpperCase() === 'EIGHT' ||
            name.toUpperCase() === 'NINE') {
            return `${name} ${getInvestDesignation(storm)}`;
        }
        return name;
    }

    // =====================================================
    // API Calls
    // =====================================================
    async function fetchJSON(url) {
        // Add cache-busting timestamp to every API request
        const separator = url.includes('?') ? '&' : '?';
        const cacheBustedUrl = url + separator + '_t=' + Date.now();
        
        const resp = await fetch(cacheBustedUrl, { 
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    async function loadActiveStorms(showLoading = true) {
        try {
            if (showLoading) {
                showStormLoading();
            }
            const data = await fetchJSON(`${API_BASE}/active-storms`);
            state.storms = data.features || [];
            renderStorms();
            updateStormCount();
            // Reset retry on success
            RETRY_CONFIG.currentAttempt = 0;
            if (RETRY_CONFIG.retryTimer) {
                clearTimeout(RETRY_CONFIG.retryTimer);
                RETRY_CONFIG.retryTimer = null;
            }
            if (state.storms.length > 0 && !state.activeStorm) {
                selectStorm(state.storms[0]);
            }
        } catch (err) {
            console.error('Failed to load storms:', err);
            RETRY_CONFIG.currentAttempt++;
            showStormError();
            // Auto-retry with exponential backoff
            if (RETRY_CONFIG.currentAttempt <= RETRY_CONFIG.maxAttempts) {
                const delay = Math.min(
                    RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, RETRY_CONFIG.currentAttempt - 1),
                    RETRY_CONFIG.maxDelay
                );
                console.log(`Retrying in ${Math.round(delay/1000)}s (attempt ${RETRY_CONFIG.currentAttempt}/${RETRY_CONFIG.maxAttempts})`);
                updateRetryStatus(delay);
                RETRY_CONFIG.retryTimer = setTimeout(() => loadActiveStorms(false), delay);
            } else {
                showStormErrorFinal();
            }
        }
    }

    async function loadFilters(stormId) {
        try {
            // Load platforms/sensors/products list AND summary in parallel
            const [listData, summaryData] = await Promise.all([
                fetchJSON(`${API_BASE}/storms/${stormId}/platform-sensor-products`),
                fetchJSON(`${API_BASE}/products/summary/${stormId}`).catch(() => null)
            ]);

            state.platforms = listData.platforms || [];
            state.sensors = listData.sensors || [];
            state.products_list = listData.products || [];

            // Build freshness map from summary
            state.freshness = { platforms: {}, sensors: {}, products: {} };
            if (summaryData && summaryData.platforms) {
                summaryData.platforms.forEach(platform => {
                    const pName = platform.platform;
                    const pTs = parseDateUTC(platform.latest_datetime);
                    if (pTs) state.freshness.platforms[pName] = pTs;

                    (platform.sensors || []).forEach(sensor => {
                        const sName = sensor.sensor;
                        const sTs = parseDateUTC(sensor.latest_datetime);
                        if (sTs) state.freshness.sensors[sName] = sTs;

                        (sensor.products || []).forEach(product => {
                            const prodName = product.product;
                            const prodTs = parseDateUTC(product.latest_datetime);
                            if (prodTs) {
                                const existing = state.freshness.products[prodName];
                                state.freshness.products[prodName] = existing
                                    ? Math.max(existing, prodTs)
                                    : prodTs;
                            }
                        });
                    });
                });
            }

            // Now render filters with complete freshness data
            renderFilters();
        } catch (err) {
            console.error('Failed to load filters:', err);
        }
    }

    async function loadProducts(append = false) {
        if (!state.activeStorm) return;

        if (append) {
            if (state.isLoadingMore) return;
            state.isLoadingMore = true;
            updateLoadMoreBtn(true);
        } else {
            state.isLoading = true;
            state.currentOffset = 0;
            state.products = [];
            state.loadedImages.clear();
            showLoading();
        }

        try {
            let url = `${API_BASE}/products/${state.currentYear}?storm_id=${state.activeStorm}&limit=${state.pageSize}&offset=${state.currentOffset}&sort_order=${state.sortOrder}`;
            
            state.selectedPlatforms.forEach(p => url += `&platform=${encodeURIComponent(p)}`);
            state.selectedSensors.forEach(s => url += `&sensor=${encodeURIComponent(s)}`);
            state.selectedProducts.forEach(p => url += `&product=${encodeURIComponent(p)}`);

            const data = await fetchJSON(url);
            const newProducts = data.products || [];

            if (append) {
                state.products = state.products.concat(newProducts);
            } else {
                state.products = newProducts;
            }

            state.totalProducts = data.page ? data.page.total : 0;
            state.currentOffset += state.pageSize;

            renderGallery(append, newProducts);
            updateResultCount();
            updateLoadMoreVisibility();
            // Update using active storm's NRL analysis time
            updateLastUpdated(state.activeStormData);
        } catch (err) {
            console.error('Failed to load products:', err);
            if (!append) showEmpty();
        } finally {
            state.isLoading = false;
            state.isLoadingMore = false;
            updateLoadMoreBtn(false);
        }
    }

    // =====================================================
    // Render Functions
    // =====================================================
    function renderStorms() {
        if (!DOM.stormGrid) return;
        
        const html = state.storms.map(storm => {
            const p = storm.properties;
            const type = (p.storm_type || 'XX').toUpperCase();
            const icon = STORM_ICONS[type] || STORM_ICONS['DB'];
            const typeName = TYPE_NAMES[type] || type;
            const isActive = state.activeStorm === p.storm_id;
            const color = TYPE_COLORS[type] || '#6b7a9e';
            const displayName = getStormDisplayName(storm);
            
            return `<div class="storm-card${isActive ? ' active' : ''}" data-sid="${esc(p.storm_id)}" style="--card-accent:${color}">
                <div class="storm-card-header">
                    <img class="storm-icon" src="${icon}" alt="${typeName}" loading="lazy" onerror="this.style.display='none'">
                    <span class="storm-name">${esc(displayName)}</span>
                </div>
                <span class="storm-type ${getTypeClass(type)}">${typeName}</span>
                <div class="storm-meta" style="margin-top:6px">
                    <span>💨 ${p.vmax || '?'} kt</span>
                    <span>📊 ${p.pressure || '?'} mb</span>
                </div>
            </div>`;
        }).join('');
        
        DOM.stormGrid.innerHTML = html;
        
        DOM.stormGrid.querySelectorAll('.storm-card').forEach(card => {
            card.addEventListener('click', () => {
                const storm = state.storms.find(s => s.properties.storm_id === card.dataset.sid);
                if (storm) selectStorm(storm);
            });
        });
    }

    function renderFilters() {
        if (!DOM.platformChips) return;

        const makeChip = (name, type, isMW, ts) => {
            const active = (type === 'platform' ? state.selectedPlatforms :
                           type === 'sensor' ? state.selectedSensors :
                           state.selectedProducts).includes(name);
            const ageClass = getAgeClass(ts);
            const tooltip = ts ? `${name} (${formatAgeLabel(ts)})` : name;
            return `<span class="filter-chip${ageClass ? ' freshness-' + ageClass : ''}${isMW ? ' microwave' : ''}${active ? ' active' : ''}" data-t="${type}" data-v="${esc(name)}" title="${esc(tooltip)}">${esc(name)}</span>`;
        };

        DOM.platformChips.innerHTML = state.platforms.map(p =>
            makeChip(p, 'platform', MICROWAVE_PLATFORMS.has(p), state.freshness.platforms[p])
        ).join('');

        DOM.sensorChips.innerHTML = state.sensors.map(s =>
            makeChip(s, 'sensor', MICROWAVE_SENSORS.has(s), state.freshness.sensors[s])
        ).join('');

        DOM.productChips.innerHTML = state.products_list.map(p =>
            makeChip(p, 'product', MICROWAVE_PRODUCTS.has(p), state.freshness.products[p])
        ).join('');

        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                toggleFilter(chip.dataset.t, chip.dataset.v);
                chip.classList.toggle('active');
            });
        });
    }

    // Format age label for tooltip
    function formatAgeLabel(timestamp) {
        const diffHours = (Date.now() - timestamp) / (1000 * 60 * 60);
        const diffMins = Math.round((Date.now() - timestamp) / (1000 * 60));
        if (diffHours < 1) return `${diffMins}m ago`;
        if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
        return `${Math.floor(diffHours / 24)}d ago`;
    }

    function renderGallery(append, newProducts) {
        if (!DOM.gallery) return;
        if (!append) DOM.gallery.innerHTML = '';

        const fragment = document.createDocumentFragment();
        const startIdx = append ? state.products.length - newProducts.length : 0;

        newProducts.forEach((product, i) => {
            const el = createGalleryItem(product, startIdx + i);
            fragment.appendChild(el);
        });

        DOM.gallery.appendChild(fragment);
    }

    function createGalleryItem(product, index) {
        const div = document.createElement('div');
        div.className = 'gallery-item';
        div.style.animationDelay = `${(index % 12) * 0.04}s`;
        div.dataset.idx = index;

        const imgUrl = product.product_url;
        const date = formatDate(product.product_date);
        const title = `${product.platform} / ${product.sensor} — ${product.product}`;

        div.innerHTML = `
            <div class="gallery-item-image">
                <img src="${imgUrl}" alt="${esc(title)}" loading="lazy" decoding="async">
                <div class="gallery-item-overlay">
                    <div class="zoom-icon">
                        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                            <path d="M11 8v6M8 11h6"/>
                        </svg>
                    </div>
                </div>
            </div>
            <div class="gallery-item-info">
                <div class="gallery-item-title" title="${esc(title)}">${esc(title)}</div>
                <div class="gallery-item-meta">
                    <span class="meta-tag platform">${esc(product.platform)}</span>
                    <span class="meta-tag sensor">${esc(product.sensor)}</span>
                    <span class="meta-tag product">${esc(product.product)}</span>
                </div>
                <div class="gallery-item-meta" style="margin-top:4px">
                    <span class="meta-tag date">${date}</span>
                    ${product.coverage ? `<span class="meta-tag" style="background:rgba(16,185,129,.15);color:var(--accent-green)">${product.coverage}% cov</span>` : ''}
                </div>
            </div>`;

        const img = div.querySelector('img');
        img.addEventListener('error', () => {
            img.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;position:absolute;inset:0;color:var(--text-muted);font-size:.8rem;background:var(--bg-secondary)">⚠ Image unavailable</div>';
        });

        div.addEventListener('click', () => openModal(index));
        return div;
    }

    function showLoading() {
        if (!DOM.gallery) return;
        DOM.gallery.innerHTML = `
            <div class="loading-container" style="grid-column:1/-1">
                <div class="loading-spinner"></div>
                <div class="loading-text">Loading satellite imagery...</div>
            </div>`;
    }

    function showEmpty() {
        if (!DOM.gallery) return;
        DOM.gallery.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1">
                <svg class="empty-state-icon" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z"/>
                </svg>
                <h3 class="empty-state-title">No Images Found</h3>
                <p class="empty-state-desc">Try adjusting filters or selecting a different storm.</p>
            </div>`;
    }

    function showStormLoading() {
        if (!DOM.stormGrid) return;
        DOM.stormGrid.innerHTML = `
            <div class="loading-container" style="grid-column:1/-1">
                <div class="loading-spinner"></div>
                <div class="loading-text">Connecting to NRL server...</div>
            </div>`;
    }

    function showStormError() {
        if (!DOM.stormGrid) return;
        DOM.stormGrid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1">
                <svg class="empty-state-icon" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                </svg>
                <h3 class="empty-state-title">NRL Server Unavailable</h3>
                <p class="empty-state-desc">The U.S. Naval Research Laboratory server is temporarily down. We're automatically retrying...</p>
                <div id="retryStatus" style="margin-top:12px;font-size:0.85rem;color:var(--accent-cyan);"></div>
                <button class="btn btn-primary" style="margin-top:16px;padding:10px 24px;" onclick="(function(){clearTimeout(window.__retryTimer);loadActiveStorms();})()">
                     Retry Now
                </button>
            </div>`;
    }

    function updateRetryStatus(delaySec) {
        const el = document.getElementById('retryStatus');
        if (el) {
            el.textContent = `Next retry in ${Math.round(delaySec/1000)}s (attempt ${RETRY_CONFIG.currentAttempt}/${RETRY_CONFIG.maxAttempts})`;
        }
    }

    function showStormErrorFinal() {
        if (!DOM.stormGrid) return;
        DOM.stormGrid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1">
                <svg class="empty-state-icon" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                </svg>
                <h3 class="empty-state-title">Still Unable to Connect</h3>
                <p class="empty-state-desc">The NRL server has been unavailable for an extended period. Please check back later or try refreshing the page.</p>
                <button class="btn btn-primary" style="margin-top:16px;padding:10px 24px;" onclick="(function(){RETRY_CONFIG.currentAttempt=0;loadActiveStorms();})()">
                    🔄 Try Again
                </button>
            </div>`;
    }

    // =====================================================
    // Storm Banner — Dynamic with Invest ID & Last Updated
    // =====================================================
    function getDisplayStormId(storm) {
        const p = storm.properties;
        const stormId = p.storm_id || '';
        const basin = (p.sub_basin || '').toUpperCase();
        const code = INVEST_BASIN_CODES[basin] || basin;
        
        // Extract invest number (2 digits after basin code)
        let investNum = '';
        const match = stormId.match(/^[a-z]{2}(\d{2})/);
        if (match) investNum = match[1];
        if (!investNum) investNum = '90';
        
        // Extract year from storm_id (4 digits after the invest number)
        let year = '';
        const yearMatch = stormId.match(/^[a-z]{2}\d{2}(\d{4})/);
        if (yearMatch) year = yearMatch[1];
        if (!year) year = new Date().getFullYear();
        
        // Format: WP952026 (CODE + NUMBER + YEAR)
        return code + investNum + year;
    }

function updateStormBanner(storm) {
        const banner = $('stormBanner');
        const icon = $('stormBannerIcon');
        const name = $('stormBannerName');
        const details = $('stormBannerDetails');
        if (!banner) return;

        state.activeStormData = storm;
        const p = storm.properties;
        const type = (p.storm_type || 'XX').toUpperCase();
        const typeName = TYPE_NAMES[type] || type;
        const iconUrl = STORM_ICONS[type] || STORM_ICONS['DB'];

        // Dynamic display name with Invest designation
        const displayName = getStormDisplayName(storm);
        
        icon.src = iconUrl;
        icon.alt = typeName;
        name.innerHTML = `<span class="storm-banner-type-badge" style="background:${TYPE_COLORS[type] || '#6b7a9e'}20;color:${TYPE_COLORS[type] || '#6b7a9e'}">${typeName}</span> ${esc(displayName)}`;
        
        const basin = BASIN_FULL_NAMES[(p.sub_basin || '').toUpperCase()] || p.sub_basin || '';
        const latDir = p.center_latitude >= 0 ? 'N' : 'S';
        const lonDir = (p.center_longitude || 0) >= 0 ? 'E' : 'W';
        
        details.innerHTML = `
            <span class="storm-banner-stat">💨 Wind: <span class="value">${p.vmax || '?'} kt</span></span>
            <span class="storm-banner-stat">📊 Pressure: <span class="value">${p.pressure || '?'} mb</span></span>
            <span class="storm-banner-stat">📍 ${Math.abs(p.center_latitude || 0).toFixed(1)}°${latDir}, ${Math.abs(p.center_longitude || 0).toFixed(1)}°${lonDir}</span>
            <span class="storm-banner-stat">🌊 Basin: <span class="value">${basin}</span></span>
            <span class="storm-banner-stat storm-banner-id">🆔 ${esc(getDisplayStormId(storm))}</span>
        `;
        
        banner.style.display = 'flex';
        
        // Pass storm data to updateLastUpdated for NRL analysis timestamp
        updateLastUpdated(storm);
    }

    function updateLastUpdated(storm) {
        const el = $('lastUpdated');
        if (!el) return;
        
        // Use NRL's latest analysis timestamp from storm data
        // start_date: "20260925", start_time: "1200"
        let nrlTime = null;
        if (storm && storm.properties) {
            const p = storm.properties;
            const dateStr = p.start_date || '';   // "20260925"
            const timeStr = p.start_time || '';   // "1200"
            
            if (dateStr.length === 8 && timeStr.length >= 4) {
                const yr = dateStr.slice(0, 4);
                const mo = dateStr.slice(4, 6);
                const dy = dateStr.slice(6, 8);
                const hr = timeStr.slice(0, 2);
                const mn = timeStr.slice(2, 4);
                const sec = timeStr.length >= 6 ? timeStr.slice(4, 6) : '00';
                nrlTime = new Date(`${yr}-${mo}-${dy}T${hr}:${mn}:${sec}Z`);
            }
        }
        
        if (nrlTime && !isNaN(nrlTime.getTime())) {
            const zuluHour = String(nrlTime.getUTCHours()).padStart(2, '0') + 'z';
            const day = String(nrlTime.getUTCDate()).padStart(2, '0');
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const monthStr = months[nrlTime.getUTCMonth()];
            const year = nrlTime.getUTCFullYear();
            el.innerHTML = `
                <span class="last-updated-icon"></span>
                <span class="last-updated-text">
                    <strong>Updated:</strong> ${zuluHour}, ${day} ${monthStr} ${year}
                </span>
            `;
            el.style.display = 'flex';
        } else {
            // Fallback to local load time
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            }) + ' UTC';
            const dateStr = now.toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric'
            });
            el.innerHTML = `
                <span class="last-updated-icon">🕐</span>
                <span class="last-updated-text">
                    <strong>Last Updated:</strong> ${dateStr} ${timeStr}
                </span>
            `;
            el.style.display = 'flex';
        }
    }

    // =====================================================
    // Agency Dvorak Fixes — independent official agency publications
    // =====================================================
    function getDvorakStormParams(storm) {
        const p = storm?.properties || {};
        return new URLSearchParams({
            storm_id: p.storm_id || '',
            storm_name: p.storm_name || '',
            basin: p.sub_basin || '',
            lat: Number.isFinite(Number(p.center_latitude)) ? String(p.center_latitude) : '',
            lon: Number.isFinite(Number(p.center_longitude)) ? String(p.center_longitude) : ''
        });
    }

    function setDvorakLoading(isLoading) {
        state.dvorakLoading = isLoading;
        if (DOM.dvorakRefresh) {
            DOM.dvorakRefresh.disabled = isLoading || !state.activeStormData;
            DOM.dvorakRefresh.classList.toggle('is-loading', isLoading);
        }
    }

    function showDvorakLoading(storm) {
        if (!DOM.dvorakGrid) return;
        const displayName = getStormDisplayName(storm);
        DOM.dvorakPanel?.classList.remove('has-error');
        DOM.dvorakPanel?.classList.add('is-loading');
        DOM.dvorakStatus.textContent = `Loading the latest official agency fixes for ${displayName}…`;
        DOM.dvorakGrid.className = 'dvorak-fix-grid is-loading';
        DOM.dvorakGrid.innerHTML = Array.from({ length: 4 }, () => `
            <div class="dvorak-card dvorak-card-skeleton" aria-hidden="true">
                <span></span><strong></strong><i></i>
            </div>`).join('');
        if (DOM.dvorakMeta) {
            DOM.dvorakMeta.innerHTML = '<span class="dvorak-source-note">Checking each agency’s own official publication…</span>';
        }
    }

    function formatDvorakFetched(value) {
        const ts = parseDateUTC(value);
        if (!ts) return '';
        return new Date(ts).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            hour12: false, timeZone: 'UTC'
        }) + ' UTC';
    }

    function getDvorakAgencyLabel(agency, agencyInfo = DVORAK_AGENCY_INFO) {
        return agencyInfo[agency] || DVORAK_AGENCY_INFO[agency] || agency;
    }

    function getDvorakAgencyCatalog(data) {
        if (!Array.isArray(data?.agency_catalog) || !data.agency_catalog.length) {
            return DVORAK_AGENCY_CATALOG;
        }
        const localById = Object.fromEntries(DVORAK_AGENCY_CATALOG.map(item => [item.id, item]));
        const catalog = data.agency_catalog
            .filter(item => item && /^[A-Z0-9-]{2,18}$/.test(String(item.id || '').toUpperCase()))
            .map(item => {
                const id = String(item.id).toUpperCase();
                const local = localById[id] || {};
                return {
                    ...local,
                    id,
                    label: String(item.label || local.label || item.id).slice(0, 80),
                    source_label: String(item.source_label || local.source_label || '').slice(0, 120),
                    source_url: typeof item.source_url === 'string' ? item.source_url : (local.source_url || ''),
                    analysis_kind: item.analysis_kind || local.analysis_kind || 'official_analysis'
                };
            });
        return catalog.length ? catalog : DVORAK_AGENCY_CATALOG;
    }

    function isOfficialSourceURL(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && /(?:\.gov(?:\.[a-z]{2})?$|\.mil$|\.dost\.gov\.ph$|\.go\.kr$|\.go\.jp$|\.gov\.tw$|\.nmc\.cn$|\.imd\.gov\.in$|\.bom\.gov\.au$|meteofrance\.re$)/i.test(url.hostname);
        } catch {
            return false;
        }
    }

    function agencyValueLabel(fix) {
        if (!fix) return 'Not reported';
        if (Number.isFinite(fix.knots)) return `${fix.knots} <small>kt</small>`;
        if (Number.isFinite(fix.wind_ms)) return `${fix.wind_ms} <small>m/s</small>`;
        if (Number.isFinite(fix.wind_kmh)) return `${fix.wind_kmh} <small>km/h</small>`;
        if (Number.isFinite(fix.pressure_hpa)) return `${fix.pressure_hpa} <small>hPa</small>`;
        return 'Published analysis';
    }

    function createDvorakCard(agency, fix, agencyMeta, status) {
        const hasFix = Boolean(fix && (fix.t_number || Number.isFinite(fix.knots) || Number.isFinite(fix.wind_ms)
            || Number.isFinite(fix.wind_kmh) || Number.isFinite(fix.pressure_hpa) || fix.intensity_label));
        const primary = hasFix ? esc(fix.t_number || fix.intensity_label || 'Analysis') : '—';
        const value = hasFix ? agencyValueLabel(fix) : 'No current value';
        const kind = fix?.analysis_kind || agencyMeta?.analysis_kind || 'official_analysis';
        const kindLabel = kind === 'dvorak' ? 'Dvorak fix' : 'Official analysis';
        const time = hasFix && fix.time ? `Valid ${esc(fix.time)}` :
            hasFix ? kindLabel : (status?.message || 'No agency publication matched this storm');
        const source = fix?.source || status?.source || agencyMeta?.source_url || '';
        const sourceLabel = fix?.source_label || status?.source_label || agencyMeta?.source_label || 'Official source';
        const sourceLink = isOfficialSourceURL(source)
            ? `<a class="dvorak-card-source" href="${esc(source)}" target="_blank" rel="noopener">${esc(sourceLabel)} ↗</a>`
            : `<span class="dvorak-card-source">${esc(sourceLabel)}</span>`;
        const title = hasFix && fix.raw ? ` title="${esc(fix.raw)}"` : '';
        return `
            <article class="dvorak-card${hasFix ? '' : ' is-unavailable'}"${title}>
                <div class="dvorak-card-top">
                    <span class="dvorak-agency-code">${esc(agency)}</span>
                    <span class="dvorak-agency-name">${esc(agencyMeta?.label || getDvorakAgencyLabel(agency))}</span>
                </div>
                <div class="dvorak-values">
                    <strong class="dvorak-t-number${kind === 'dvorak' ? '' : ' is-analysis'}">${primary}</strong>
                    <span class="dvorak-wind">${value}</span>
                </div>
                <span class="dvorak-card-time">${time}</span>
                ${sourceLink}
            </article>`;
    }

    // UW–CIMSS cards are deliberately data-driven. The service returns every
    // numeric field exposed by its live storm summary; it is never folded into
    // the human-agency Dvorak cards above.
    function isCimssSourceURL(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && /(^|\.)tropic\.ssec\.wisc\.edu$/i.test(url.hostname);
        } catch {
            return false;
        }
    }

    function showCimssLoading(storm) {
        if (!DOM.cimssGrid) return;
        DOM.cimssPanel?.classList.remove('has-error');
        DOM.cimssPanel?.classList.add('is-loading');
        DOM.cimssStatus.textContent = `Loading currently available UW–CIMSS objective products for ${getStormDisplayName(storm)}…`;
        DOM.cimssGrid.className = 'cimss-product-grid is-loading';
        DOM.cimssGrid.innerHTML = Array.from({ length: 4 }, () => `
            <div class="cimss-product-card cimss-skeleton" aria-hidden="true"><span></span><strong></strong><i></i>
            </div>`).join('');
        if (DOM.cimssMeta) DOM.cimssMeta.textContent = 'Checking the CIMSS real-time storm summary and linked numerical-product details…';
    }

    function renderCimssUnavailable(cimss, storm) {
        if (!DOM.cimssGrid) return;
        DOM.cimssPanel?.classList.remove('is-loading');
        DOM.cimssPanel?.classList.add('has-error');
        DOM.cimssStatus.textContent = `No current CIMSS objective product summary is available for ${getStormDisplayName(storm)}.`;
        DOM.cimssGrid.className = 'cimss-product-grid is-unavailable';
        DOM.cimssGrid.innerHTML = `<div class="cimss-empty cimss-empty-warning"><strong>CIMSS products unavailable for this storm</strong><span>${esc(cimss?.message || 'CIMSS may not publish every automated product for every storm, time, basin, or satellite pass.')}</span></div>`;
        if (DOM.cimssMeta) {
            const source = isCimssSourceURL(cimss?.source) ? `<a href="${esc(cimss.source)}" target="_blank" rel="noopener">Open CIMSS storm summary ↗</a>` : '';
            DOM.cimssMeta.innerHTML = `<span>Automated satellite guidance remains separate from agency analyst fixes. ${source}</span>`;
        }
    }

    function createCimssCard(product) {
        const metrics = Array.isArray(product?.metrics) ? product.metrics.filter(metric => metric && metric.label && metric.value) : [];
        const link = isCimssSourceURL(product?.source)
            ? `<a class="cimss-card-link" href="${esc(product.source)}" target="_blank" rel="noopener">Open CIMSS product ↗</a>`
            : '';
        const observed = product?.observed_at ? `<span class="cimss-time">${esc(product.observed_at)}</span>` : '';
        return `<article class="cimss-product-card">
            <div class="cimss-card-top"><h3>${esc(product?.label || product?.id || 'CIMSS product')}</h3>${observed}</div>
            ${product?.description ? `<p>${esc(product.description)}</p>` : ''}
            <dl class="cimss-metrics">${metrics.map(metric => `<div><dt>${esc(metric.label)}</dt><dd>${esc(metric.value)}</dd></div>`).join('')}</dl>
            ${link}
        </article>`;
    }

    function renderCimssProducts(cimss, storm) {
        if (!DOM.cimssGrid) return;
        const products = Array.isArray(cimss?.products) ? cimss.products : [];
        if (!cimss || cimss.status !== 'ok' || !products.length) {
            renderCimssUnavailable(cimss, storm);
            return;
        }
        DOM.cimssPanel?.classList.remove('is-loading', 'has-error');
        DOM.cimssStatus.textContent = `${getStormDisplayName(storm)} • ${products.length} currently published CIMSS objective product${products.length === 1 ? '' : 's'}`;
        DOM.cimssGrid.className = 'cimss-product-grid';
        DOM.cimssGrid.innerHTML = products.map(createCimssCard).join('');
        const checked = formatDvorakFetched(cimss.fetched_at);
        const summary = isCimssSourceURL(cimss.source) ? `<a href="${esc(cimss.source)}" target="_blank" rel="noopener">CIMSS live storm summary ↗</a>` : 'CIMSS live storm summary';
        if (DOM.cimssMeta) DOM.cimssMeta.innerHTML = `<span>Objective algorithms, not human agency Dvorak fixes · ${summary}${checked ? ` · checked ${esc(checked)}` : ''}. Availability changes with the active CIMSS publication, satellite coverage, and processing.</span>`;
    }

    function renderDvorakUnavailable(data, storm) {
        if (!DOM.dvorakGrid) return;
        const displayName = getStormDisplayName(storm);
        DOM.dvorakPanel?.classList.remove('is-loading');
        DOM.dvorakPanel?.classList.add('has-error');
        DOM.dvorakStatus.textContent = `No live agency table is available for ${displayName} right now.`;
        DOM.dvorakGrid.className = 'dvorak-fix-grid is-unavailable';
        DOM.dvorakGrid.innerHTML = `
            <div class="dvorak-empty dvorak-empty-warning">
                <span class="dvorak-empty-icon">!</span>
                <div>
                    <strong>Official fixes not published</strong>
                    <span>${esc(data?.message || 'The latest official Dvorak table is not available yet.')}</span>
                </div>
            </div>`;
        if (DOM.dvorakMeta) {
            DOM.dvorakMeta.innerHTML = '<span class="dvorak-source-note">No values are estimated, substituted, or carried over from an older advisory.</span>';
        }
    }

    function renderDvorakFixes(data, storm) {
        if (!DOM.dvorakGrid) return;
        // Even when no centre has a matching value, keep every agency card
        // visible with its own source link and a precise status. This makes it
        // clear that no JTWC value is being substituted behind the scenes.
        if (!data || !Array.isArray(data.agency_catalog)) {
            renderDvorakUnavailable(data, storm);
            return;
        }
        const hasPublishedValues = data.status === 'ok';
        const fixes = Array.isArray(data.agencies) ? data.agencies : [];
        const byAgency = new Map(fixes
            .filter(fix => fix && fix.agency)
            .map(fix => [String(fix.agency).toUpperCase(), fix]));
        const agencyCatalog = getDvorakAgencyCatalog(data);
        const catalogById = new Map(agencyCatalog.map(item => [item.id, item]));
        const statuses = new Map((Array.isArray(data.agency_statuses) ? data.agency_statuses : [])
            .filter(item => item && item.agency)
            .map(item => [String(item.agency).toUpperCase(), item]));
        const listedAgencies = agencyCatalog.map(item => item.id);
        const agencyOrder = [...listedAgencies, ...fixes.map(fix => String(fix.agency || '').toUpperCase())
            .filter(agency => agency && !listedAgencies.includes(agency))];

        DOM.dvorakPanel?.classList.remove('is-loading');
        DOM.dvorakPanel?.classList.toggle('has-error', !hasPublishedValues);
        DOM.dvorakStatus.textContent = data.stale
            ? `${getStormDisplayName(storm)} • Last agency-published estimates (live source unreachable)`
            : hasPublishedValues
                ? `${getStormDisplayName(storm)} • Independent official agency analyses`
                : `${getStormDisplayName(storm)} • No matching agency publication is available right now`;
        DOM.dvorakGrid.className = 'dvorak-fix-grid';
        DOM.dvorakGrid.innerHTML = agencyOrder.map(agency => createDvorakCard(
            agency,
            byAgency.get(agency),
            catalogById.get(agency) || { id: agency, label: getDvorakAgencyLabel(agency) },
            statuses.get(agency)
        )).join('');

        const fetched = formatDvorakFetched(data.fetched_at);
        const reported = fixes.length;
        const freshnessNote = data.stale
            ? `<span class="dvorak-source-note dvorak-stale-note">⚠ ${esc(data.message || 'Last agency-published values — live sources are unreachable right now.')}</span>`
            : '';
        if (DOM.dvorakMeta) {
            DOM.dvorakMeta.innerHTML = `
                ${freshnessNote}
                <span class="dvorak-source-note">Independent source mode · ${reported} agency-published value${reported === 1 ? '' : 's'}${fetched ? ` · checked ${esc(fetched)}` : ''}. A Dvorak T-number is shown only when that agency publishes one; other cards retain the agency’s operational-analysis unit.</span>`;
        }
    }

    async function loadDvorakFixes(storm, forceRefresh = false, attempt = 1) {
        if (!storm || !DOM.dvorakGrid) return;
        const requestId = ++state.dvorakRequestId;
        const params = getDvorakStormParams(storm);
        if (forceRefresh) params.set('refresh', '1');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        setDvorakLoading(true);
        showDvorakLoading(storm);
        showCimssLoading(storm);

        try {
            const response = await fetch(`${DVORAK_ENDPOINT}?${params.toString()}`, {
                headers: { 'Accept': 'application/json' },
                cache: 'no-store',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (requestId !== state.dvorakRequestId || state.activeStorm !== storm.properties.storm_id) return;
            renderDvorakFixes(data, storm);
            renderCimssProducts(data.cimss, storm);
        } catch (error) {
            if (requestId !== state.dvorakRequestId) return;
            console.warn('Unable to load live Dvorak fixes:', error);
            // The endpoint already fails over across official hosts and mirrors,
            // so a client-side error is usually a transient network blip.
            if (attempt < 3) {
                clearTimeout(timeout);
                setTimeout(() => {
                    if (requestId === state.dvorakRequestId) loadDvorakFixes(storm, forceRefresh, attempt + 1);
                }, attempt * 2000);
                return;
            }
            renderDvorakUnavailable({
                message: 'Every official source and mirror failed from this device. Use Refresh to try again; no estimated values are shown.'
            }, storm);
            renderCimssUnavailable({
                message: 'The combined live-source request did not complete. Use Refresh to try again; no automated value is estimated or carried over.'
            }, storm);
        } finally {
            clearTimeout(timeout);
            if (requestId === state.dvorakRequestId) setDvorakLoading(false);
        }
    }

    // =====================================================
    // Modal
    // =====================================================
    function openModal(index) {
        state.modalOpen = true;
        state.modalIndex = index;
        updateModal();
        DOM.modalOverlay.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function closeModal() {
        state.modalOpen = false;
        DOM.modalOverlay.classList.remove('open');
        document.body.style.overflow = '';
    }

    function updateModal() {
        const p = state.products[state.modalIndex];
        if (!p) return;
        DOM.modalImage.src = p.product_url;
        DOM.modalImage.alt = `${p.platform} ${p.sensor} ${p.product}`;
        DOM.modalInfo.innerHTML = `
            <strong>${esc(p.platform)}</strong> / ${esc(p.sensor)} — ${esc(p.product)}<br>
            <span style="color:var(--text-muted);font-size:.82rem">${formatDate(p.product_date)} | ${state.modalIndex + 1} of ${state.products.length}</span>`;
    }

    function navModal(dir) {
        state.modalIndex = (state.modalIndex + dir + state.products.length) % state.products.length;
        updateModal();
    }

    // =====================================================
    // Actions
    // =====================================================
    function selectStorm(storm) {
        state.activeStorm = storm.properties.storm_id;
        
        DOM.stormGrid.querySelectorAll('.storm-card').forEach(c => {
            c.classList.toggle('active', c.dataset.sid === state.activeStorm);
        });

        updateStormBanner(storm);
        loadDvorakFixes(storm);

        // Reset filters
        state.selectedPlatforms = [];
        state.selectedSensors = [];
        state.selectedProducts = [];

        if (window.innerWidth < 768) {
            DOM.filtersBody.classList.remove('open');
            state.filtersOpen = false;
        }

        loadFilters(state.activeStorm);
        loadProducts(false);
    }

    function toggleFilter(type, value) {
        const arr = type === 'platform' ? state.selectedPlatforms :
                    type === 'sensor' ? state.selectedSensors :
                    state.selectedProducts;
        const idx = arr.indexOf(value);
        idx === -1 ? arr.push(value) : arr.splice(idx, 1);
        loadProducts(false);
    }

    function clearFilters() {
        state.selectedPlatforms = [];
        state.selectedSensors = [];
        state.selectedProducts = [];
        document.querySelectorAll('.filter-chip.active').forEach(c => c.classList.remove('active'));
        loadProducts(false);
    }

    function toggleFilters() {
        state.filtersOpen = !state.filtersOpen;
        DOM.filtersBody.classList.toggle('open', state.filtersOpen);
    }

    function setViewMode(mode) {
        state.viewMode = mode;
        DOM.gallery.className = `gallery ${mode}-view`;
        DOM.viewGridBtn.classList.toggle('active', mode === 'grid');
        DOM.viewListBtn.classList.toggle('active', mode === 'list');
    }

    // =====================================================
    // UI Updates
    // =====================================================
    function updateStormCount() {
        if (DOM.stormCount) DOM.stormCount.textContent = `${state.storms.length} Storms`;
    }

    function updateResultCount() {
        if (DOM.resultCount) {
            DOM.resultCount.innerHTML = `Showing <strong>${state.products.length}</strong> of <strong>${state.totalProducts.toLocaleString()}</strong> images`;
        }
    }

    function updateLoadMoreVisibility() {
        if (!DOM.loadMoreContainer) return;
        const hasMore = state.products.length < state.totalProducts;
        DOM.loadMoreContainer.style.display = hasMore ? 'flex' : 'none';
    }

    function updateLoadMoreBtn(loading) {
        if (!DOM.loadMoreBtn) return;
        DOM.loadMoreBtn.disabled = loading;
        DOM.loadMoreBtn.textContent = loading ? 'Loading...' :
            `Load More (${Math.max(0, state.totalProducts - state.products.length)} remaining)`;
    }

    // =====================================================
    // === UTC Date Parser ===
    // Handles BOTH formats from NRL:
    //   "2026-09-25T16:50:22.134401"  (product_date with T)
    //   "2026-09-25 07:28:14.820000"  (summary latest_datetime with SPACE)
    function parseDateUTC(dateStr) {
        if (!dateStr) return null;
        let d = String(dateStr).trim();
        // Replace space with T for ISO format
        d = d.replace(' ', 'T');
        // Append Z if no timezone present
        if (!/[Zz]$/.test(d) && !/[+\-]\d{2}:?\d{2}$/.test(d)) {
            d = d + 'Z';
        }
        const ts = new Date(d).getTime();
        return isNaN(ts) ? null : ts;
    }

    // Age Info — Color-coded freshness for filter chips
    function getAgeClass(timestamp) {
        if (!timestamp) return '';
        try {
            const diffHours = (Date.now() - timestamp) / (1000 * 60 * 60);
            if (diffHours < 1) return 'fresh';
            if (diffHours < 3) return 'recent';
            if (diffHours < 6) return 'older';
            if (diffHours < 12) return 'stale';
            return 'old';
        } catch { return ''; }
    }

    // Helpers
    // =====================================================
    function esc(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function getTypeClass(type) {
        const t = type.toUpperCase();
        if (['HU','TY','ST','TC'].includes(t)) return 'hu';
        if (['TS','SS'].includes(t)) return 'ts';
        if (['TD','SD'].includes(t)) return 'td';
        if (['DB','LO','WV','MD'].includes(t)) return 'db';
        return 'other';
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            const ts = parseDateUTC(dateStr);
            if (ts === null) return dateStr;
            const d = new Date(ts);
            return d.toLocaleDateString('en-US', {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC'
            }) + ' UTC';
        } catch { return dateStr; }
    }

    // =====================================================
    // Events
    // =====================================================
    function bindEvents() {
        $('filtersToggle')?.addEventListener('click', toggleFilters);
        $('clearFilters')?.addEventListener('click', clearFilters);
        $('closeFiltersBtn')?.addEventListener('click', toggleFilters);

        DOM.sortSelect?.addEventListener('change', e => {
            state.sortOrder = e.target.value;
            loadProducts(false);
        });

        DOM.viewGridBtn?.addEventListener('click', () => setViewMode('grid'));
        DOM.viewListBtn?.addEventListener('click', () => setViewMode('list'));
        DOM.loadMoreBtn?.addEventListener('click', () => loadProducts(true));
        DOM.dvorakRefresh?.addEventListener('click', () => {
            if (state.activeStormData && !state.dvorakLoading) loadDvorakFixes(state.activeStormData, true);
        });

        $('modalClose')?.addEventListener('click', closeModal);
        $('modalPrev')?.addEventListener('click', () => navModal(-1));
        $('modalNext')?.addEventListener('click', () => navModal(1));
        DOM.modalOverlay?.addEventListener('click', e => {
            if (e.target === DOM.modalOverlay) closeModal();
        });

        document.addEventListener('keydown', e => {
            if (state.modalOpen) {
                if (e.key === 'Escape') closeModal();
                if (e.key === 'ArrowLeft') navModal(-1);
                if (e.key === 'ArrowRight') navModal(1);
            }
        });

        // Touch swipe
        let touchStartX = 0;
        DOM.modalOverlay?.addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });
        DOM.modalOverlay?.addEventListener('touchend', e => {
            const diff = e.changedTouches[0].screenX - touchStartX;
            if (Math.abs(diff) > 50) navModal(diff > 0 ? -1 : 1);
        }, { passive: true });

        // Infinite scroll
        let scrollTimer;
        window.addEventListener('scroll', () => {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
                if (state.isLoading || state.isLoadingMore) return;
                if (state.products.length >= state.totalProducts) return;
                if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
                    loadProducts(true);
                }
            }, 150);
        }, { passive: true });
    }

    // =====================================================
    // Init
    // =====================================================
    function init() {
        initDOM();
        bindEvents();
        loadActiveStorms();
    }

    // Cleanup retry timer on page unload
    window.addEventListener('beforeunload', () => {
        if (RETRY_CONFIG.retryTimer) clearTimeout(RETRY_CONFIG.retryTimer);
    });

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();
})();
