// lib/instagram.js
import fetch from "node-fetch";

// beberapa UA desktop/mobile nyata biar ga keliatan bot
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// tiny sleep untuk jitter anti-pattern scraping
function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * STEP 1 (PRIORITAS): hit endpoint JSON langsung
 * https://www.instagram.com/api/v1/users/web_profile_info/?username=<username>
 *
 * Ini sering balik:
 * {
 *   "data": {
 *     "user": {
 *        "edge_owner_to_timeline_media": {
 *           "edges": [...]
 *        },
 *        ...
 *     }
 *   },
 *   "status": "ok"
 * }
 */
async function fetchProfileJson(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": pickUA(),
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.8",
      "Referer": `https://www.instagram.com/${username}/`,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty"
    }
  });

  if (res.status === 429) throw new Error("RATE_LIMIT");
  if (res.status === 403) throw new Error("FORBIDDEN");
  if (!res.ok) throw new Error(`IG_FETCH_${res.status}`);

  // kadang IG balikin HTML login-wall juga di endpoint ini kalau IP keblok
  const text = await res.text();
  // coba parse sebagai JSON
  try {
    return JSON.parse(text);
  } catch {
    // bukan JSON → kemungkinan login wall disguised
    throw new Error("LOGIN_WALL");
  }
}

/**
 * STEP 2 (FALLBACK): scrape HTML profil lama dan cari script yg embed JSON
 * (yang sebelumnya kita lakukan)
 */
function extractSharedDataFromHTML(html) {
  // pattern modern: __additionalDataLoaded("...", {...});
  const additionalMatch = html.match(
    /__additionalDataLoaded\([^,]+,\s*(\{.+?\})\);/s
  );
  if (additionalMatch) {
    try {
      return JSON.parse(additionalMatch[1]);
    } catch (e) {}
  }

  // pattern lama: window._sharedData = {...};
  const sharedMatch = html.match(
    /window\._sharedData\s*=\s*(\{.+?\});<\/script>/s
  );
  if (sharedMatch) {
    try {
      return JSON.parse(sharedMatch[1]);
    } catch (e) {}
  }

  return null;
}

async function fetchProfileHTML(username) {
  const profileUrl = `https://www.instagram.com/${username}/`;

  const res = await fetch(profileUrl, {
    headers: {
      "User-Agent": pickUA(),
      "Accept-Language": "en-US,en;q=0.8",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1"
    }
  });

  if (res.status === 429) throw new Error("RATE_LIMIT");
  if (res.status === 403) throw new Error("FORBIDDEN");
  if (!res.ok) throw new Error(`IG_FETCH_${res.status}`);

  return res.text();
}

/**
 * Normalisasi struktur feed jadi array {id,url,caption,imageUrl,timestamp}
 */
function normalizePostsFromEdges(edges) {
  if (!edges || !Array.isArray(edges)) return [];

  return edges.map(edge => {
    const node = edge.node || edge;

    const shortcode = node.shortcode;
    const caption =
      node.edge_media_to_caption?.edges?.[0]?.node?.text || "";
    const imageUrl =
      node.display_url ||
      node.thumbnail_src ||
      node.thumbnail_url ||
      "";

    return {
      id: shortcode,
      url: `https://www.instagram.com/p/${shortcode}/`,
      caption,
      imageUrl,
      timestamp: node.taken_at_timestamp || null
    };
  });
}

/**
 * Try to pull edges[] from JSON (preferred path)
 */
function extractEdgesFromProfileJson(json) {
  return json?.data?.user?.edge_owner_to_timeline_media?.edges || [];
}

/**
 * Try to pull edges[] from legacy HTML JSON blobs
 */
function extractEdgesFromSharedData(rawJson) {
  // legacy classic
  let edges =
    rawJson?.entry_data?.ProfilePage?.[0]?.graphql?.user
      ?.edge_owner_to_timeline_media?.edges;

  // newer style
  if (!edges) {
    edges =
      rawJson?.data?.user?.edge_owner_to_timeline_media?.edges;
  }

  return edges || [];
}

/**
 * === MAIN EXPORT ===
 * Ambil feed IG publik jadi array post terbaru.
 * Urutkan berdasarkan timestamp desc.
 */
export async function fetchInstagramFeed(username, limit = 10) {
  if (!username) throw new Error("username is required");

  // random tiny jitter supaya gak keliatan bot spam
  await wait(80 + Math.floor(Math.random() * 220));

  // 1. Coba endpoint JSON resmi dulu
  try {
    const profileJson = await fetchProfileJson(username);
    const edges = extractEdgesFromProfileJson(profileJson);
    const posts = normalizePostsFromEdges(edges);

    if (!posts.length) throw new Error("NO_POSTS");

    const sorted = posts
      .filter(p => p.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp);

    return sorted.slice(0, limit);
  } catch (err) {
    // kalau ini RATE_LIMIT / FORBIDDEN / LOGIN_WALL
    // kita lanjut coba fallback HTML
    if (
      err.message !== "RATE_LIMIT" &&
      err.message !== "FORBIDDEN" &&
      err.message !== "LOGIN_WALL" &&
      !err.message?.startsWith?.("IG_FETCH_")
    ) {
      // error yang bukan spesifik blok -> lempar aja langsung
      // (mis: parsing internal aneh)
      throw err;
    }

    // else kita coba fallback
  }

  // 2. Fallback: scrape HTML profile
  const html = await fetchProfileHTML(username);
  const rawJson = extractSharedDataFromHTML(html);
  if (!rawJson) {
    throw new Error("NO_STRUCTURE");
  }

  const edges = extractEdgesFromSharedData(rawJson);
  const posts = normalizePostsFromEdges(edges);
  if (!posts.length) {
    throw new Error("NO_POSTS");
  }

  const sorted = posts
    .filter(p => p.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp);

  return sorted.slice(0, limit);
}
