/**
 * /api/history — Store and retrieve search history per platform
 *
 * GET    /api/history?platform=leetcode          → get recent searches for platform
 * POST   /api/history  body: { platform, username } → record a search
 * DELETE /api/history?platform=leetcode           → clear history for platform
 */

import { getDb } from "./_db.js";

const USERNAME_RE = /^[a-zA-Z0-9_.\-]{1,40}$/;
const PLATFORMS = ["leetcode", "codeforces", "hackerrank"];
const MAX_HISTORY = 20;

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        const db = await getDb();
        if (!db) return res.status(503).json({ error: "db_unavailable" });
        const collection = db.collection("history");

        // Compound index for fast lookups
        await collection.createIndex({ platform: 1, searchedAt: -1 }).catch(() => {});

        if (req.method === "GET") {
            const platform = (req.query.platform || "").toLowerCase();
            if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid_platform" });

            const limit = Math.min(parseInt(req.query.limit) || 10, MAX_HISTORY);

            const docs = await collection
                .find({ platform }, { projection: { _id: 0, username: 1, searchedAt: 1 } })
                .sort({ searchedAt: -1 })
                .limit(limit)
                .toArray();

            // Deduplicate by username (keep most recent)
            const seen = new Set();
            const unique = docs.filter(function (d) {
                var key = d.username;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            return res.status(200).json({ history: unique });

        } else if (req.method === "POST") {
            const { platform, username } = req.body || {};

            if (!platform || !PLATFORMS.includes(platform.toLowerCase())) {
                return res.status(400).json({ error: "invalid_platform" });
            }
            if (!username || !USERNAME_RE.test(username)) {
                return res.status(400).json({ error: "invalid_username" });
            }

            await collection.insertOne({
                platform: platform.toLowerCase(),
                username: username.toLowerCase(),
                searchedAt: new Date(),
            });

            // Cleanup: keep only last MAX_HISTORY entries per platform
            const count = await collection.countDocuments({ platform: platform.toLowerCase() });
            if (count > MAX_HISTORY * 2) {
                const oldest = await collection
                    .find({ platform: platform.toLowerCase() })
                    .sort({ searchedAt: -1 })
                    .skip(MAX_HISTORY)
                    .limit(1)
                    .toArray();

                if (oldest.length) {
                    await collection.deleteMany({
                        platform: platform.toLowerCase(),
                        searchedAt: { $lt: oldest[0].searchedAt },
                    });
                }
            }

            return res.status(200).json({ ok: true });

        } else if (req.method === "DELETE") {
            const platform = (req.query.platform || "").toLowerCase();
            if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid_platform" });

            await collection.deleteMany({ platform });
            return res.status(200).json({ ok: true });

        } else {
            return res.status(405).json({ error: "method_not_allowed" });
        }
    } catch (err) {
        console.error("[/api/history] Error:", err.message);
        return res.status(500).json({ error: "db_error" });
    }
}
