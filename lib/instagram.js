// lib/instagram.js
import fetch from 'node-fetch';

// User-Agent biar keliatan kayak browser mobile biasa.
// Jangan pakai UA default node karena IG kadang balikin "please login".
const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; KatheryneBot) AppleWebKit/537.36 Mobile Safari/537.36';

// --- helper: ambil JSON internal dari HTML ---
// Instagram embed data post di beberapa pola. Kita cover 2 pola umum:
//
// 1) __additionalDataLoaded("something", {...});
// 2) window._sharedData = {...};
//
// Kita coba parse keduanya.
function extractSharedData(html) {
  // Pola baru: __additionalDataLoaded("...profilePage_", {...});
  // /s flag = dotall biar "." bisa match newline
  const additionalMatch = html.match(
    /__additionalDataLoaded\([^,]+,\s*(\{.+?\})\);/s
  );
  if (additionalMatch) {
    try {
      return JSON.parse(additionalMatch[1]);
    } catch (e) {
      // abaikan, coba pola lain
    }
  }

  // Pola lama: window._sharedData = {...};
  const sharedMatch = html.match(
    /window\._sharedData\s*=\s*(\{.+?\});<\/script>/s
  );
  if (sharedMatch) {
    try {
      return JSON.parse(sharedMatch[1]);
    } catch (e) {
      // abaikan, fallback gagal -> return null
    }
  }

  return null;
}

// --- helper: normalisasi struktur ke bentuk yang rapi ---
//
// Target final post object:
// {
//   id: "C9abcXYZ",
//   url: "https://www.instagram.com/p/C9abcXYZ/",
//   caption: "Furina supremacy 💦",
//   imageUrl: "https://...jpg",
//   timestamp: 1730183000
// }
function normalizePosts(rawJson) {
  // Struktur klasik IG:
  // rawJson.entry_data.ProfilePage[0].graphql.user.edge_owner_to_timeline_media.edges
  let edges =
    rawJson?.entry_data?.ProfilePage?.[0]?.graphql?.user
      ?.edge_owner_to_timeline_media?.edges;

  // Struktur yang lebih baru (kadang muncul di __additionalDataLoaded):
  if (!edges) {
    edges =
      rawJson?.data?.user?.edge_owner_to_timeline_media?.edges;
  }

  if (!edges || !Array.isArray(edges)) return [];

  return edges.map(edge => {
    const node = edge.node || edge;

    const shortcode = node.shortcode;
    const caption =
      node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const img =
      node.display_url ||
      node.thumbnail_src ||
      node.thumbnail_url ||
      '';

    return {
      id: shortcode,
      url: `https://www.instagram.com/p/${shortcode}/`,
      caption,
      imageUrl: img,
      timestamp: node.taken_at_timestamp || null // unix detik
    };
  });
}

// --- main fetch function ---
// Ambil max N post terbaru dari profil IG publik
export async function fetchInstagramFeed(username, limit = 10) {
  const profileUrl = `https://www.instagram.com/${username}/`;

  const res = await fetch(profileUrl, {
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept-Language': 'en-US,en;q=0.8'
    }
  });

  if (!res.ok) {
    throw new Error(`IG fetch fail ${res.status}`);
  }

  const html = await res.text();

  // Ambil JSON post list dari HTML
  const rawJson = extractSharedData(html);
  if (!rawJson) {
    throw new Error('IG structure not recognized');
  }

  // Rapiin jadi array post sederhana
  const posts = normalizePosts(rawJson);
  if (!posts.length) {
    throw new Error('No posts found');
  }

  // Sort terbaru → lama pakai timestamp (descending)
  // IG biasanya udah urut terbaru duluan, tapi kita yakinkan aja.
  const sorted = posts
    .filter(p => p.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp);

  return sorted.slice(0, limit);
}
