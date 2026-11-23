// Bookmarklet: run on a realestate.com.au / domain.com.au search-results page in your own browser.
// It reads the listing cards already on screen and opens the app with them in the URL hash (#import=…),
// where you confirm the import. Nothing is sent anywhere else.
// grab() must stay self-contained: it is serialised with toString() into the bookmark.
// ponytail: no site class names; cards are found from listing links, so it survives most redesigns but not all.

export function grab(APP) {
  const LINK = /realestate\.com\.au\/property-[a-z0-9+%.-]+-(\d{5,})|domain\.com\.au\/[a-z0-9-]+-(\d{7,})(?:[/?#]|$)/i;
  const ADDR = /^(?:(?:unit|apt|lot)\s+)?\d+[a-z]?(?:\s*[/-]\s*\d+[a-z]?)?\s+[a-z0-9' .-]{2,60},\s*[a-z][a-z' .-]{1,40}(?:,?\s*(?:sa|south australia))?(?:\s+\d{4})?$/i;
  const PRICE = /\$\s?\d|auction|contact agent|offers|expressions? of interest|\beoi\b|price guide|for sale|best offer|by negotiation|under contract/i;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const idOf = (href) => { const m = String(href).match(LINK); return m && (m[1] || m[2]); };

  const byId = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const id = idOf(a.href);
    if (id && !byId.has(id)) byId.set(id, a);
  }
  const items = [];
  for (const [id, a] of byId) {
    // the card = the largest ancestor that links to this listing only
    let card = a;
    while (card.parentElement && card.parentElement !== document.body) {
      const ids = new Set([...card.parentElement.querySelectorAll('a[href]')].map((x) => idOf(x.href)).filter(Boolean));
      if (ids.size > 1) break;
      card = card.parentElement;
    }
    // every element's own text, so pieces that sit side by side ("3" + "Beds", address + price) are also seen apart
    const texts = [...new Set([card, ...card.querySelectorAll('*')].map((e) => clean(e.innerText)).filter((t) => t && t.length < 120))];
    const labels = [...card.querySelectorAll('[aria-label],[title],img[alt]')].map((e) => clean(e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('alt'))).filter(Boolean);
    const shortest = (arr, ok) => arr.filter(ok).sort((x, y) => x.length - y.length)[0] || null;
    const caps = (t) => t.replace(/,\s*/g, ', ').replace(/\b([A-Z]{3,})\b/g, (w) => (w === 'SA' ? w : w[0] + w.slice(1).toLowerCase()));
    const addr = shortest([...texts, ...labels], (t) => ADDR.test(t));
    const address = addr && caps(addr);
    const priceText = shortest(texts, (t) => PRICE.test(t) && !ADDR.test(t) && !/\b(bed|bath|car|parking|m²|sqm)/i.test(t));
    const feat = [...labels, ...texts].join(' | ');
    const num = (re) => { const m = feat.match(re); return m ? +m[1] : null; };
    // the house photo = the biggest non-square picture; agent headshots and logos are small and square-ish
    const img = [...card.querySelectorAll('img')]
      .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth || i.width, h: i.naturalHeight || i.height }))
      .filter((i) => /^https:/.test(i.src) && !/logo|agent|avatar|contact_\d|gravity=north|\.svg/i.test(i.src) && !/\/(\d{2,3})x\1[/-]/.test(i.src) && !(i.w && i.h && Math.abs(i.w - i.h) < 0.1 * i.w))
      .sort((a, b) => b.w * b.h - a.w * a.h)[0]?.src;
    items.push({
      url: a.href.split(/[?#]/)[0], address, priceText,
      beds: num(/(\d+)\s*(?:beds?|bedrooms?)(?![a-z])/i), baths: num(/(\d+)\s*(?:baths?|bathrooms?)(?![a-z])/i),
      cars: num(/(\d+)\s*(?:cars?|car spaces?|parking(?: spaces?)?|garages?)(?![a-z])/i),
      image: img || null,
    });
  }
  if (!items.length) { alert('House Hunt: no listings found on this page. Open a search-results page (or a single listing) and try again.'); return; }
  const payload = { from: location.hostname.replace(/^www\./, ''), page: location.href.split('#')[0], at: new Date().toISOString(), items };
  window.open(APP + '#import=' + encodeURIComponent(JSON.stringify(payload)), '_blank');
}

// The javascript: URL for the bookmark, pointing back at this app.
export const bookmarkletHref = (appUrl) => 'javascript:' + encodeURIComponent(`(${grab.toString()})(${JSON.stringify(appUrl)})`);

// Merge imported items into data/manual.json entries. Hand-added entries are left alone;
// imported ones are refreshed (price, beds…, seenAt). Items without an address are skipped.
export function mergeImport(list, items, today) {
  const key = (u) => String(u).match(/-(\d{5,})(?:[/?#]|$)/)?.[1];
  const out = list.map((m) => ({ ...m }));
  const at = new Map(out.map((m, i) => [key(m.url), i]));
  let added = 0, updated = 0, skipped = 0;
  for (const it of items) {
    const k = key(it.url);
    if (!k || !it.address) { skipped++; continue; }
    const row = { url: it.url, address: it.address, priceText: it.priceText ?? null, beds: it.beds ?? null, baths: it.baths ?? null, cars: it.cars ?? null, image: it.image ?? null };
    if (at.has(k)) {
      const m = out[at.get(k)];
      if (m.via !== 'bookmarklet') { skipped++; continue; } // added by hand: yours wins
      Object.assign(m, row, { seenAt: today }); updated++;
    } else {
      at.set(k, out.push({ ...row, via: 'bookmarklet', addedAt: today, seenAt: today }) - 1); added++;
    }
  }
  return { list: out, added, updated, skipped };
}
