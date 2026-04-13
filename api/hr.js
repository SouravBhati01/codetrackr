import { getDb } from "./_db.js";

async function saveToDb(username, data) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection("stats").updateOne(
      { platform: "hackerrank", username: username.toLowerCase() },
      { $set: { platform: "hackerrank", username: username.toLowerCase(), data, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) { /* non-blocking */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const u = (req.query.u || "").trim().toLowerCase();
  if (!u) return res.status(400).json({ error: "missing username" });

  const enc = encodeURIComponent(u);
  const base = `https://www.hackerrank.com/rest/hackers/${enc}`;

  try {
    // Fetch endpoints in parallel server-side (no CORS issues)
    const [scoresR, badgesR, recentR] = await Promise.allSettled([
      fetch(`${base}/scores_elo`).then(r => {
        if (!r.ok) throw new Error("fail");
        return r.json();
      }),
      fetch(`${base}/badges`).then(r => {
        if (!r.ok) throw new Error("fail");
        return r.json();
      }),
      fetch(`${base}/recent_challenges?limit=200&offset=0`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const scores = scoresR.status === "fulfilled" && Array.isArray(scoresR.value) ? scoresR.value : [];
    const badges = badgesR.status === "fulfilled" ? ((badgesR.value && badgesR.value.models) || []) : [];
    const recent = recentR.status === "fulfilled" && recentR.value && Array.isArray(recentR.value.models)
      ? recentR.value.models.map(m => ({ name: m.name, created_at: m.created_at, url: m.url }))
      : [];

    if (!scores.length && !badges.length) return res.status(404).json({ error: "not_found" });

    const result = { scores, badges, recent };
    saveToDb(u, result);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: "api_error" });
  }
}
