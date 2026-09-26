# 🛰️ Microwave Satellite Viewer

Professional microwave satellite imagery viewer for tropical cyclones and active storms. Fetches real-time data from the U.S. Naval Research Laboratory (NRL) GeoIPS system.

![Status](https://img.shields.io/badge/status-active-success) ![License](https://img.shields.io/badge/license-MIT-blue)

## ✨ Features

- 🌊 **Real-time Data** — Live satellite imagery from NRL's GeoIPS system
- 📱 **Fully Responsive** — Beautiful on mobile, tablet, and desktop
- ⚡ **Lightning Fast** — Lazy loading, smooth animations, optimized performance
- 🔭 **Smart Filtering** — Filter by platform, sensor, and product type
- 🖼️ **Multiple Views** — Grid and list gallery modes
- 🔍 **Image Lightbox** — Full-screen image viewer with keyboard/touch navigation
- 🌙 **Dark Theme** — Professional dark interface designed for satellite imagery
- 📡 **Microwave Focus** — Highlights microwave sensors and products
- 🛟 **Resilient Official Delivery** — short-lived same-origin cache, agency-specific source status, and a clearly labelled last-published fallback
- 📈 **Independent Agency Analyses** — every card reads only its own publisher: JTWC/PGTW reasoning, IMD/DEMS satellite-fix PDFs, JMA/TCAC Tokyo, NHC/TAFB, PAGASA, Taiwan CWA, CMA/NMC, KMA, Météo-France La Réunion, or Australia BoM. Dvorak values and operational analyses are clearly distinguished; one agency’s value is never copied into another card.
- 🛰️ **Separate UW–CIMSS guidance** — currently published objective satellite products are rendered apart from the agency cards, with their own CIMSS source links.

## 📁 Files

| File | Description |
|------|-------------|
| `index.html` | Main HTML page (works standalone, no PHP needed) |
| `style.css` | Complete responsive stylesheet |
| `app.js` | Application logic (fetches data directly from NRL API) |
| `index.php` | PHP version of the main page (for PHP hosting) |
| `api.php` | PHP proxy (optional, for hosts that block CORS) |
| `fix.php` | Production agency-analysis and separate UW–CIMSS objective-products endpoint |
| `fix.js` | Zero-dependency local preview server with the same `/fix.php` endpoint |
| `.htaccess` | Apache configuration (for shared hosting) |

## 🚀 Deployment

### Option 1: PHP Hosting — full live dashboard (recommended)
Upload all files to a PHP-enabled server. `fix.php` is a same-origin, read-only multi-agency endpoint that retrieves official publications and safely parses only the selected storm’s reported value. It accepts no arbitrary remote URLs and caches a live response for four minutes. The panel’s **Refresh** button bypasses that short cache.

- Each card has its **own official source link**. JTWC reasoning populates **only PGTW** — it cannot populate DEMS, JMA, CWA, CMA, KMA, PAGASA, etc.
- IMD/DEMS satellite-fix PDFs are discovered from IMD’s official bulletin archive. A text renderer may be used only to read the official PDF; the displayed link is always the original IMD file.
- Agencies that publish a Dvorak number show that number. Agencies whose public product publishes an operational wind/pressure analysis show the agency’s native unit instead; nothing is converted or estimated.
- A card explicitly reports when the agency has no matching bulletin, is outside its responsibility area, or (as of September 2026) a publisher has discontinued a product. NOAA SAB/KNES manual Dvorak estimates are marked discontinued rather than being back-filled from another agency.
- The last-published fallback is retained for 24 hours and visibly labelled. It never creates a value for an agency that did not publish one.

### Option 2: Local preview / Node.js
No package installation is needed:
```bash
cd satellite-viewer
node fix.js
```
Open `http://localhost:4173`. The local server serves the site and mirrors the production `/fix.php` multi-agency endpoint.

### Option 3: Static-only hosting
`index.html`, `style.css`, and `app.js` can still be deployed to static hosting for the NRL imagery viewer. Static-only hosts cannot run `fix.php`, so the Dvorak panel will show an explicit unavailable state rather than inaccurate data. Use PHP hosting or provide an equivalent same-origin endpoint for the complete live dashboard.

## 🎨 Customization

### Colors
Edit CSS variables in `style.css`:
```css
:root {
    --bg-primary: #0a0e1a;
    --accent-blue: #3b82f6;
    --accent-cyan: #06b6d4;
    /* ... */
}
```

### Page Size
In `app.js`, adjust:
```javascript
pageSize: 36, // Images per page load
```

### Auto-Refresh
Add auto-refresh by calling `loadProducts(false)` on an interval:
```javascript
setInterval(() => loadProducts(false), 5 * 60 * 1000); // Every 5 minutes
```

## 📡 Data Source

Imagery is provided by the [U.S. Naval Research Laboratory](https://science.nrlmry.navy.mil/geoips/tcweb4/) GeoIPS Tropical Cyclone Web system. The separate automated-guidance panel reads [UW–CIMSS tropical-cyclone products](https://tropic.ssec.wisc.edu/) when available. These are publicly available data for educational and research purposes.

## 📱 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` | Previous image (in lightbox) |
| `→` | Next image (in lightbox) |
| `Esc` | Close lightbox |
| Swipe | Navigate images (touch devices) |

## 📄 License

MIT License — Free for personal and commercial use.

## 🙏 Credits

- **Data:** U.S. Naval Research Laboratory (NRL)
- **Design:** Custom-built with ❤️

## Analysis provenance and UW–CIMSS products

JTWC can receive estimates from other operational centres through WMO/GTS, regional coordination, or direct forecaster communication and include them in its own prognostic reasoning. A line in that JTWC table establishes that **JTWC received/reported it**; it does not establish that the named agency publicly published that value. For that reason the dashboard uses the JTWC text only for the JTWC card and only fills another centre’s card from that centre’s own public product.

The separate **UW–CIMSS Objective Satellite Products** panel is deliberately not an agency-analysis panel. It retrieves the selected storm’s live CIMSS summary and displays each numerical product currently exposed there, including ADT, AiDT, D-PRINT, D-MINT, microwave sounders, SATCON, AI-RI, ARCHER, M-PERC, and vertical shear, plus published ADT and SATCON detail fields. These are automated/objective satellite algorithms and may be unavailable depending on the storm, processing, basin, and satellite coverage; they do not replace analyst fixes, forecasts, or warnings.
