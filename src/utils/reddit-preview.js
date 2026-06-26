const HTTP_RE = /^https?:\/\//i;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeHttpUrl(value) {
  const raw = decodeHtmlEntities(value || '').trim();
  if (!raw || !HTTP_RE.test(raw)) return null;
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function extractTag(xml, tag) {
  const re = new RegExp('<' + escapeRe(tag) + '\\b[^>]*>([\\s\\S]*?)</' + escapeRe(tag) + '>', 'i');
  const m = re.exec(String(xml || ''));
  return m ? m[1].trim() : null;
}

function extractAttrFromTag(xml, tag, attr) {
  const re = new RegExp("<" + escapeRe(tag) + "\\b[^>]*\\s" + escapeRe(attr) + "=[\"']([^\"']+)[\"'][^>]*>", 'i');
  const m = re.exec(String(xml || ''));
  return m ? m[1].trim() : null;
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function numberOrZero(v) {
  const n = numberOrNull(v);
  return n === null ? 0 : n;
}

function firstImageFromHtml(html) {
  const m = String(html || '').match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? safeHttpUrl(m[1]) : null;
}

function normalizeAuthorName(raw) {
  return String(raw || '')
    .trim()
    .replace(/^\/?u\//i, '')
    .replace(/^@/, '');
}

function normalizeSubreddit(raw) {
  return String(raw || '')
    .trim()
    .replace(/^\/?r\//i, '');
}

function createdAtMs(value) {
  if (!value) return null;
  const raw = String(value);
  const ts = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  return Number.isFinite(ts) ? ts : null;
}

export function decodeHtmlEntities(text) {
  let out = String(text || '');
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    if (next === out) break;
    out = next;
  }
  return out;
}

export function extractRedditPostId(url) {
  if (!url) return null;
  const m = String(url).match(/\/comments\/([a-z0-9]{4,12})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

export function extractSubredditFromRedditUrl(url) {
  if (!url) return null;
  const m = String(url).match(/reddit\.com\/r\/([^/?#]+)\/comments\//i);
  return m ? decodeURIComponent(m[1]) : null;
}

export function normalizeRedditPost(post) {
  if (!post || typeof post !== 'object') return null;

  const imageUrls = [];
  const push = (u) => {
    const safe = safeHttpUrl(u);
    if (safe && !imageUrls.includes(safe)) imageUrls.push(safe);
  };

  const direct = post.url_overridden_by_dest || post.url || '';
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(direct)) push(direct);
  push(post.preview?.images?.[0]?.source?.url);
  if (post.is_gallery && post.media_metadata && post.gallery_data?.items?.length) {
    for (const it of post.gallery_data.items) {
      const item = post.media_metadata[it.media_id];
      push(item?.s?.u || item?.s?.gif);
      if (imageUrls.length >= 10) break;
    }
  }

  const awards = typeof post.total_awards_received === 'number'
    ? post.total_awards_received
    : (Array.isArray(post.all_awardings) ? post.all_awardings.length : 0);

  return {
    id: String(post.id || ''),
    permalink: post.permalink ? ('https://reddit.com' + post.permalink) : '',
    title: String(post.title || '').slice(0, 400),
    text: String(post.selftext || '').slice(0, 1500),
    createdAt: post.created_utc ? post.created_utc * 1000 : null,
    author: {
      name: post.author || '',
      subreddit: post.subreddit || '',
      avatarUrl: null,
    },
    media: imageUrls[0] ? [{ type: 'photo', url: imageUrls[0], width: null, height: null }] : [],
    metrics: {
      upvotes: typeof post.score === 'number' ? post.score : (post.ups || null),
      comments: typeof post.num_comments === 'number' ? post.num_comments : null,
      views: null,
      awards,
      ratio: typeof post.upvote_ratio === 'number' ? post.upvote_ratio : null,
    },
    nsfw: !!post.over_18,
  };
}

export function parseRedditAtomFeed(xml) {
  const posts = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRe.exec(String(xml || ''))) !== null) {
    const entry = match[1];
    const title = decodeHtmlEntities(extractTag(entry, 'title') || '');
    const rawId = decodeHtmlEntities(extractTag(entry, 'id') || '');
    const link = safeHttpUrl(extractAttrFromTag(entry, 'link', 'href') || '');
    const id = rawId.replace(/^t3_/i, '').replace(/.*\//, '') || extractRedditPostId(link);
    if (!id || !title || !link) continue;

    const contentHtml = decodeHtmlEntities(extractTag(entry, 'content') || '');
    const mediaThumb = extractAttrFromTag(entry, 'media:thumbnail', 'url')
      || extractAttrFromTag(entry, 'media:content', 'url');
    const imageUrl = safeHttpUrl(mediaThumb) || firstImageFromHtml(contentHtml);
    const authorName = normalizeAuthorName(decodeHtmlEntities(extractTag(entry, 'name') || ''));
    const subreddit = normalizeSubreddit(extractAttrFromTag(entry, 'category', 'label')
      || extractAttrFromTag(entry, 'category', 'term')
      || extractSubredditFromRedditUrl(link)
      || '');
    const published = decodeHtmlEntities(extractTag(entry, 'published') || extractTag(entry, 'updated') || '');

    posts.push({
      id,
      permalink: link,
      title,
      text: stripTags(contentHtml).slice(0, 1500),
      createdAt: createdAtMs(published),
      author: {
        name: authorName,
        subreddit,
        avatarUrl: null,
      },
      media: imageUrl ? [{ type: 'photo', url: imageUrl, width: null, height: null }] : [],
      metrics: {
        upvotes: null,
        comments: null,
        views: null,
        awards: 0,
        ratio: null,
      },
      nsfw: false,
    });
  }
  return posts;
}

export function buildRedditPreviewFromTrendRow(row) {
  if (!row || typeof row !== 'object') return null;
  let metrics = {};
  try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch { metrics = {}; }

  const url = safeHttpUrl(row.url || '') || '';
  const id = extractRedditPostId(url) || String(row.external_id || '').replace(/^reddit_/i, '');
  if (!id) return null;

  const imageUrls = [];
  const push = (u) => {
    const safe = safeHttpUrl(u);
    if (safe && !imageUrls.includes(safe)) imageUrls.push(safe);
  };
  if (Array.isArray(metrics.imageUrls)) metrics.imageUrls.forEach(push);
  push(metrics.imageUrl);
  push(metrics.thumbnailUrl);
  push(metrics.thumbnail);

  const rawAuthor = metrics.author || metrics.authorUsername || metrics.user || '';
  const author = normalizeAuthorName(rawAuthor);
  const subreddit = normalizeSubreddit(metrics.subreddit || extractSubredditFromRedditUrl(url) || '');

  return {
    id,
    permalink: url,
    title: String(row.title || row.original_title || '').slice(0, 400),
    text: String(row.description || '').slice(0, 1500),
    createdAt: createdAtMs(row.first_seen_at || row.last_seen_at),
    author: {
      name: author,
      subreddit,
      avatarUrl: null,
    },
    media: imageUrls[0] ? [{ type: 'photo', url: imageUrls[0], width: null, height: null }] : [],
    metrics: {
      upvotes: numberOrNull(metrics.upvotes ?? metrics.score),
      comments: numberOrNull(metrics.comments),
      views: null,
      awards: numberOrZero(metrics.awards ?? metrics.totalAwards ?? metrics.total_awards_received),
      ratio: numberOrNull(metrics.upvoteRatio ?? metrics.ratio),
    },
    nsfw: !!(metrics.nsfw || metrics.over_18),
  };
}
