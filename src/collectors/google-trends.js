import BaseCollector from './base-collector.js';

/**
 * Google Trends collector — uses Google Trends RSS feed
 * Endpoint: https://trends.google.com/trending/rss?geo=XX
 */
class GoogleTrendsCollector extends BaseCollector {
  constructor(config, logger) {
    super('GoogleTrends', logger);
    this.geo = config.googleTrends.geo || 'US';
  }

  async collect() {
    const allItems = [];

    // Fetch multiple geos for worldwide coverage
    const geos = this.geo ? [this.geo] : ['US', 'GB', 'DE', 'JP', 'BR', 'IN', 'FR'];

    for (const geo of geos) {
      try {
        const items = await this._fetchTrendingRSS(geo);
        allItems.push(...items);
        await this._delay(1000);
      } catch (error) {
        this.logger.warn(`[GoogleTrends] Failed for geo=${geo}: ${error.message}`);
      }
    }

    // Deduplicate by title and filter low-traffic trends
    const seen = new Set();
    return allItems.filter(item => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      // Drop trends with traffic below 10K — not worth AI scoring
      if ((item.metrics?.traffic || 0) < 10_000) return false;
      return true;
    });
  }

  async _fetchTrendingRSS(geo) {
    const url = `https://trends.google.com/trending/rss?geo=${geo}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    return this._parseRSS(text, geo);
  }

  _parseRSS(xml, geo) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];

      const title = this._extractTag(item, 'title') || '';
      const traffic = this._extractTag(item, 'ht:approx_traffic') || '0';
      const pubDate = this._extractTag(item, 'pubDate') || '';
      const picture = this._extractTag(item, 'ht:picture') || '';
      const pictureSource = this._extractTag(item, 'ht:picture_source') || '';

      let ageHours = 0;
      if (pubDate) {
        const publishedDate = new Date(pubDate);
        ageHours = (Date.now() - publishedDate.getTime()) / (1000 * 60 * 60);
      }

      // Extract news items
      const newsItems = [];
      const newsRegex = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
      let newsMatch;
      while ((newsMatch = newsRegex.exec(item)) !== null) {
        const newsItem = newsMatch[1];
        newsItems.push({
          title: this._extractTag(newsItem, 'ht:news_item_title') || '',
          url: this._extractTag(newsItem, 'ht:news_item_url') || '',
          source: this._extractTag(newsItem, 'ht:news_item_source') || '',
        });
      }

      const trafficNum = this._parseTraffic(traffic);
      const description = newsItems.map(n => `${n.title} (${n.source})`).join(' | ');

      items.push({
        externalId: `gtrends_${geo}_${Buffer.from(title).toString('base64').substring(0, 20)}`,
        source: 'google_trends',
        title: this._decodeHtml(title),
        description: this._decodeHtml(description).substring(0, 500),
        url: newsItems[0]?.url || `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}`,
        metrics: {
          traffic: trafficNum,
          formattedTraffic: traffic,
          geo,
          ageHours: Math.round((ageHours || 0) * 10) / 10,
          articleCount: newsItems.length,
          pictureSource,
          type: 'daily',
        },
      });
    }

    return items;
  }

  _extractTag(xml, tag) {
    // Handle namespaced tags like ht:approx_traffic
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escapedTag}[^>]*>([^<]*)</${escapedTag}>`);
    const match = regex.exec(xml);
    return match ? match[1].trim() : null;
  }

  _decodeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  _parseTraffic(str) {
    if (!str) return 0;
    const clean = str.replace(/[^0-9KMkm+.]/g, '').toUpperCase();
    if (clean.includes('M')) return parseFloat(clean) * 1_000_000;
    if (clean.includes('K')) return parseFloat(clean) * 1_000;
    return parseInt(clean, 10) || 0;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default GoogleTrendsCollector;
