const $ = (s) => document.querySelector(s);

const chips = $("#chips");
const newItem = $("#newItem");
const results = $("#results");

let items = ["קוקה קולה 1.5 ליטר", "מים מינרלים 1.5 ליטר", "פסטה"];

function renderChips() {
  chips.innerHTML = "";
  items.forEach((it, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>${escapeHtml(it)}</span><button class="close" title="הסר" aria-label="הסר">×</button>`;
    chip.querySelector(".close").onclick = () => {
      items.splice(i, 1);
      renderChips();
    };
    chips.appendChild(chip);
  });
}
renderChips();

$("#addBtn").onclick = () => {
  const v = (newItem.value || "").trim();
  if (!v) return;
  items.push(v);
  newItem.value = "";
  renderChips();
};

$("#searchBtn").onclick = async () => {
  const address = ($("#address").value || "").trim();
  const radiusKm = Number($("#radius").value || 15);
  if (!address) {
    results.innerHTML = `<div class="error">נא להזין כתובת</div>`;
    return;
  }
  showSkeleton();

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, radiusKm, items }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Internal Error");

    renderResults(data.baskets);
    renderMap(data.baskets);
  } catch (e) {
    results.innerHTML = `<div class="error">שגיאה: ${escapeHtml(e.message || String(e))}</div>`;
  }
};

function showSkeleton() {
  results.innerHTML = `
    <div class="skel"></div>
    <div class="skel"></div>
    <div class="skel"></div>
  `;
}

function renderResults(baskets) {
  if (!baskets?.length) {
    results.innerHTML = `<div class="error">לא נמצאו תוצאות</div>`;
    return;
  }
  let html = "";
  baskets.forEach((b, i) => {
    const addr = b.location?.address ? `<div class="subtext">${escapeHtml(b.location.address)}</div>` : "";
    html += `
      <section class="shop">
        <h3>#${i + 1} ${escapeHtml(b.shop_display_name)} — ${fmt(b.total)} ₪</h3>
        ${addr}
        <details ${i === 0 ? "open" : ""}>
          <summary>סל מלא</summary>
          <ul>
            ${b.breakdown.map(renderLine).join("")}
          </ul>
        </details>
      </section>
    `;
  });
  results.innerHTML = html;
}

function renderLine(p) {
  const price = p.price == null || Number.isNaN(p.price) ? "—" : fmt(p.price);
  const desc = p.description ? `<span class="subtext"> — ${escapeHtml(p.description)}</span>` : "";
  const sub = p.substitute ? ` <span class="badge sub">תחליף</span>` : "";
  const link = p.link ? ` <a href="${p.link}" target="_blank" rel="noopener">קישור</a>` : "";
  const srcPieces = [];
  if (p.merchant) srcPieces.push(escapeHtml(p.merchant));
  if (p.domain) srcPieces.push(escapeHtml(p.domain));
  const source = srcPieces.length ? ` <span class="badge src">${srcPieces.join(" • ")}</span>` : "";

  return `<li>
    <b>${escapeHtml(p.item)}</b>: ${escapeHtml(p.chosen_title || p.item)}${desc}${sub}
    — ${price} ${p.currency || ""}${link}${source}
  </li>`;
}

/* ---------- Map (Leaflet + OSM) ---------- */
let map, markersLayer;
function ensureMap() {
  if (map) return map;
  map = L.map("map");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  return map;
}

function renderMap(baskets) {
  ensureMap();
  markersLayer.clearLayers();
  const bounds = [];

  baskets.forEach((b, i) => {
    const loc = b.location || {};
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number") return;
    const m = L.marker([loc.lat, loc.lng]).addTo(markersLayer);
    const addr = loc.address ? ` — ${escapeHtml(loc.address)}` : "";
    m.bindPopup(`<b>#${i + 1} ${escapeHtml(b.shop_display_name)}</b>${addr}<br/>סה״כ: ${fmt(b.total)} ₪`);
    bounds.push([loc.lat, loc.lng]);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
}

/* ---------- Helpers ---------- */
function fmt(n){ return Number(n).toFixed(2) }
function escapeHtml(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
