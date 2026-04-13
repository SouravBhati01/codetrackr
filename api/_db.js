/**
 * MongoDB Connection Singleton
 * Reuses connection across serverless function invocations (Vercel warm starts).
 * Returns null gracefully if MONGODB_URI is not configured.
 */

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "codetrackr";

let cached = global.__mongoCache;
if (!cached) {
    cached = global.__mongoCache = { client: null, db: null };
}

/**
 * Returns a connected MongoDB database instance.
 * Returns null if MONGODB_URI is not set (app works without DB).
 */
export async function getDb() {
    if (!MONGODB_URI) return null;
    if (cached.db) return cached.db;

    try {
        const client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 5,
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000,
        });
        cached.client = await client.connect();
        cached.db = cached.client.db(DB_NAME);
        return cached.db;
    } catch (err) {
        console.error("[MongoDB] Connection failed:", err.message);
        return null;
    }
}
