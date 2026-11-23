// Leaflet map, loaded on demand from unpkg (pinned 1.9.4). Draws the selected school zones
// with translucent fills so the overlap reads darker, plus price-labelled listing markers.
import { h, fmtMoney, prefersDark } from './util.js';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
let leafletPromise = null;

export function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LEAFLET_CSS;
    document.head.append(css);
    const sc = document.createElement('script');
    sc.src = LEAFLET_JS;
    sc.async = true;
    sc.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet did not initialise')));
    sc.onerror = () => { leafletPromise = null; reject(new Error('Could not load the map library from unpkg.com')); };
    document.head.append(sc);
  });
  return leafletPromise;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#1E7F5C';
const ZONE_VARS = ['--chart-1', '--chart-3', '--chart-2', '--ink-2'];

export async function createMap(container, { onSelect } = {}) {
  const L = await ensureLeaflet();
  const map = L.map(container, { zoomControl: true, scrollWheelZoom: true, tap: false });
  // OpenStreetMap standard tiles (CARTO basemaps now need an API key). Dark mode inverts them via CSS.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19, className: prefersDark() ? 'tiles-dark' : '',
  }).addTo(map);
  map.setView([-34.948, 138.648], 13);

  const zoneLayer = L.featureGroup().addTo(map);
  const markerLayer = L.featureGroup().addTo(map);
  const markers = new Map();
  let legend = null;

  function setZones(features) {
    zoneLayer.clearLayers();
    if (legend) { legend.remove(); legend = null; }
    const names = [];
    features.forEach((f, i) => {
      const color = cssVar(ZONE_VARS[i % ZONE_VARS.length]);
      names.push({ name: f.properties?.school || `Zone ${i + 1}`, color });
      L.geoJSON(f, {
        style: { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.12, dashArray: i % 2 ? '6 4' : null },
        interactive: false,
      }).addTo(zoneLayer);
    });
    if (names.length) {
      legend = L.control({ position: 'bottomleft' });
      legend.onAdd = () => {
        const div = h('div', { class: 'map-legend' },
          names.map((n) => h('div', { class: 'map-legend-row' }, h('span', { class: 'swatch', style: { background: n.color } }), n.name)),
          names.length > 1 && h('div', { class: 'map-legend-note', text: 'Darker shading = inside every zone' }),
        );
        L.DomEvent.disableClickPropagation(div);
        return div;
      };
      legend.addTo(map);
      const b = zoneLayer.getBounds();
      if (b.isValid()) map.fitBounds(b.pad(0.05));
    }
  }

  function setListings(listings) {
    markerLayer.clearLayers();
    markers.clear();
    for (const l of listings) {
      if (l.lat == null || l.lng == null) continue;
      const price = l.priceLow ?? l.priceHigh;
      const label = price != null ? fmtMoney(price) : 'POA';
      const icon = L.divIcon({
        className: `price-pin status-${l.status || 'active'}`,
        html: `<span>${label}</span>`,
        iconSize: null,
        iconAnchor: [0, 14],
      });
      const m = L.marker([l.lat, l.lng], { icon, title: l.address || '', riseOnHover: true });
      const popup = h('div', { class: 'map-popup' },
        h('strong', { text: l.address || 'Listing' }),
        h('div', { class: 'map-popup-meta', text: [l.priceText, [l.bedrooms && `${l.bedrooms} bd`, l.bathrooms && `${l.bathrooms} ba`].filter(Boolean).join(' ')].filter(Boolean).join(' · ') }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => onSelect?.(l.id) }, 'Open listing'),
      );
      m.bindPopup(popup, { closeButton: true, maxWidth: 260 });
      m.addTo(markerLayer);
      markers.set(String(l.id), m);
    }
    if (!zoneLayer.getLayers().length && markerLayer.getLayers().length) {
      const b = markerLayer.getBounds();
      if (b.isValid()) map.fitBounds(b.pad(0.2));
    }
  }

  function focus(id) {
    const m = markers.get(String(id));
    if (!m) return false;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
    m.openPopup();
    return true;
  }

  return { map, setZones, setListings, focus, invalidate: () => map.invalidateSize() };
}
