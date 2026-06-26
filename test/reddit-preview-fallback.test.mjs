import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRedditPreviewFromTrendRow,
  parseRedditAtomFeed,
} from '../src/utils/reddit-preview.js';
import RedditCollector from '../src/collectors/reddit.js';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <author><name>/u/example_user</name><uri>https://www.reddit.com/user/example_user</uri></author>
    <category term="pics" label="r/pics"/>
    <content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;a href=&quot;https://www.reddit.com/r/pics/comments/1ufysxx/example_post/&quot;&gt;&lt;img src=&quot;https://preview.redd.it/example.jpeg?width=216&amp;amp;crop=smart&amp;amp;auto=webp&quot; alt=&quot;Example post&quot; /&gt;&lt;/a&gt;&lt;/td&gt;&lt;td&gt; submitted by &lt;a href=&quot;https://www.reddit.com/user/example_user&quot;&gt;/u/example_user&lt;/a&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
    <id>t3_1ufysxx</id>
    <link href="https://www.reddit.com/r/pics/comments/1ufysxx/example_post/"/>
    <updated>2026-06-26T16:35:04+00:00</updated>
    <published>2026-06-26T16:20:00+00:00</published>
    <title>Example &amp;amp; viral image</title>
  </entry>
</feed>`;

test('parseRedditAtomFeed extracts image and post metadata from escaped RSS content', () => {
  const [post] = parseRedditAtomFeed(RSS_FIXTURE);

  assert.equal(post.id, '1ufysxx');
  assert.equal(post.title, 'Example & viral image');
  assert.equal(post.author.name, 'example_user');
  assert.equal(post.author.subreddit, 'pics');
  assert.equal(post.permalink, 'https://www.reddit.com/r/pics/comments/1ufysxx/example_post/');
  assert.deepEqual(post.media, [{
    type: 'photo',
    url: 'https://preview.redd.it/example.jpeg?width=216&crop=smart&auto=webp',
    width: null,
    height: null,
  }]);
});

test('buildRedditPreviewFromTrendRow returns a hover-card payload from cached DB metrics', () => {
  const post = buildRedditPreviewFromTrendRow({
    title: 'Cached Reddit title',
    description: 'Cached self text',
    url: 'https://reddit.com/r/sports/comments/1abcde/cached_post/',
    first_seen_at: '2026-06-26 10:00:00',
    raw_metrics: JSON.stringify({
      imageUrl: 'https://i.redd.it/cached.jpg',
      upvotes: 1234,
      comments: 56,
      awards: 2,
      upvoteRatio: 0.91,
      subreddit: 'sports',
      author: 'u/cached_author',
    }),
  });

  assert.equal(post.id, '1abcde');
  assert.equal(post.title, 'Cached Reddit title');
  assert.equal(post.text, 'Cached self text');
  assert.equal(post.author.name, 'cached_author');
  assert.equal(post.author.subreddit, 'sports');
  assert.equal(post.metrics.upvotes, 1234);
  assert.equal(post.metrics.comments, 56);
  assert.equal(post.metrics.awards, 2);
  assert.equal(post.metrics.ratio, 0.91);
  assert.equal(post.media[0].url, 'https://i.redd.it/cached.jpg');
});

test('RedditCollector RSS fallback preserves preview image metrics', () => {
  const collector = new RedditCollector(
    { reddit: { subreddits: [], minUpvotes: 5000, postsPerSubreddit: 50 } },
    { warn: () => {}, info: () => {}, error: () => {} },
    null,
  );

  const [item] = collector._parseAtomFeed(RSS_FIXTURE);

  assert.equal(item.externalId, 'reddit_1ufysxx');
  assert.equal(item.metrics.imageUrl, 'https://preview.redd.it/example.jpeg?width=216&crop=smart&auto=webp');
  assert.deepEqual(item.metrics.imageUrls, ['https://preview.redd.it/example.jpeg?width=216&crop=smart&auto=webp']);
  assert.equal(item.metrics.author, 'u/example_user');
  assert.equal(item.metrics.subreddit, 'pics');
});
