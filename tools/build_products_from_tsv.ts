// deno run -A tools/build_products_from_tsv.ts
// בונה public/products.json מכל קובצי CSV/TSV בתיקייה (ברירת מחדל: public/data)
// כולל דיאגנוסטיקה, זיהוי מפריד, תמיכה בעברית, ו-log כמה פריטים זוהו מכל קובץ.

const DATA_DIR = Deno.env.get("DATA_DIR") ?? "public/data";

// כינויים לעמודות
const NAME_KEYS  = ["itemname","שם מוצר","product","name","item","שם"];
const SIZE_KEYS  = ["size","גודל","נפח","משקל"];
const BRAND_KEYS = ["brand","מותג"];
// לא חייבים למחיר באוטוקומפליט, אבל נזהה אם קיים
const PRICE_KEYS = ["itemprice","price","מחיר"];

type Row = { itemname: string; size?: string; brand?: string };

function stripBOM(s: string) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function detectDelimiter(headerLine: string): string {
  // עדיפות לטאב, אח"כ פסיק, אח"כ נקודה-פסיק
  if (headerLine.includes("\t")) return "\t";
  if (headerLine.includes(",")) return ",";
  if (headerLine.includes(";")) return ";";
  // fallback: פסיק
  return ",";
}

// מפענח שורה עם מרכאות (CSV/TSV)
function smartSplit(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function normalizeKey(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g," ");
}

function pickIndex(headers: string[], candidates: string[]): number {
  const normH = headers.map(normalizeKey);
  // חיפוש ישיר
  for (const cand of candidates) {
    const i = normH.indexOf(normalizeKey(cand));
    if (i >= 0) return i;
  }
  // חיפוש "מכיל"
  for (let i=0;i<normH.length;i++){
    for (const cand of candidates) {
      if (normH[i].includes(normalizeKey(cand))) return i;
    }
  }
  return -1;
}

async function listDataFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile) continue;
      const low = e.name.toLowerCase();
      if (low.endsWith(".csv") || low.endsWith(".tsv") || low.endsWith(".txt")) {
        files.push(`${dir}/${e.name}`);
      }
    }
  } catch {
    // אם התיקייה לא קיימת
  }
  return files;
}

function parseFile(txtRaw: string): Row[] {
  const txt = stripBOM(txtRaw).replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  const lines = txt.split("\n").filter(l=>l.trim().length>0);
  if (!lines.length) return [];

  const delim = detectDelimiter(lines[0]);
  const headerCols = smartSplit(lines[0], delim).map(s=>s.trim());
  let iName  = pickIndex(headerCols, NAME_KEYS);
  let iSize  = pickIndex(headerCols, SIZE_KEYS);
  let iBrand = pickIndex(headerCols, BRAND_KEYS);
  let iPrice = pickIndex(headerCols, PRICE_KEYS);

  // אם אין כותרות הגיוניות, ננסה לנחש: עמודה 0 = שם
  if (iName < 0) {
    // נבדוק אם השורה הראשונה היא כותרות "מזויפות" או דאטה:
    // אם יש ספרות רבות, נניח שאין כותרות – נפרש כל השורות כדאטה.
    iName = 0;
  }

  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = smartSplit(lines[i], delim).map(s=>s.trim());
    const itemname = cols[iName] ?? "";
    if (!itemname) continue;
    out.push({
      itemname,
      size:  iSize>=0  ? (cols[iSize]  ?? "") : undefined,
      brand: iBrand>=0 ? (cols[iBrand] ?? "") : undefined,
    });
  }
  return out;
}

const byName = new Map<string, Row>();
const files = await listDataFiles(DATA_DIR);

if (files.length === 0) {
  console.error(`⚠️ לא נמצאו קבצים בתיקייה ${DATA_DIR}. הגדר DATA_DIR או שים שם CSV/TSV.`);
}

for (const f of files) {
  try {
    const txt = await Deno.readTextFile(f);
    const rows = parseFile(txt);
    let added = 0;
    for (const r of rows) {
      const k = r.itemname.toLowerCase();
      if (!byName.has(k)) { byName.set(k, r); added++; }
    }
    console.log(`📄 ${f} → נמצאו ${rows.length}, נוספו ייחודיים ${added}`);
  } catch (e) {
    console.error(`❌ קריאה נכשלה: ${f} — ${e?.message||e}`);
  }
}

const products = Array.from(byName.values())
  .sort((a,b)=> a.itemname.localeCompare(b.itemname, "he"))
  .map((r,i)=>({
    id: `localdb_${i}_${r.itemname}`,
    label: r.itemname,
    canonical: r.itemname,
    default_size: r.size || "",
    brand: r.brand || "",
    tags: ["LocalDBMirror"]
  }));

await Deno.mkdir("public", { recursive: true });
await Deno.writeTextFile("public/products.json", JSON.stringify(products, null, 2));

console.log(`✅ built products.json with ${products.length} items from ${files.length} file(s)`);
console.log(`ℹ️ קובץ יעד: public/products.json`);
console.log(`ℹ️ אם יצא 0 — בדוק/הגדר DATA_DIR והאם יש כותרת בשם "ItemName" או "שם מוצר" וכו'.`);
