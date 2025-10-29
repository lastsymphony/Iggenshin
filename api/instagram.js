// api/instagram.js
import { fetchInstagramFeed } from '../lib/instagram.js';

// Cache in-memory di level module.
// Ini akan tetap ada selama instance serverless itu masih "hangat".
//
// Struktur:
// CACHE[username] = {
//   fetchedAt: <timestamp ms>,
//   posts: [ {...}, {...} ]
// }
const CACHE = Object.create(null);

// TTL cache supaya ga spam IG.
// 10 menit = 600_000 ms
const CACHE_TTL = 10 * 60 * 1000;

export default async function handler(req, res) {
  try {
    // ambil username dari query ?user=
    const username = req.query.user || req.query.username;

    if (!username) {
      res.status(400).json({
        ok: false,
        error: 'query "user" is required, e.g. /api/instagram?user=genshinimpact'
      });
      return;
    }

    const now = Date.now();
    const cached = CACHE[username];

    let posts;

    const fresh =
      cached &&
      now - cached.fetchedAt < CACHE_TTL &&
      Array.isArray(cached.posts) &&
      cached.posts.length > 0;

    if (fresh) {
      // cache masih valid
      posts = cached.posts;
    } else {
      // scrape ulang dari IG
      posts = await fetchInstagramFeed(username);

      // simpan cache baru
      CACHE[username] = {
        fetchedAt: now,
        posts
      };
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
      ok: true,
      username,
      fetchedAt: CACHE[username].fetchedAt,
      count: CACHE[username].posts.length,
      posts: CACHE[username].posts
    });
  } catch (err) {
    // kalau scraping barusan gagal (rate limit/login wall), kita coba fallback cache lama
    try {
      const username = req.query.user || req.query.username;
      const cached = CACHE[username];

      if (
        cached &&
        Array.isArray(cached.posts) &&
        cached.posts.length > 0
      ) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(200).json({
          ok: true,
          username,
          fetchedAt: cached.fetchedAt,
          cached: true,
          warning: 'using stale cache due to fetch error',
          error: err.message || String(err),
          count: cached.posts.length,
          posts: cached.posts
        });
        return;
      }
    } catch (_) {
      // kalau fallback sendiri error ya lanjut ke final 500
    }

    // kalau gak ada cache sama sekali -> error beneran
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
}
