// public/app.js
const $ = (s) => document.querySelector(s);

const chips = $("#chips");
const newItem = $("#newItem");
const results = $("#results");

// --- Strict add: only allow items from autocomplete (server-backed) ---
async function fetchSuggestions(q, limit=12){
  const r = await fetch(`/api/suggest?q=${encodeURIComponent(q)}&limit=${limit}`);
  const j = await r.json();
  return (j && j.ok && Array.isArray(j.suggestions)) ? j.suggestions : [];
}
function tokensOf(s){
  return (s||"").toLowerCase().replace(/[\"'`״׳.,()\-–—_/]/g," ").replace(/\s+/g," ").trim().split(" ").filter(Boolean);
}
function scoreTokens(query, candidate){
  const tq = new Set(tokensOf(query));
  const tc = new Set(tokensOf(candidate));
  if (!tc.size) return 0;
  let inter = 0;
  for (const t of tq) if (tc.has(t)) inter++;
  const jacc = inter / (tq.size + tc.size - inter || 1);
  const str = candidate.toLowerCase(), ql = (query||"").toLowerCase();
  const bonus = (str.includes(ql) ? 0.1 : 0);
  return jacc + bonus;
}
// Validate or map to best suggestion; returns null if none.
async function validateOrMapItem(inputText){
  const suggs = await fetchSuggestions(inputText, 12);
  if (!suggs.length) return null;
  let best = suggs[0], bestScore = -1;
  for (const s of suggs){
    const label = typeof s === "string" ? s : (s.label || s.canonical || "");
    const sc = scoreTokens(inputText, label);
    if (sc > bestScore){ bestScore = sc; best = s; }
  }
  if (bestScore < 0.25) return null;
  return typeof best === "string" ? best : (best.label || best.canonical || best.id || null);
}

// ברירת מחדל (אפשר למחוק אם רוצים להתחיל מרשימה ריקה)
let items = ["קוקה קולה 1.5 ליטר", "מים מינרלים 1.5 ליטר", "פסטה"];

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

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

const dropdown = $("#dropdown");
let dropdownItems = [];

async function updateDropdown(q) {
  if (!q.trim()) {
    dropdown.style.display = "none";
    return;
  }
  try {
    const data = await fetch(`/api/suggest?q=${encodeURIComponent(q)}&limit=12`).then(r=>r.json());
    if (!data.ok) throw new Error("suggest failed");
    dropdownItems = data.suggestions.map(s => typeof s === "string" ? s : (s.label || s.canonical || s.id || ""));
    if (!dropdownItems.length) {
      dropdown.style.display = "none";
      return;
    }
    dropdown.innerHTML = dropdownItems.map(it => `<div class="opt">${escapeHtml(it)}</div>`).join("");
    dropdown.querySelectorAll(".opt").forEach((el) => {
      el.onclick = () => {
        const label = el.textContent.trim();
        if (label && !items.includes(label)) {
          items.push(label);
          renderChips();
        }
        newItem.value = "";
        dropdown.style.display = "none";
      };
    });
    const rect = newItem.getBoundingClientRect();
    dropdown.style.left = rect.left + "px";
    dropdown.style.top = (rect.bottom + window.scrollY) + "px";
    dropdown.style.width = rect.width + "px";
    dropdown.style.display = "block";
  } catch {
    dropdown.style.display = "none";
  }
}

// הוספה – קפדנית (רק ערכים שמגיעים מהצעות השרת)
const addBtn = $("#addBtn");
addBtn.onclick = async () => {
  const toAddRaw = newItem.value.trim();
  if (!toAddRaw) return;
  const mapped = await validateOrMapItem(toAddRaw);
  if (!mapped){
    alert("המוצר לא נמצא במאגר. בחר/י הצעה מאוטוקומפליט.");
    return;
  }
  if (!items.includes(mapped)) items.push(mapped);
  newItem.value = "";
  dropdown.style.display = "none";
  renderChips();
};

newItem.addEventListener("input", (e) => {
  updateDropdown(newItem.value);
});

newItem.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter'){
    e.preventDefault();
    const toAddRaw = newItem.value.trim();
    if (!toAddRaw) return;
    const mapped = await validateOrMapItem(toAddRaw);
    if (!mapped){
      alert("המוצר לא נמצא במאגר. בחר/י הצעה מאוטוקומפליט.");
      return;
    }
    if (!items.includes(mapped)) items.push(mapped);
    newItem.value = "";
    dropdown.style.display = "none";
    renderChips();
  }
});

function showSkeleton() {
  results.innerHTML = `
    <div class="skel"></div>
    <div class="skel"></div>
    <div class="skel"></div>
  `;
}

function renderResults(baskets) {
  if (!baskets?.length) {
    results.innerHTML = `<div class="error">
      לא נמצאו תוצאות בסביבה/פריטים שנבחרו. נסה/י להגדיל רדיוס או לשנות פריטים.
    </div>`;
    return;
  }

  const cards = baskets.map((b, i) => {
    const itemsHtml = (b.breakdown || []).map(item => `
      <div class="row">
        <div class="name">${escapeHtml(item.label || item.name || "")}${item.substitute ? ' <span class="pill pill-sub">תחליף קרוב</span>' : ''}</div>
        <div class="price">${typeof item.price === "number" ? (item.price.toFixed(1) + " ₪") : "-"}</div>
        ${item.size_text ? `<div class="size">${escapeHtml(item.size_text)}</div>` : ""}
      </div>
    `).join("");

    const mapId = `map-${i}`;
    const mapHtml = (typeof b.lat==="number" && typeof b.lng==="number") ? `<div id="${mapId}" class="mini-map"></div>` : '';

    return `
      <div class="card">
        <div class="card-head">
          <div class="title">${escapeHtml(b.chain || "רשת")}</div>
          <div class="meta">
            <span class="pill">${typeof b.total==="number" ? (b.total.toFixed(1) + " ₪") : "-"}</span>
            ${typeof b.distKm==="number" ? `<span class="pill">${b.distKm} ק״מ</span>` : ""}
            ${typeof b.coverage==="number" ? `<span class="pill">${Math.round(b.coverage*100)}% כיסוי</span>` : ""}
          </div>
        </div>
        <div class="card-body">
          ${itemsHtml}
          ${mapHtml}
        </div>
      </div>
    `;
  }).join("");

  results.innerHTML = cards;

  // מפות זעירות
  baskets.forEach((b, i) => {
    if (typeof b.lat==="number" && typeof b.lng==="number") {
      const map = L.map(`map-${i}`, { attributionControl:false, zoomControl:false }).setView([b.lat, b.lng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {}).addTo(map);
      L.marker([b.lat, b.lng]).addTo(map);
    }
  });
}

async function buildPlan() {
  const address = $("#address")?.value?.trim() || "";
  const verifiedOnly = $("#verifiedOnly")?.checked ?? true;
  const radius = Number($("#radius")?.value || 10);
  showSkeleton();
  try {
    const body = {
      address,
      radiusKm: radius,
      items: items.map(n => ({ name: n })),
      verifiedOnly
    };
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(r => r.json());

    if (!res.ok) throw new Error(res.error || "plan failed");
    renderResults(res.baskets || []);
  } catch (e) {
    results.innerHTML = `<div class="error">שגיאה: ${escapeHtml(e.message || String(e))}</div>`;
  }
};

$("#next")?.addEventListener("click", buildPlan);
$("#cta")?.addEventListener("click", () => {
  document.querySelector("#s0")?.classList.remove("active");
  document.querySelector("#s2")?.classList.add("active");
});

renderChips();
ss