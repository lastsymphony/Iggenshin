// lib/instagram.js
import fetch from 'node-fetch';

// User-Agent custom biar IG gak langsung kasih login wall.
// Hindari UA default Node.js karena kadang langsung diblok.
const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; KatheryneBot) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36';

// --- helper: ambil JSON internal yg IG embed di HTML ---
//
// IG suka naro data feed profile di salah satu dari 2 pola ini:
// 1) __additionalDataLoaded("...profilePage_...", {...});
// 2) window._sharedData = {...};
//
// Kita coba regex keduanya.
function extractSharedData(html) {
  // Pola (lebih baru / modern): __additionalDataLoaded("...", {...});
  // /s supaya dot (.) match newline
  const additionalMatch = html.match(
    /__additionalDataLoaded\([^,]+,\s*(\{.+?\})\);/s
  );
  if (additionalMatch) {
    try {
      const parsed = JSON.parse(additionalMatch[1]);
      return parsed;
    } catch (e) {
      // ignore parse fail, fallback ke pola lain
    }
  }

  // Pola (lebih lama): window._sharedData = {...};
  const sharedMatch = html.match(
    /window\._sharedData\s*=\s*(\{.+?\});<\/script>/s
  );
  if (sharedMatch) {
    try {
      const parsed = JSON.parse(sharedMatch[1]);
      return parsed;
    } catch (e) {
      // ignore
    }
  }

  // Kalau dua-duanya gak ada -> kemungkinan IG ngasih "login wall" minimal
  // (itu kejadian di beberapa HTML dump kayak yang kamu upload).
  return null;
}

// --- helper: normalisasi struktur feed jadi bentuk yang konsisten ---
//
// Target post final:
// {
//   id: "C9abcXYZ",
//   url: "https://www.instagram.com/p/C9abcXYZ/",
//   caption: "Furina supremacy 💦",
//   imageUrl: "https://...jpg",
//   timestamp: 1730183000
// }
function normalizePosts(rawJson) {
  // Struktur klasik IG web:
  // rawJson.entry_data.ProfilePage[0].graphql.user.edge_owner_to_timeline_media.edges
  let edges =
    rawJson?.entry_data?.ProfilePage?.[0]?.graphql?.user
      ?.edge_owner_to_timeline_media?.edges;

  // Struktur yang lebih baru (umumnya dari __additionalDataLoaded):
  // rawJson.data.user.edge_owner_to_timeline_media.edges
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
    const imageUrl =
      node.display_url ||
      node.thumbnail_src ||
      node.thumbnail_url ||
      '';

    return {
      id: shortcode,
      url: `https://www.instagram.com/p/${shortcode}/`,
      caption,
      imageUrl,
      timestamp: node.taken_at_timestamp || null // unix detik
    };
  });
}

// --- main function: ambil feed IG publik jadi array post ---
//
// `limit` = max jumlah post yang kamu mau ambil (default 10)
export async function fetchInstagramFeed(username, limit = 10) {
  if (!username) {
    throw new Error('username is required');
  }

  const profileUrl = `https://www.instagram.com/${username}/`;

  const res = await fetch(profileUrl, {
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept-Language': 'en-US,en;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  if (!res.ok) {
    // Bisa 429 (rate limit), 403, dll
    throw new Error(`IG fetch fail ${res.status}`);
  }

  const html = await res.text();

  // Ambil JSON feed yang di-inline sama IG
  const rawJson = extractSharedData(html);
  if (!rawJson) {
    // Ini biasa terjadi kalau IG balikin halaman login-wall ringan,
    // bukan halaman profil full. Mirip dengan file HTML profil yang kamu upload,
    // yang mostly cuma meta tanpa payload feed post.
    throw new Error('IG structure not recognized (maybe login wall / rate limited)');
  }

  // Rapikan hasilnya
  const posts = normalizePosts(rawJson);
  if (!posts.length) {
    throw new Error('No posts found (account private / no posts / blocked)');
  }

  // Urutkan terbaru → lama pakai timestamp desc,
  // walau IG biasanya udah ngasih urutan benar.
  const sorted = posts
    .filter(p => p.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp);

  return sorted.slice(0, limit);
}
