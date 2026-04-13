import { getDb } from "./_db.js";

async function saveToDb(username, data) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection("stats").updateOne(
      { platform: "leetcode", username: username.toLowerCase() },
      { $set: { platform: "leetcode", username: username.toLowerCase(), data, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) { /* DB save is non-blocking; don't fail the request */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const u = (req.query.u || "").trim();
  if (!u) return res.status(400).json({ error: "missing username" });

  const GQL = `query q($u:String!){allQuestionsCount{difficulty count}matchedUser(username:$u){username profile{ranking userAvatar}submitStats{acSubmissionNum{difficulty count submissions}totalSubmissionNum{difficulty count submissions}}userCalendar{submissionCalendar}}}`;

  try {
    const r = await fetch("https://leetcode.com/graphql/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Referer": "https://leetcode.com" },
      body: JSON.stringify({ query: GQL, variables: { u } }),
    });
    const j = await r.json();
    if (j.data && j.data.matchedUser) {
      const m = j.data.matchedUser, q = j.data.allQuestionsCount;
      const ac = m.submitStats.acSubmissionNum, tot = m.submitStats.totalSubmissionNum;
      let calendar = null;
      try { if (m.userCalendar && m.userCalendar.submissionCalendar) calendar = JSON.parse(m.userCalendar.submissionCalendar); } catch(e) {}
      const result = {
        user: u,
        avatar: m.profile ? m.profile.userAvatar : null,
        ranking: m.profile ? m.profile.ranking : 0,
        solved: ac[0].count, easy: ac[1].count, med: ac[2].count, hard: ac[3].count,
        tQ: q[0].count, tE: q[1].count, tM: q[2].count, tH: q[3].count,
        accept: tot[0] && tot[0].submissions > 0 ? +((ac[0].count / tot[0].submissions) * 100).toFixed(1) : 0,
        calendar: calendar,
      };
      saveToDb(u, result);
      return res.status(200).json(result);
    }
    if (j.data && !j.data.matchedUser) return res.status(404).json({ error: "not_found" });
    // If GraphQL returned errors, try fallback
  } catch (e) { /* fall through to fallback */ }

  // Fallback: alfa-leetcode-api
  try {
    const enc = encodeURIComponent(u);
    const sr = await fetch(`https://alfa-leetcode-api.onrender.com/userProfile/${enc}`);
    if (!sr.ok) return res.status(404).json({ error: "not_found" });
    const st = await sr.json();
    if (st.errors) return res.status(404).json({ error: "not_found" });
    let av = null;
    try {
      const pr = await fetch(`https://alfa-leetcode-api.onrender.com/${enc}`);
      if (pr.ok) { const p = await pr.json(); av = p.avatar; }
    } catch (e) {}
    const result = {
      user: u, avatar: av, ranking: st.ranking || 0,
      solved: st.totalSolved || 0, easy: st.easySolved || 0, med: st.mediumSolved || 0, hard: st.hardSolved || 0,
      tQ: st.totalQuestions || 0, tE: st.totalEasy || 0, tM: st.totalMedium || 0, tH: st.totalHard || 0,
      accept: null,
    };
    saveToDb(u, result);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: "api_error" });
  }
}
