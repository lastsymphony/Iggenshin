// lib/instagram.js
import fetch from "node-fetch";

// Kumpulan beberapa UA mobile realistic
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; KatheryneBot) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36'
];

// Ambil UA random biar ga fix 1 fingerprint
function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- helper: ambil JSON internal yg IG embed di HTML ---
//
// IG kadang naro data feed profile di salah satu pola ini:
// 1) __additionalDataLoaded("...", {...});
// 2) window._sharedData = {...};
function extractSharedData(html) {
  const additionalMatch = html.match(
    /__additionalDataLoaded\([^,]+,\s*(\{.+?\})\);/s
  );
  if (additionalMatch) {
    try {
      return JSON.parse(additionalMatch[1]);
    } catch (e) {}
  }

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

// Normalisasi hasil jadi array post rapi
function normalizePosts(rawJson) {
  let edges =
    rawJson?.entry_data?.ProfilePage?.[0]?.graphql?.user
      ?.edge_owner_to_timeline_media?.edges;

  if (!edges) {
    edges =
      rawJson?.data?.user?.edge_owner_to_timeline_media?.edges;
  }

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

// helper kecil buat tidur (delay kecil)
function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// scrape feed IG publik → array post
export async function fetchInstagramFeed(username, limit = 10) {
  if (!username) {
    throw new Error("username is required");
  }

  // kita bikin sedikit jitter delay random 100-400ms
  await wait(100 + Math.floor(Math.random() * 300));

  const profileUrl = `https://www.instagram.com/${username}/`;

  // header lebih lengkap biar keliatan browser beneran
  const headers = {
    "User-Agent": pickUA(),
    "Accept-Language": "en-US,en;q=0.8",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
  };

  const res = await fetch(profileUrl, { headers });

  // Kalau rate limit (429) atau forbidden/loginwall (403), lempar error khusus
  if (res.status === 429) {
    throw new Error("RATE_LIMIT");
  }
  if (res.status === 403) {
    throw new Error("FORBIDDEN");
  }
  if (!res.ok) {
    throw new Error(`IG_FETCH_${res.status}`);
  }

  const html = await res.text();

  const rawJson = extractSharedData(html);
  if (!rawJson) {
    // IG kasih login wall/minimal page → ga ada feed JSON
    throw new Error("NO_STRUCTURE");
  }

  const posts = normalizePosts(rawJson);
  if (!posts.length) {
    throw new Error("NO_POSTS");
  }

  const sorted = posts
    .filter(p => p.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp);

  return sorted.slice(0, limit);
}
