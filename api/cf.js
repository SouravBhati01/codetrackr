import { getDb } from "./_db.js";

async function saveToDb(username, data) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection("stats").updateOne(
      { platform: "codeforces", username: username.toLowerCase() },
      { $set: { platform: "codeforces", username: username.toLowerCase(), data, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) { /* non-blocking */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const handle = (req.query.handle || "").trim();
  const handles = (req.query.handles || "").trim();

  // Bulk fetch for leaderboard: /api/cf?handles=user1;user2;...
  if (handles) {
    try {
      const r = await fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handles)}`);
      const j = await r.json();
      if (j && j.status === "OK") return res.status(200).json(j);

      // Batch failed (usually one bad handle poisons the whole call) — fall back to per-handle fetches.
      const list = handles.split(";").map(h => h.trim()).filter(Boolean);
      const settled = await Promise.allSettled(list.map(h =>
        fetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(h)}`)
          .then(rr => rr.json())
          .then(jj => (jj && jj.status === "OK" && jj.result && jj.result[0]) || null)
      ));
      const result = settled
        .map(s => (s.status === "fulfilled" ? s.value : null))
        .filter(Boolean);
      return res.status(200).json({ status: "OK", result });
    } catch (e) {
      return res.status(502).json({ error: "api_error" });
    }
  }

  if (!handle) return res.status(400).json({ error: "missing handle" });

  const enc = encodeURIComponent(handle);

  // Fetch all 3 endpoints in parallel server-side
  try {
    const [infoR, ratingR, statusR] = await Promise.all([
      fetch(`https://codeforces.com/api/user.info?handles=${enc}`).then(r => r.json()).catch(() => null),
      fetch(`https://codeforces.com/api/user.rating?handle=${enc}`).then(r => r.json()).catch(() => ({ result: [] })),
      fetch(`https://codeforces.com/api/user.status?handle=${enc}&from=1&count=500`).then(r => r.json()).catch(() => ({ result: [] })),
    ]);

    if (!infoR || infoR.status !== "OK") return res.status(404).json({ error: "not_found" });

    const result = {
      user: infoR.result[0],
      contests: (ratingR && ratingR.result) || [],
      subs: (statusR && statusR.result) || [],
    };
    saveToDb(handle, result);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: "api_error" });
  }
}
