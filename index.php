<?php
/**
 * NRL Microwave Satellite Viewer
 * Professional Microwave Satellite Imagery Dashboard
 */

// Send no-cache headers
header("Cache-Control: no-cache, no-store, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="theme-color" content="#0a0e1a">
    <meta name="description" content="Real-time microwave satellite imagery viewer for tropical cyclones and active storms. Professional satellite data visualization.">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    
    <!-- Cache Busting — Always load latest version -->
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate, max-age=0">
    <meta http-equiv="Pragma" content="no-cache">
    <meta http-equiv="Expires" content="0">
    
    <title>🛰️ Microwave Satellite Viewer — NRL Tropical Cyclone</title>
    
    <!-- Preconnect for performance -->
    <link rel="preconnect" href="https://science.nrlmry.navy.mil" crossorigin>
    <link rel="dns-prefetch" href="https://science.nrlmry.navy.mil">
    
    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    
    <link rel="stylesheet" href="style.css">
    <script src="app.js" defer></script>
    
    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛰️</text></svg>">
</head>
<body>
    <!-- Animated Background -->
    <div class="bg-stars"></div>

    <!-- Header -->
    <header class="header">
        <div class="header-inner">
            <div class="logo">
                <div class="logo-icon">🛰️</div>
                <div class="logo-text">
                    <span class="logo-title">Satellite Viewer</span>
                    <span class="logo-subtitle">NRL Tropical Cyclone Data</span>
                </div>
            </div>
            <div class="header-stats">
                <div class="live-badge" id="liveBadge">
                    <span class="live-dot"></span>
                    LIVE
                </div>
                <div class="storm-count-badge" id="stormCount">Loading...</div>
            </div>
        </div>
    </header>

    <!-- Main Content -->
    <main class="main-container" id="mainContent">
        
        <!-- Storm Selector -->
        <section class="storm-selector">
            <h2 class="section-title">
                <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"/>
                </svg>
                Storms
            </h2>
            <div class="storm-grid" id="stormGrid">
                <!-- Storms loaded dynamically -->
                <div class="loading-container" style="grid-column: 1/-1;">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">Fetching active storms...</div>
                </div>
            </div>
        </section>

        <!-- Storm Info Banner -->
        <div class="storm-banner" id="stormBanner" style="display:none;">
            <img class="storm-banner-icon" id="stormBannerIcon" src="" alt="">
            <div class="storm-banner-info">
                <div class="storm-banner-name" id="stormBannerName"></div>
                <div class="storm-banner-details" id="stormBannerDetails"></div>
                <div class="storm-banner-updated" id="lastUpdated" style="display:none;"></div>
            </div>
        </div>


        <!-- Live Agency Satellite Analyses & Dvorak Fixes -->
        <section class="dvorak-section" id="dvorakPanel" aria-labelledby="dvorakTitle" aria-live="polite">
            <div class="dvorak-section-head">
                <div class="dvorak-heading">
                    <div class="dvorak-eyebrow"><span class="dvorak-live-dot"></span> LIVE OFFICIAL ANALYSIS</div>
                    <div>
                        <h2 id="dvorakTitle">Agency Satellite Analyses & Dvorak Fixes</h2>
                        <p id="dvorakStatus">Select a storm to load each agency’s own latest published analysis.</p>
                    </div>
                </div>
                <button class="dvorak-refresh" id="dvorakRefresh" type="button" disabled aria-label="Refresh agency analyses">
                    <svg aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                    Refresh
                </button>
            </div>
            <div class="dvorak-fix-grid is-idle" id="dvorakGrid">
                <div class="dvorak-empty">
                    <span class="dvorak-empty-icon">◌</span>
                    <span>Storm-specific agency analyses will appear here, with a source link on every card.</span>
                </div>
            </div>
            <div class="dvorak-section-foot" id="dvorakMeta">
                <span class="dvorak-source-note">Source: each agency’s own official bulletin, advisory, or satellite analysis — values are never copied between agencies.</span>
            </div>

            <details class="analysis-provenance-note">
                <summary>Why can JTWC list another agency’s T-number?</summary>
                <p>JTWC may receive an analyst estimate through operational exchange (such as WMO/GTS, regional coordination, or direct forecaster communication) and quote it in its prognostic reasoning. That proves JTWC received and reported the line; it does not prove that the named agency publicly published the same value. This panel therefore uses JTWC only for the JTWC card and checks every other agency’s own public product.</p>
            </details>
        </section>



        <!-- UW-CIMSS Objective Satellite Products -->
        <section class="cimss-section" id="cimssPanel" aria-labelledby="cimssTitle" aria-live="polite">
            <div class="cimss-section-head">
                <div>
                    <div class="cimss-eyebrow">UW–CIMSS · OBJECTIVE SATELLITE GUIDANCE</div>
                    <h2 id="cimssTitle">CIMSS Intensity, Position & Structure</h2>
                    <p id="cimssStatus">Select a storm to load numerical fields currently published in the CIMSS product summary.</p>
                </div>
                <a class="cimss-home-link" href="https://tropic.ssec.wisc.edu/" target="_blank" rel="noopener">CIMSS products ↗</a>
            </div>
            <div class="cimss-product-grid is-idle" id="cimssGrid">
                <div class="cimss-empty">ADT, AiDT, D-PRINT, D-MINT, microwave sounders, SATCON, AI-RI, ARCHER, M-PERC and shear fields will appear here when CIMSS publishes a storm summary.</div>
            </div>
            <div class="cimss-section-foot" id="cimssMeta">
                <span>Objective satellite guidance is separate from official human agency analyses and warnings.</span>
            </div>
        </section>

                <!-- Filters Section -->
        <section class="filters-section">
            <button class="filters-toggle" id="filtersToggle">
                <span>
                    <svg style="width:18px;height:18px;vertical-align:middle;margin-right:6px;color:var(--accent-cyan);" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z"/>
                    </svg>
                    Satellite Product Filters
                </span>
                <svg class="filters-toggle-icon" id="filtersToggleIcon" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/>
                </svg>
            </button>
            <div class="filters-body" id="filtersBody">
                <div class="filter-group">
                    <div class="filter-label">📡 Platforms</div>
                    <div class="filter-chips" id="platformChips"></div>
                </div>
                <div class="filter-group">
                    <div class="filter-label">🔭 Sensors</div>
                    <div class="filter-chips" id="sensorChips"></div>
                </div>
                <div class="filter-group">
                    <div class="filter-label">🖼️ Products</div>
                    <div class="filter-chips" id="productChips"></div>
                </div>
                <div class="filter-actions">
                    <button class="btn" id="clearFilters">✕ Clear All</button>
                    <button class="btn btn-primary" onclick="document.getElementById('filtersToggle').click()">Apply & Close</button>
                </div>
            </div>
        </section>

        <!-- Controls Bar -->
        <div class="controls-bar">
            <div class="controls-left">
                <span class="result-count" id="resultCount">Select a storm to view imagery</span>
            </div>
            <div class="controls-right">
                <select class="sort-select" id="sortSelect">
                    <option value="desc">Newest First</option>
                    <option value="asc">Oldest First</option>
                </select>
                <button class="view-btn active" id="viewGrid" data-tooltip="Grid View">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                    </svg>
                </button>
                <button class="view-btn" id="viewList" data-tooltip="List View">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5"/>
                    </svg>
                </button>
            </div>
        </div>

        <!-- Gallery -->
        <div class="gallery grid-view" id="gallery">
            <!-- Images loaded dynamically -->
        </div>

        <!-- Load More -->
        <div class="load-more-container" id="loadMoreContainer" style="display:none;">
            <button class="load-more-btn" id="loadMoreBtn">Load More</button>
        </div>

    </main>

    <!-- Image Modal -->
    <div class="modal-overlay" id="imageModal">
        <div class="modal-content">
            <button class="modal-close" id="modalClose">✕</button>
            <button class="modal-nav prev" id="modalPrev">‹</button>
            <button class="modal-nav next" id="modalNext">›</button>
            <img class="modal-image" id="modalImage" src="" alt="Satellite Image">
            <div class="modal-info" id="modalInfo"></div>
        </div>
    </div>

    <!-- Footer -->
    <footer class="footer">
        <p>Data provided by <a href="https://science.nrlmry.navy.mil/geoips/tcweb4/" target="_blank" rel="noopener">U.S. Naval Research Laboratory</a> — GeoIPS Tropical Cyclone Web</p>
        <p style="margin-top:4px;">Microwave Satellite Viewer &copy; <?php echo date('Y'); ?> | For educational & research purposes</p>
    </footer>

</body>
</html>
