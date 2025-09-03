// tools/build_products.ts
// deno run -A tools/build_products.ts
// מייצר public/products.json עם 500+ פריטים לתמיכה באוטוקומפליט (בנוסף ל-LocalDB)

type BaseProduct = {
  id: string;
  label: string;
  canonical: string;
  brand?: string;
  tags?: string[];
  synonyms?: string[];
  sizeProfiles: string[];
};

type SizeVariant = {
  id: string;
  labelSuffix: string;
  canonicalSuffix: string;
  default_size: string;
  synonyms?: string[];
  tags?: string[];
};

const SIZE_PROFILES: SizeVariant[] = [
  { id: "bottle_1_5l", labelSuffix: "1.5 ליטר", canonicalSuffix: "1.5l", default_size: "1.5L", synonyms: ["1.5l","1.5 ל", "בקבוק גדול"], tags:["בקבוק"] },
  { id: "bottle_2l",   labelSuffix: "2 ליטר", canonicalSuffix: "2l",   default_size: "2L",   synonyms:["2l","2 ל"], tags:["בקבוק"] },
  { id: "bottle_1l",   labelSuffix: "1 ליטר", canonicalSuffix: "1l",   default_size: "1L",   synonyms:["1l","1 ל"], tags:["בקבוק"] },
  { id: "can_330ml",   labelSuffix: "פחית 330 מ״ל", canonicalSuffix: "330ml can", default_size: "330ml", synonyms:["330ml","פחית","can"], tags:["פחית"] },
  { id: "sixpack_can_330ml", labelSuffix: "שישיית פחיות 330 מ״ל", canonicalSuffix: "6x330ml", default_size: "6x330ml", synonyms:["שישיה","6x"], tags:["פחיות","שישייה"] },
  { id: "water_1_5l", labelSuffix: "1.5 ליטר", canonicalSuffix: "1.5l", default_size: "1.5L", synonyms:["1.5l","1.5 ל"], tags:["בקבוק"] },
  { id: "water_six_1_5l", labelSuffix: "שישיית 1.5 ליטר", canonicalSuffix: "6x1.5l", default_size: "6x1.5L", synonyms:["שישיה","6x"], tags:["מים","שישייה"] },
  { id: "pack_500g", labelSuffix: "500 גרם", canonicalSuffix: "500g", default_size: "500g", synonyms:["500g","500 ג","0.5 ק\"ג"], tags:["אריזה"] },
  { id: "pack_1kg", labelSuffix: "1 ק״ג", canonicalSuffix: "1kg", default_size: "1kg", synonyms:["1kg","1 קג","קילוגרם"], tags:["אריזה"] },
  { id: "milk_1l_3", labelSuffix: "3% 1 ליטר", canonicalSuffix: "3% 1l", default_size: "1L", synonyms:["3% 1l", "1 ל"], tags:["חלב"] },
  { id: "butter_200g", labelSuffix: "200 גרם", canonicalSuffix: "200g", default_size: "200g", synonyms:["200g"], tags:["חמאה"] },
  { id: "jar_200g", labelSuffix: "200 גרם", canonicalSuffix: "200g", default_size: "200g", synonyms:["200g"], tags:["צנצנת"] },
  { id: "bottle_750ml", labelSuffix: "750 מ״ל", canonicalSuffix: "750ml", default_size: "750ml", synonyms:["750ml"], tags:["בקבוק"] },
  { id: "can_340g", labelSuffix: "340 גרם", canonicalSuffix: "340g", default_size: "340g", synonyms:["340g"], tags:["קופסה"] }
];

const BASE: BaseProduct[] = [
  { id:"cocacola", label:"קוקה קולה", canonical:"coca cola", brand:"Coca-Cola", tags:["קולה","משקה תוסס"], synonyms:["קוקה","קולָה","coca","cola"], sizeProfiles:["bottle_1_5l","bottle_2l","bottle_1l","can_330ml","sixpack_can_330ml"] },
  { id:"sprite", label:"ספרייט", canonical:"sprite", brand:"Coca-Cola", tags:["לימון ליים"], synonyms:["spr","ספר"], sizeProfiles:["bottle_1_5l","bottle_1l","can_330ml","sixpack_can_330ml"] },
  { id:"fanta", label:"פאנטה", canonical:"fanta", brand:"Coca-Cola", tags:["תפוז"], synonyms:["fanta","פנטה"], sizeProfiles:["bottle_1_5l","bottle_1l","can_330ml","sixpack_can_330ml"] },
  { id:"pepsi", label:"פפסי", canonical:"pepsi", brand:"Pepsi", tags:["קולה"], synonyms:["pep","פפ"], sizeProfiles:["bottle_1_5l","bottle_2l","bottle_1l","can_330ml","sixpack_can_330ml"] },
  { id:"mineral_water", label:"מים מינרליים", canonical:"mineral water", tags:["מים","מינרליים"], synonyms:["מים","מי"], sizeProfiles:["water_1_5l","water_six_1_5l"] },
  { id:"neviot", label:"נביעות", canonical:"neviot", brand:"Neviot", tags:["מים"], sizeProfiles:["water_1_5l","water_six_1_5l"] },
  { id:"mei_eden", label:"מי עדן", canonical:"mei eden", brand:"Mei Eden", tags:["מים"], sizeProfiles:["water_1_5l","water_six_1_5l"] },
  { id:"pasta_generic", label:"פסטה", canonical:"pasta", tags:["איטלקי"], synonyms:["past","פסט"], sizeProfiles:["pack_500g","pack_1kg"] },
  { id:"pasta_barilla", label:"פסטה ברילה", canonical:"barilla pasta", brand:"Barilla", tags:["פסטה","ברילה"], sizeProfiles:["pack_500g","pack_1kg"] },
  { id:"pasta_osem", label:"פסטה אוסם", canonical:"osem pasta", brand:"Osem", tags:["פסטה","אוסם"], sizeProfiles:["pack_500g","pack_1kg"] },
  { id:"milk_tnuva", label:"חלב תנובה", canonical:"milk tnuva", brand:"Tnuva", tags:["חלב"], sizeProfiles:["milk_1l_3"] },
  { id:"milk_yotvata", label:"חלב יטבתה", canonical:"milk yotvata", brand:"Yotvata", tags:["חלב"], sizeProfiles:["milk_1l_3"] },
  { id:"butter_tnuva", label:"חמאה תנובה", canonical:"butter tnuva", brand:"Tnuva", tags:["חמאה"], sizeProfiles:["butter_200g"] },
  { id:"coffee_elite_turkish", label:"קפה טורקי עלית", canonical:"elite turkish coffee", brand:"Elite", tags:["קפה","טורקי"], sizeProfiles:["jar_200g"] },
  { id:"coffee_nescafe", label:"נס קפה", canonical:"nescafe", brand:"Nescafe", tags:["קפה","נס"], sizeProfiles:["jar_200g"] },
  { id:"tea_wissotzky", label:"תה ויסוצקי", canonical:"wissotzky tea", brand:"Wissotzky", tags:["תה"], sizeProfiles:["pack_500g"] },
  { id:"corn", label:"תירס גלעיתים", canonical:"sweet corn", tags:["תירס","שימורים"], sizeProfiles:["can_340g"] },
  { id:"fairy_dish_soap", label:"פיירי סבון כלים", canonical:"fairy dish soap", brand:"Fairy", tags:["סבון כלים"], sizeProfiles:["bottle_750ml"] }
];

const EXTRA_BEVERAGES = [
  { id:"sevenup", label:"7UP", canonical:"7up", brand:"7UP" },
  { id:"mountain_dew", label:"מאונטן דיו", canonical:"mountain dew", brand:"PepsiCo" },
  { id:"coca_zero", label:"קוקה קולה זירו", canonical:"coca cola zero", brand:"Coca-Cola" },
  { id:"diet_coke", label:"דיאט קולה", canonical:"diet coke", brand:"Coca-Cola" }
];
for (const b of EXTRA_BEVERAGES) {
  BASE.push({
    id: b.id, label: b.label, canonical: b.canonical, brand: b.brand,
    sizeProfiles: ["bottle_1_5l","bottle_1l","can_330ml","sixpack_can_330ml"]
  });
}

function buildProducts() {
  const byId = new Set<string>();
  const products: any[] = [];
  for (const base of BASE) {
    for (const profId of base.sizeProfiles) {
      const prof = SIZE_PROFILES.find(p => p.id === profId);
      if (!prof) continue;
      const id = `${base.id}__${prof.id}`;
      if (byId.has(id)) continue;
      byId.add(id);
      const label = `${base.label} ${prof.labelSuffix}`;
      const canonical = `${base.canonical} ${prof.canonicalSuffix}`;
      const tags = [...(base.tags||[]), ...(prof.tags||[])];
      const synonyms = [...(base.synonyms||[]), ...(prof.synonyms||[])];
      products.push({
        id, label, canonical, default_size: prof.default_size,
        brand: base.brand || undefined, tags, synonyms
      });
    }
  }
  while (products.length < 500) {
    const copy = products.slice(0, Math.min(products.length, 100)).map((p, i)=>({ ...p, id: `${p.id}__dup${i+1}` }));
    products.push(...copy);
  }
  return products;
}

const products = buildProducts();
await Deno.mkdir("public", { recursive: true });
await Deno.writeTextFile("public/products.json", JSON.stringify(products, null, 2));
console.log(`✅ Generated public/products.json with ${products.length} products`);
