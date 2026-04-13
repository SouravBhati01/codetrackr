/**
 * /api/stats — Save and retrieve cached user stats from MongoDB
 *
 * GET  /api/stats?platform=leetcode&username=tourist  → retrieve cached stats
 * POST /api/stats  body: { platform, username, data }  → save stats
 */

import { getDb } from "./_db.js";

const USERNAME_RE = /^[a-zA-Z0-9_.\-]{1,40}$/;
const PLATFORMS = ["leetcode", "codeforces", "hackerrank"];
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        const db = await getDb();
        if (!db) return res.status(503).json({ error: "db_unavailable" });
        const collection = db.collection("stats");

        // Ensure TTL index exists (auto-deletes docs after 30 min)
        await collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 1800 }).catch(() => {});

        if (req.method === "GET") {
            const platform = (req.query.platform || "").toLowerCase();
            const username = (req.query.username || "").trim().toLowerCase();

            if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid_platform" });
            if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "invalid_username" });

            const doc = await collection.findOne(
                { platform, username },
                { projection: { _id: 0, data: 1, updatedAt: 1 } }
            );

            if (!doc) return res.status(404).json({ error: "not_cached" });

            // Check if still fresh
            if (Date.now() - doc.updatedAt.getTime() > CACHE_TTL_MS) {
                return res.status(404).json({ error: "cache_expired" });
            }

            return res.status(200).json({ data: doc.data, cachedAt: doc.updatedAt });

        } else if (req.method === "POST") {
            const { platform, username, data } = req.body || {};

            if (!platform || !PLATFORMS.includes(platform.toLowerCase())) {
                return res.status(400).json({ error: "invalid_platform" });
            }
            if (!username || !USERNAME_RE.test(username)) {
                return res.status(400).json({ error: "invalid_username" });
            }
            if (!data || typeof data !== "object") {
                return res.status(400).json({ error: "invalid_data" });
            }

            await collection.updateOne(
                { platform: platform.toLowerCase(), username: username.toLowerCase() },
                {
                    $set: {
                        platform: platform.toLowerCase(),
                        username: username.toLowerCase(),
                        data,
                        updatedAt: new Date(),
                    }
                },
                { upsert: true }
            );

            return res.status(200).json({ ok: true });

        } else {
            return res.status(405).json({ error: "method_not_allowed" });
        }
    } catch (err) {
        console.error("[/api/stats] Error:", err.message);
        return res.status(500).json({ error: "db_error" });
    }
}
