// api/ig/[username].js
import { fetchInstagramFeed } from '../../../lib/instagram.js';

// Cache global in-memory per instance lambda.
// Ini gak persist forever, tapi sangat ngurangin hit IG.
// Struktur CACHE:
// {
//   genshinimpact: { fetchedAt: 1730184000000, posts: [...] },
//   hoyolab: { ... }
// }
const CACHE = Object.create(null);

// TTL cache dalam ms
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

export default async function handler(req, res) {
  try {
    const { username } = req.query;

    if (!username) {
      res.status(400).json({
        ok: false,
        error: 'username required'
      });
      return;
    }

    const now = Date.now();
    const currentCache = CACHE[username];

    let posts;

    // 1. pakai cache kalau masih valid
    if (
      currentCache &&
      now - currentCache.fetchedAt < CACHE_TTL &&
      Array.isArray(currentCache.posts) &&
      currentCache.posts.length > 0
    ) {
      posts = currentCache.posts;
    } else {
      // 2. scrape ulang
      posts = await fetchInstagramFeed(username);

      // 3. simpan ke cache
      CACHE[username] = {
        fetchedAt: now,
        posts
      };
    }

    // 4. kirim JSON final
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
      ok: true,
      username,
      fetchedAt: CACHE[username].fetchedAt,
      count: CACHE[username].posts.length,
      posts: CACHE[username].posts
    });
  } catch (err) {
    // Kalau error scraping IG, tetap balikin 500.
    // (Opsional: kamu bisa fallback cache lama kalau ada,
    // tapi itu bikin data bisa stale tanpa ketahuan.
    // Kalo kamu mau fallback, aku bisa tulis versi 2.)
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
}
