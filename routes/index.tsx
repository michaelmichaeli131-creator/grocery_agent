/** @jsx h */
import { h } from "preact";
import { useState } from "preact/hooks";

export default function Home() {
  const [items, setItems] = useState("קוקה קולה 1.5 ליטר\nמים מינרליים 1.5 ליטר\nפסטה");
  const [address, setAddress] = useState("רחוב אילת 12, חולון");
  const [radius, setRadius] = useState("3");
  const [language, setLanguage] = useState<"he" | "en">("he");
  const [loading, setLoading] = useState(false);
  const [out, setOut] = useState<string>("");

  const submit = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    setOut("מבצע חיפוש…");

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, address, radius_km: Number(radius), language })
      });
      const data = await res.json();
      setOut(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOut("שגיאה: " + err?.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="container">
      <h1>🥦 השוואת סל קניות</h1>

      <form onSubmit={submit}>
        <label>שפה / Language</label>
        <select value={language} onInput={(e) => setLanguage((e.currentTarget as HTMLSelectElement).value as any)}>
          <option value="he">עברית</option>
          <option value="en">English</option>
        </select>

        <label>רשימת קניות (שורה לכל פריט)</label>
        <textarea value={items} onInput={(e) => setItems((e.currentTarget as HTMLTextAreaElement).value)} />

        <label>כתובת</label>
        <input value={address} onInput={(e) => setAddress((e.currentTarget as HTMLInputElement).value)} />

        <label>רדיוס (ק״מ)</label>
        <input type="number" min="1" max="50" value={radius} onInput={(e) => setRadius((e.currentTarget as HTMLInputElement).value)} />

        <button disabled={loading}>{loading ? "מחפש…" : "מצא את הסל הזול ביותר"}</button>
      </form>

      <h2>תוצאות (JSON)</h2>
      <pre>{out || "אין תוצאות עדיין."}</pre>
    </div>
  );
}
