// api/instagram.js
import { fetchInstagramFeed } from "../lib/instagram.js";

// Cache in-memory per instance
// bentuk:
// CACHE[username] = {
//   fetchedAt: <ms>,
//   posts: [ ... ],
//   lastScrapeAt: <ms>    // buat anti-spam burst
// }
const CACHE = Object.create(null);

// TTL normal cache (ms)
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

// cooldown minimal antar-scrape keras (ms)
// kalau ada request spam berturut2 <COOLDOWN_SCRAPE ms
// kita langsung balikin cache aja, jangan scrape ulang
const COOLDOWN_SCRAPE = 5000; // 5 detik

export default async function handler(req, res) {
  const username = req.query.user || req.query.username;

  if (!username) {
    res.status(400).json({
      ok: false,
      error:
        'query "user" is required, e.g. /api/instagram?user=genshinimpact'
    });
    return;
  }

  const now = Date.now();
  const cached = CACHE[username];

  // helper buat kirim sukses
  const sendOk = (data, extra = {}) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      ok: true,
      username,
      fetchedAt: data.fetchedAt,
      count: data.posts.length,
      posts: data.posts,
      ...extra
    });
  };

  // helper buat kirim error final
  const sendErr = (code, msg) => {
    res.status(code).json({
      ok: false,
      username,
      error: msg
    });
  };

  // CEK 1: kalau cache ada & masih fresh (TTL 10 menit)
  const cacheFresh =
    cached &&
    now - cached.fetchedAt < CACHE_TTL &&
    Array.isArray(cached.posts) &&
    cached.posts.length > 0;

  if (cacheFresh) {
    // aman langsung kirim cache
    sendOk(cached, { cache: true, note: "fresh-cache" });
    return;
  }

  // CEK 2: kalau cache ada tapi expired, tapi baru aja scrape (<5 detik)
  // -> jangan scrape ulang, balikin cache lama walau expired.
  const justScraped =
    cached && cached.lastScrapeAt && now - cached.lastScrapeAt < COOLDOWN_SCRAPE;

  if (cached && justScraped) {
    sendOk(cached, {
      cache: true,
      stale: true,
      note: "cooldown-returning-stale"
    });
    return;
  }

  // Kalau sampai sini berarti:
  // - gak ada cache, atau
  // - cache ada tapi udah expired dan cooldown lewat
  // → kita coba scrape baru

  // tandai kita sedang scrape sekarang (buat cooldown selanjutnya)
  if (!CACHE[username]) CACHE[username] = {};
  CACHE[username].lastScrapeAt = now;

  try {
    const posts = await fetchInstagramFeed(username);

    // update cache
    CACHE[username].fetchedAt = now;
    CACHE[username].posts = posts;

    sendOk(CACHE[username], { cache: false, note: "fresh-scrape" });
    return;
  } catch (err) {
    // Scrape gagal. Kita coba fallback pakai cache lama kalau ada.
    // err.message bisa "RATE_LIMIT", "FORBIDDEN", "NO_STRUCTURE", "NO_POSTS", dll.

    if (
      cached &&
      Array.isArray(cached.posts) &&
      cached.posts.length > 0
    ) {
      // kita kirim cache lama tapi tandai stale & warning
      sendOk(cached, {
        cache: true,
        stale: true,
        warning: "fallback-stale-cache",
        scrapeError: err.message || String(err)
      });
      return;
    }

    // kalau gak ada cache sama sekali, yaudah error beneran
    // kalau RATE_LIMIT -> 503 (temporarily unavailable)
    if (err.message === "RATE_LIMIT") {
      sendErr(503, "Instagram rate limited this IP (429). Try later.");
      return;
    }

    // login wall / forbidden etc => 502
    if (
      err.message === "FORBIDDEN" ||
      err.message === "NO_STRUCTURE"
    ) {
      sendErr(502, "Instagram returned login wall / blocked content.");
      return;
    }

    // default
    sendErr(500, err.message || "Unknown scrape error");
  }
}
