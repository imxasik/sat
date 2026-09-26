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
- 🛟 **Resilient Fix Delivery** — every official JTWC host (HTTPS + HTTP), then read-only public mirrors of the same file, then the last officially published table; NHC-basin storms fall back to the official NHC forecast discussion
- 📈 **Live Agency Dvorak Fixes** — Storm-specific subjective fixes from the latest official JTWC reasoning, with cards for JTWC/PGTW, DEMS, JMA/RJTD, NOAA SAB/KNES, NHC, PAGASA, Taiwan CWA/RCTP, CMA, KMA, Météo-France, and Australia BoM; every additional agency listed in a product appears automatically

## 📁 Files

| File | Description |
|------|-------------|
| `index.html` | Main HTML page (works standalone, no PHP needed) |
| `style.css` | Complete responsive stylesheet |
| `app.js` | Application logic (fetches data directly from NRL API) |
| `index.php` | PHP version of the main page (for PHP hosting) |
| `api.php` | PHP proxy (optional, for hosts that block CORS) |
| `fix.php` | Production JTWC Dvorak-fix endpoint; safely parses official storm reasoning |
| `fix.js` | Zero-dependency local preview server with the same `/fix.php` endpoint |
| `.htaccess` | Apache configuration (for shared hosting) |

## 🚀 Deployment

### Option 1: PHP Hosting — full live dashboard (recommended)
Upload all files to a PHP-enabled server. `fix.php` is a same-origin, read-only JTWC endpoint that retrieves and parses the current official prognostic reasoning. It is required for the live **Agency Dvorak Fixes** panel, avoids browser CORS problems, accepts no arbitrary remote URLs, and caches a product for only four minutes. The panel's **Refresh** button bypasses that short cache.

- Satellite imagery continues to use the direct NRL API.
- `api.php` remains available as a fallback proxy for imagery hosts that need it.
- The Dvorak panel never invents or estimates an agency fix. Values are always the officially published ones.
- **Source failover order** (all in `fix.php` / `fix.js`):
  1. `https://www.metoc.navy.mil/jtwc/products/<product>` and `https://www.metoc.dc3n.navy.mil/...`
  2. the same URLs over HTTP (some shared hosts have a broken CA bundle for the Navy chain)
  3. read-only public text mirrors of that exact official file (`r.jina.ai`, `allorigins`, `codetabs`, `thingproxy`) — used only when every official host is blocked, which is the usual cause of an empty panel on non-US hosting
  4. for AL/EP/CP storms, the official NHC `CurrentStorms.json` → forecast discussion, giving TAFB/SAB subjective Dvorak values
  5. the last officially published table for that storm (kept 24 h), returned with `stale: true`, `freshness: "last_published"` and a clear on-screen warning
- Mirror responses are sanitised and validated (`looksLikeJtwcProduct`) so proxy error pages can never be shown as data.
- Every response includes an `attempts[]` array listing each source tried and why it failed, which makes hosting problems easy to diagnose.

### Option 2: Local preview / Node.js
No package installation is needed:
```bash
cd satellite-viewer
node fix.js
```
Open `http://localhost:4173`. The local server serves the site and mirrors the production `/fix.php` Dvorak endpoint.

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

All satellite data is provided by the [U.S. Naval Research Laboratory](https://science.nrlmry.navy.mil/geoips/tcweb4/) GeoIPS Tropical Cyclone Web system. This is publicly available data for educational and research purposes.

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
