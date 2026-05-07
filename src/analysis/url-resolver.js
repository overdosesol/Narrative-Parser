// URL → synthetic-trend resolver. Used by the admin's "Ручной анализ" tab,
// the dashboard's pro/admin manual-analysis endpoint, and the Telegram bot's
// URL-paste handler. All three need to take a raw URL (Twitter/X, Reddit,
// TikTok, or any og:image-bearing page) and produce a trend object that
// Scorer can consume.
//
// Pure functions — no `this`, no class state. Extracted from admin/server.js
// 2026-05-01 when manual analysis became multi-surface.
//
// All resolvers throw on unrecoverable errors (404, parse failure, no title).
// Caller is expected to catch and report to the user.

const FETCH_TIMEOUT_MS = 8000;

/**
 * Top-level dispatcher. Picks a resolver based on the host and returns the
 * synthetic trend. Throws if the URL doesn't match any known shape and
 * generic og:image fallback also fails.
 *
 * @param {string} rawUrl
 * @returns {Promise<Object>}  trend-shaped object ready for scorer.scoreTrends()
 */
export async function resolveUrlToTrend(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('URL is empty');
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http(s)://');

  const isTwitter = /^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\//i.test(url);
  const isReddit  = /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//i.test(url);
  const isTiktok  = /^https?:\/\/(www\.)?tiktok\.com\//i.test(url);

  if (isTwitter) return resolveTwitterUrl(url);
  if (isReddit)  return resolveRedditUrl(url);
  if (isTiktok)  return resolveTiktokUrl(url);
  return resolveGenericUrl(url);
}

// ── Twitter / X ─────────────────────────────────────────────────────────────
// Uses fxtwitter's free JSON proxy (api.fxtwitter.com/i/status/<id>) — no
// auth required, returns engagement counts + author + media (main + quote
// + reply parent).

export async function resolveTwitterUrl(url) {
  const m = url.match(/(?:twitter|x)\.com\/[^/?#]+\/status\/(\d+)/i);
  if (!m) throw new Error('Not a valid tweet URL');
  const [, tweetId] = m;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Catalyst/3.0', 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`fxtwitter ${r.status}`);
    const data = await r.json();
    const tw = data?.tweet;
    if (!tw) throw new Error('Tweet not found');

    const likes    = tw.likes    || 0;
    const retweets = tw.retweets || 0;
    const replies  = tw.replies  || 0;
    const views    = tw.views    || 0;
    const author   = tw.author?.screen_name || 'unknown';
    const text     = tw.text || '';
    const createdAt = tw.created_at ? new Date(tw.created_at) : null;
    const ageHours  = createdAt ? Math.max(0.25, (Date.now() - createdAt.getTime()) / 3_600_000) : 1;
    const engagement = likes + retweets * 2;
    const velocity  = Math.round(engagement / ageHours);

    // Pull media (main + quote + reply-parent) — mirrors /api/preview
    const upgrade = (u) => {
      if (!u || !/pbs\.twimg\.com\//.test(u)) return u;
      try {
        const x = new URL(u);
        x.searchParams.set('name', 'orig');
        if (!x.searchParams.get('format')) {
          const ext = x.pathname.match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg';
          x.searchParams.set('format', ext.toLowerCase().replace('jpeg', 'jpg'));
        }
        return x.toString();
      } catch { return u; }
    };
    const imageUrls = [];
    const pushMedia = (list) => {
      if (!Array.isArray(list)) return;
      for (const m of list) {
        const raw = m?.type === 'photo' ? (m.url || m.thumbnail_url) : (m?.thumbnail_url || m?.url);
        const u = raw ? upgrade(raw) : null;
        if (u && !imageUrls.includes(u)) imageUrls.push(u);
      }
    };
    pushMedia(tw.media?.all);
    pushMedia(tw.quote?.media?.all);
    pushMedia(tw.replying_to?.media?.all);

    const pickVideo = (list) => {
      if (!Array.isArray(list)) return null;
      for (const m of list) {
        if (m?.type === 'video' || m?.type === 'gif') {
          return m.url || m.thumbnail_url;
        }
      }
      return null;
    };
    const videoUrl = pickVideo(tw.media?.all) || pickVideo(tw.quote?.media?.all) || null;

    const hashtags = [...new Set((text.match(/#\w+/g) || []).map(h => h.toLowerCase()))];
    const tickers  = [...new Set(text.match(/\$[A-Z]{2,8}/g) || [])];

    const title = (hashtags[0] && tickers[0]) ? `${hashtags[0]} ${tickers[0]}`
                : hashtags[0] || tickers[0]
                || text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().substring(0, 120);

    return {
      externalId: `manual_twitter_${tweetId}`,
      source: 'twitter',
      title: title || `Tweet by @${author}`,
      originalTitle: title || `Tweet by @${author}`,
      description: text.substring(0, 300),
      url: `https://twitter.com/${author}/status/${tweetId}`,
      metrics: {
        views, likes, retweets, replies,
        upvotes: engagement,
        velocity,
        ageHours: Math.round(ageHours * 10) / 10,
        hashtags, tickers,
        author: `@${author}`,
        followers: tw.author?.followers || 0,
        thumbnailUrl: imageUrls[0] || null,
        imageUrls,
        videoUrl,
        searchQuery: '(manual)',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Reddit ──────────────────────────────────────────────────────────────────
// Reddit's <permalink>.json endpoint — public, returns full post data
// including gallery + reddit_video fallback URLs.

export async function resolveRedditUrl(url) {
  const jsonUrl = url.replace(/\/?(\?.*)?$/, '') + '.json?raw_json=1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(jsonUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Catalyst/3.0)', 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`reddit ${r.status}`);
    const data = await r.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error('Reddit post not found');

    const score     = post.score || post.ups || 0;
    const comments  = post.num_comments || 0;
    const createdAt = post.created_utc ? new Date(post.created_utc * 1000) : null;
    const ageHours  = createdAt ? Math.max(0.25, (Date.now() - createdAt.getTime()) / 3_600_000) : 1;
    const velocity  = Math.round(score / ageHours);
    const subreddit = post.subreddit || '';
    const author    = post.author || '';

    let imageUrl = null;
    const directUrl = post.url_overridden_by_dest || post.url;
    if (directUrl && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(directUrl)) imageUrl = directUrl;
    else if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url;
    else if (post.is_gallery && post.media_metadata) {
      const firstId = post.gallery_data?.items?.[0]?.media_id;
      const item = firstId && post.media_metadata[firstId];
      imageUrl = item?.s?.u || item?.s?.gif || null;
    }
    const imageUrls = [];
    if (imageUrl) imageUrls.push(imageUrl);
    if (post.is_gallery && post.media_metadata && post.gallery_data?.items) {
      for (const it of post.gallery_data.items) {
        const m = post.media_metadata[it.media_id];
        const u = m?.s?.u || m?.s?.gif;
        if (u && !imageUrls.includes(u)) imageUrls.push(u);
      }
    }

    const videoUrl = post.preview?.reddit_video_preview?.fallback_url
                  || post.media?.reddit_video?.fallback_url
                  || null;

    return {
      externalId: `manual_reddit_${post.id}`,
      source: 'reddit',
      title: post.title || '(untitled Reddit post)',
      originalTitle: post.title || '(untitled Reddit post)',
      description: (post.selftext || '').substring(0, 400),
      url: 'https://reddit.com' + (post.permalink || ''),
      metrics: {
        upvotes: score,
        comments,
        velocity,
        ageHours: Math.round(ageHours * 10) / 10,
        subreddit,
        author: `u/${author}`,
        thumbnailUrl: imageUrls[0] || null,
        imageUrls,
        videoUrl,
        searchQuery: '(manual)',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── TikTok ──────────────────────────────────────────────────────────────────
// Two-tier resolution:
//   1. apidojo Apify actor (if APIFY_API_APIDOJO is set) — gives full
//      engagement (plays/likes/comments/shares/followers) AND a working
//      videoUrl that Stage 0 Gemini-captioner can fetch nativно with proper
//      Referer. Cost ~$0.0003 per single-URL run (1 item × $0.30/1K).
//   2. oEmbed fallback — free, but only title + author + thumbnail. Used
//      when apidojo isn't configured OR when the actor call fails. Stage 0
//      has to fall through to image captioning in this path.
//
// Why force apidojo here even when collector is set to clockworks: clockworks
// doesn't return videoUrl unless `shouldDownloadVideos: true` (which ships
// off for cost reasons). For a one-off manual analysis, the user explicitly
// wants the best signal — apidojo's videoUrl is exactly the thing we want
// flowing into Gemini visual captioning. Clockworks scrape on a single URL
// would give engagement but no video — strictly worse than apidojo here.

const APIDOJO_TIKTOK_ACTOR = 'apidojo~tiktok-scraper';
const APIDOJO_TIMEOUT_SECS = 60;

export async function resolveTiktokUrl(url) {
  const videoIdMatch = url.match(/\/video\/(\d+)/);
  if (!videoIdMatch) throw new Error('Not a valid TikTok URL');
  const videoId = videoIdMatch[1];

  // Normalize the URL before sending to apidojo: tracking query params
  // (?is_from_webapp=1&sender_device=pc&...) and hash fragments confuse
  // the actor — it sometimes returns a degraded record without video.url
  // (the MP4 CDN link), which makes Gemini fall through to the poster
  // and ultimately produces an empty preStage.gemini block. Stripping
  // ?query and #hash gives apidojo the canonical /@author/video/<id>
  // form which is what its scraper actually understands.
  url = url.split('?')[0].split('#')[0];

  // Tier 1: apidojo — full engagement + video URL.
  // Token fallback chain matches the collector (`tiktok.js _activeActor`):
  //   APIFY_API_APIDOJO  — preferred, dedicated per-actor key
  //   APIFY_API          — generic single-account fallback (most users have this)
  // One Apify account / token can run any actor it's been granted permission
  // to. Some third-party actors (like apidojo) trigger a one-time
  // "approve permissions" prompt in Apify Console — until that's done, the
  // actor returns 403 `full-permission-actor-not-approved`. We treat that
  // as a soft-fail and keep the oEmbed fallback for manual analysis.
  const apidojoKey = process.env.APIFY_API_APIDOJO || process.env.APIFY_API || '';
  if (apidojoKey) {
    try {
      const fromActor = await _resolveTiktokViaApidojo(url, videoId, apidojoKey);
      if (fromActor) return fromActor;
    } catch (e) {
      // Soft-fail to oEmbed — manual analysis should never hard-fail because
      // a paid actor had a hiccup. Log via console (resolver has no logger).
      // eslint-disable-next-line no-console
      console.warn(`[url-resolver] apidojo TikTok failed (${e.message}), falling back to oEmbed`);
    }
  }

  // Tier 2: oEmbed fallback.
  return _resolveTiktokViaOembed(url, videoId);
}

async function _resolveTiktokViaApidojo(url, videoId, apiKey) {
  const runUrl = `https://api.apify.com/v2/acts/${APIDOJO_TIKTOK_ACTOR}/run-sync-get-dataset-items?timeout=${APIDOJO_TIMEOUT_SECS}`;
  const input = {
    startUrls: [{ url }],
    maxItems: 1,
    // Single-URL scrape, sort doesn't matter, but apidojo schema requires it.
    sortType: 'RELEVANCE',
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  };
  // 60s timeout headroom for the Apify run (which itself has 60s server-side cap)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (APIDOJO_TIMEOUT_SECS + 10) * 1000);
  try {
    const r = await fetch(runUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(input),
    });
    clearTimeout(timer);
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Apify ${r.status}: ${errText.substring(0, 200)}`);
    }
    const items = await r.json();
    if (!Array.isArray(items) || items.length === 0) return null;
    const v = items[0];

    // Mirror the field-fallback chain in tiktok.js _normalize so manual
    // analysis sees the same shape the cycle-collector produces.
    // apidojo's actual schema (verified via curl on the running actor):
    //   { id, title (caption), views, likes, comments, shares,
    //     channel: { username, followers, ... },
    //     uploadedAt (UNIX seconds),
    //     video: { url (CDN mp4), cover, thumbnail, duration, ... },
    //     hashtags: ["bare","strings","without","#"] }
    const text     = v.text || v.desc || v.description || v.title || '';
    const plays    = v.playCount    || v.views          || 0;
    const likes    = v.diggCount    || v.likeCount      || v.likes    || 0;
    const comments = v.commentCount || v.comments       || 0;
    const shares   = v.shareCount   || v.shares         || 0;
    const author   = v.authorMeta?.name
                  || v.authorUsername
                  || v.author?.uniqueId
                  || v.channel?.username
                  || 'unknown';
    const followers = v.authorMeta?.fans
                   || v.authorMeta?.followers
                   || v.authorMeta?.followerCount
                   || v.author?.fans
                   || v.channel?.followers
                   || 0;

    const thumb = v.originCoverUrl
               || v.covers?.[0]
               || (typeof v.covers === 'object' && v.covers && (v.covers.default || v.covers.origin))
               || v.cover
               || v.dynamicCover
               || v.shareCover?.[0]
               || v.imageUrl
               || v.video?.cover
               || v.video?.thumbnail
               || null;

    // Skip music/audio URLs — apidojo fallback fields sometimes carry the
    // TikTok soundtrack mp3 (on `*-music*.tiktokcdn.com`) instead of the
    // actual video MP4. See tiktok.js _firstNonAudioUrl for the same logic.
    const videoCandidates = [
      v.video?.url,
      v.videoUrlNoWaterMark,
      typeof v.videoUrl === 'string' ? v.videoUrl : null,
      Array.isArray(v.mediaUrls) ? v.mediaUrls[0] : null,
      v.videoMeta?.downloadAddr,
      v.videoMeta?.playAddr,
    ];
    const videoUrl = videoCandidates.find(
      u => typeof u === 'string' && u && !/\/ies-music|-music[-.]|\.mp3(\?|$)/i.test(u),
    ) || null;

    const createdUnix = v.createTime || v.uploadedAt || null;
    const createdAt = createdUnix ? new Date(createdUnix * 1000) : null;
    const ageHours = createdAt ? Math.max(0.25, (Date.now() - createdAt.getTime()) / 3_600_000) : 1;

    const hashtagMatches = text.match(/#\w+/g) || [];
    const hashtags = [...new Set(hashtagMatches.map(h => h.toLowerCase()))];
    const tickerMatches = text.match(/\$[A-Z]{2,8}/g) || [];
    const tickers = [...new Set(tickerMatches)];

    const cleanTitle = text.replace(/https?:\/\/\S+/g, '').replace(/#\w+|@\w+|\$\w+/g, '').replace(/\s+/g, ' ').trim().substring(0, 120)
                    || `TikTok video by @${author}`;

    return {
      externalId: `manual_tiktok_${videoId}`,
      source: 'tiktok',
      title: cleanTitle,
      originalTitle: cleanTitle,
      description: text.substring(0, 300),
      url,
      metrics: {
        plays,
        likes,
        comments,
        shares,
        followers,
        upvotes: likes + shares * 3,                   // upvotes-equiv
        velocity: Math.round(plays / Math.max(ageHours, 1)),
        ageHours: Math.round(ageHours * 10) / 10,
        hashtags,
        tickers,
        author: `@${author}`,
        thumbnailUrl: thumb,
        imageUrls: thumb ? [thumb] : [],
        videoUrl,
        searchQuery: '(manual)',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function _resolveTiktokViaOembed(url, videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Catalyst/3.0', 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`tiktok ${r.status}`);
    const data = await r.json();
    const title  = (data.title || '').substring(0, 200);
    const author = data.author_name || '';
    const thumb  = data.thumbnail_url || null;
    return {
      externalId: `manual_tiktok_${videoId}`,
      source: 'tiktok',
      title: title || '(TikTok video)',
      originalTitle: title || '(TikTok video)',
      description: title,
      url,
      metrics: {
        upvotes: 0,
        comments: 0,
        velocity: 0,
        ageHours: 1,
        author: `@${author}`,
        thumbnailUrl: thumb,
        imageUrls: thumb ? [thumb] : [],
        videoUrl: null,
        searchQuery: '(manual)',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Generic web page (og:image / og:title) ──────────────────────────────────

export async function resolveGenericUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Catalyst/3.0)' },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html')) throw new Error('Not an HTML page');
    const html = await r.text();
    const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };
    const title = pick(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
               || pick(/<title[^>]*>([^<]+)<\/title>/i);
    const desc  = pick(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
               || pick(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const image = pick(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const cleanTitle = (title || '').replace(/\s+/g, ' ').trim().substring(0, 200);
    const cleanDesc  = (desc  || '').replace(/\s+/g, ' ').trim().substring(0, 400);
    if (!cleanTitle) throw new Error('No title or og:title found on page');
    return {
      externalId: `manual_web_${Buffer.from(url).toString('base64').substring(0, 16)}`,
      source: 'web',
      title: cleanTitle,
      originalTitle: cleanTitle,
      description: cleanDesc,
      url,
      metrics: {
        upvotes: 0,
        comments: 0,
        velocity: 0,
        ageHours: 1,
        thumbnailUrl: image || null,
        imageUrls: image ? [image] : [],
        videoUrl: null,
        searchQuery: '(manual)',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
