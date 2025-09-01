const $ = (s) => document.querySelector(s);

const itemsEl = $("#items");
const newItem = $("#newItem");
let items = ["קוקה קולה", "מים מינרלים 1.5 ליטר", "פסטה"];

function renderItems() {
  itemsEl.innerHTML = "";
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${escapeHtml(it)}</span><button data-i="${i}">×</button>`;
    row.querySelector("button").onclick = () => {
      items.splice(i, 1);
      renderItems();
    };
    itemsEl.appendChild(row);
  });
}
renderItems();

$("#addBtn").onclick = () => {
  const v = newItem.value.trim();
  if (!v) return;
  items.push(v);
  newItem.value = "";
  renderItems();
};

$("#searchBtn").onclick = async () => {
  const address = $("#address").value.trim();
  const radiusKm = Number($("#radius").value || 15);
  const out = $("#results");
  out.innerHTML = "טוען…";

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
    out.innerHTML = `<div class="error">שגיאה: ${escapeHtml(e.message || String(e))}</div>`;
  }
};

function renderResults(baskets) {
  const out = $("#results");
  if (!baskets?.length) {
    out.innerHTML = `<div class="error">לא נמצאו תוצאות</div>`;
    return;
  }
  let html = "";
  baskets.forEach((b, i) => {
    html += `
      <section class="shop">
        <h3>#${i + 1} ${escapeHtml(b.shop_display_name)} — ${fmt(b.total)} ₪</h3>
        <div class="subtext">${escapeHtml(b.location?.address || "")}</div>
        <details ${i === 0 ? "open" : ""}>
          <summary>סל מלא</summary>
          <ul>
            ${b.breakdown
              .map((p) => {
                const price =
                  p.price == null || Number.isNaN(p.price) ? "—" : fmt(p.price);
                const desc = p.description
                  ? `<span class="desc"> — ${escapeHtml(p.description)}</span>`
                  : "";
                const sub = p.substitute
                  ? ` <span class="badge">תחליף</span>`
                  : "";
                const link = p.link
                  ? ` <a href="${p.link}" target="_blank" rel="noopener">קישור</a>`
                  : "";
                return `<li>
                  <b>${escapeHtml(p.item)}</b>: ${escapeHtml(p.title)}${desc}${sub}
                  — ${price} ${p.currency || ""}${link}
                </li>`;
              })
              .join("")}
          </ul>
        </details>
      </section>`;
  });
  out.innerHTML = html;
}

// ---------- Map (Leaflet + OSM) ----------
let map, markersLayer;
function ensureMap() {
  if (map) return map;
  map = L.map("map");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
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
    m.bindPopup(
      `<b>#${i + 1} ${escapeHtml(b.shop_display_name)}</b>${addr}<br/>סה״כ: ${fmt(
        b.total,
      )} ₪`,
    );
    bounds.push([loc.lat, loc.lng]);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [20, 20] });
  }
}

function fmt(n) {
  return Number(n).toFixed(2);
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
