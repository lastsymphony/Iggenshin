// api/instagram.js
import { fetchInstagramFeed } from "../lib/instagram.js";

// cache in-memory per instance serverless
// CACHE[username] = {
//   fetchedAt: <ms>,
//   posts: [...],
//   lastScrapeAt: <ms>
// }
const CACHE = Object.create(null);

const CACHE_TTL = 10 * 60 * 1000;    // 10 menit
const COOLDOWN_SCRAPE = 5000;        // 5 detik anti spam burst

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

  const sendErr = (code, msg) => {
    res.status(code).json({
      ok: false,
      username,
      error: msg
    });
  };

  // 1. Cache fresh?
  const cacheFresh =
    cached &&
    now - cached.fetchedAt < CACHE_TTL &&
    Array.isArray(cached.posts) &&
    cached.posts.length > 0;

  if (cacheFresh) {
    sendOk(cached, { cache: true, note: "fresh-cache" });
    return;
  }

  // 2. Cache ada tapi expired, dan baru aja scrape <5 detik lalu?
  const justScraped =
    cached &&
    cached.lastScrapeAt &&
    now - cached.lastScrapeAt < COOLDOWN_SCRAPE;

  if (cached && justScraped) {
    sendOk(cached, {
      cache: true,
      stale: true,
      note: "cooldown-returning-stale"
    });
    return;
  }

  // 3. Waktunya scrape baru
  if (!CACHE[username]) CACHE[username] = {};
  CACHE[username].lastScrapeAt = now;

  try {
    const posts = await fetchInstagramFeed(username);

    CACHE[username].fetchedAt = now;
    CACHE[username].posts = posts;

    sendOk(CACHE[username], { cache: false, note: "fresh-scrape" });
    return;
  } catch (err) {
    // Gagal scrape
    // Kita lihat dulu apakah kita punya cache sebelumnya
    if (
      cached &&
      Array.isArray(cached.posts) &&
      cached.posts.length > 0
    ) {
      sendOk(cached, {
        cache: true,
        stale: true,
        warning: "fallback-stale-cache",
        scrapeError: err.message || String(err)
      });
      return;
    }

    // Tidak ada cache sama sekali → bener-bener error
    const msg = err.message || "Unknown scrape error";

    // Mapping error → status code
    if (msg === "RATE_LIMIT") {
      sendErr(503, "Instagram rate limited this IP (429). Try later.");
      return;
    }
    if (msg === "FORBIDDEN" || msg === "LOGIN_WALL") {
      sendErr(502, "Instagram blocked / login wall for this request.");
      return;
    }
    if (msg === "NO_STRUCTURE") {
      sendErr(502, "Instagram did not return feed structure.");
      return;
    }
    if (msg === "NO_POSTS") {
      sendErr(404, "No posts found or profile is private/empty.");
      return;
    }
    if (msg.startsWith("IG_FETCH_")) {
      sendErr(502, `Instagram fetch error ${msg.replace("IG_FETCH_", "")}`);
      return;
    }

    // default
    sendErr(500, msg);
  }
}
