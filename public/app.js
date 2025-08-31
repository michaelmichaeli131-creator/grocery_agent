const $ = (s) => document.querySelector(s);
const t = {
  he: {
    search: "פרטי חיפוש", address: "כתובת:", radius: "רדיוס (ק״מ):",
    list: "‌رשימת קניות", add: "הוסף", find: "מצא את הסל הזול",
    example: "למשל: קוקה קולה", total: "סה״כ זול ביותר", err: "שגיאה",
    ranking: "דירוג ראשון עד שלישי"
  },
  en: {
    search: "Search details", address: "Address:", radius: "Radius (km):",
    list: "Shopping list", add: "Add", find: "Find the cheapest basket",
    example: "e.g. Coca-Cola", total: "Cheapest total", err: "Error",
    ranking: "Top 3 ranking"
  }
};
let lang = "he";

const itemsEl = $("#items");
const newItem = $("#newItem");
let items = ["קוקה קולה", "מים מינרלים 1.5 ליטר", "פסטה"];

function renderI18n() {
  $("#t-search").textContent = t[lang].search;
  $("#t-address").firstChild.textContent = t[lang].address + " ";
  $("#t-radius").firstChild.textContent = t[lang].radius + " ";
  $("#t-list").textContent = t[lang].list;
  $("#addBtn").textContent = t[lang].add;
  $("#newItem").placeholder = t[lang].example;
  $("#searchBtn").textContent = t[lang].find;
}
renderI18n();
document.querySelectorAll(".lang button").forEach(b => b.onclick = () => { lang = b.dataset.lang; renderI18n(); });

function renderItems() {
  itemsEl.innerHTML = "";
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${it}</span><button data-i="${i}">×</button>`;
    row.querySelector("button").onclick = () => { items.splice(i,1); renderItems(); };
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
  const radiusKm = Number($("#radius").value || 5);
  const out = $("#results");
  out.hidden = false;
  out.innerHTML = "…";

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({ address, radiusKm, items })
    });
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || "Internal Error");
    const { top3 = [], warnings = [], mode } = data;

    let html = `<h2>${t[lang].ranking} ${mode ? `(${mode})` : ""}</h2>`;
    if (!top3.length) { out.innerHTML = `<div class="error">${t[lang].err}: no results</div>`; return; }

    html += `<ol>`;
    for (const r of top3) {
      const addr = r?.location?.address ? ` — ${r.location.address}` : "";
      html += `<li><b>${r.shop_display_name || r.chain}</b> — ${fmt(r.total)} ₪${addr}</li>`;
    }
    html += `</ol>`;

    const best = top3[0];
    if (best?.breakdown?.length) {
      html += `<details><summary>פירוט הסל הזול</summary><ul>`;
      for (const b of best.breakdown) {
        const price = (b.price == null || Number.isNaN(b.price)) ? "—" : fmt(b.price);
        html += `<li>${b.item} — ${price} ${b.currency || ""}${b.link ? ` (<a href="${b.link}" target="_blank">קישור</a>)` : ""}</li>`;
      }
      html += `</ul></details>`;
    }

    if (warnings?.length) {
      html += `<div class="error" style="margin-top:8px">${warnings.join("<br>")}</div>`;
    }

    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="error">${t[lang].err}: ${e.message || e}</div>`;
  }
};

function fmt(n) { return Number(n).toFixed(2); }
