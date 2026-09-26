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

## 📁 Files

| File | Description |
|------|-------------|
| `index.html` | Main HTML page (works standalone, no PHP needed) |
| `style.css` | Complete responsive stylesheet |
| `app.js` | Application logic (fetches data directly from NRL API) |
| `index.php` | PHP version of the main page (for PHP hosting) |
| `api.php` | PHP proxy (optional, for hosts that block CORS) |
| `.htaccess` | Apache configuration (for shared hosting) |

## 🚀 Deployment

### Option 1: Static Hosting (Recommended)
Simply upload `index.html`, `style.css`, and `app.js` to any web hosting:
- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages
- Any shared hosting (just upload the 3 files)

**Note:** The NRL API supports CORS, so no server-side proxy is needed!

### Option 2: PHP Hosting
Upload all files to a PHP-enabled server:
- The site will automatically use direct API calls
- `api.php` is available as a fallback proxy if needed

### Option 3: Local Testing
```bash
# Using Python
cd satellite-viewer
python3 -m http.server 8080

# Using Node.js
npx serve .
```
Then open `http://localhost:8080`

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
