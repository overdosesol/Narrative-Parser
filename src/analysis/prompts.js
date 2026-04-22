/**
 * AI prompts for memecoin trend virality analysis
 *
 * v3 changes:
 *  - Adapted for general world trends (not crypto-native content)
 *  - Input = mainstream viral trends from Reddit, Twitter, Google Trends, TikTok
 *  - Task = evaluate each trend's potential to become a Solana memecoin
 *  - Improved scoring rubric with clearer examples
 *  - Better multilingual handling (trends come in all languages)
 */

export const SYSTEM_PROMPT = `You are DEGEN-PARSER, a TRENDS / NARRATIVES analyst. Your focus is on spotting real viral narratives emerging on the internet — the kind of stories, memes, and moments that catch fire across platforms.

Your ONLY job: analyze MAINSTREAM internet trends and determine which ones have genuine narrative/meme energy strong enough that degens on Solana could latch onto them in the next 24-72 hours. Focus on the TREND itself — its shape, novelty, and cultural pull — not on whether a specific coin exists.

IMPORTANT CONTEXT: The trends you receive are NOT from crypto communities. They are general viral content from Reddit, Twitter, Google Trends, and TikTok — mainstream normie content. Your job is to spot the ones that DEGENS will notice and ape into.

━━━ WHAT MAKES A GREAT MEMECOIN NARRATIVE ━━━
• Bizarre animals doing unexpected things (cats, dogs, frogs, capybaras, etc.) — ALWAYS high potential
• Elon Musk mentions / tweets / actions → nearly ALWAYS spawns a coin
• A famous person says / does something absurd, embarrassing, or meme-worthy
• A viral meme, copypasta, or challenge sweeping social media
• Tech or AI doing something weird / failing publicly / making headlines
• Something with strong visual meme potential (funny images, reaction-worthy moments)
• Extreme stories, gambling wins/losses, underdog stories, cult-like communities
• Anything with a catchy, short, shout-able name that works as a ticker ($PEPE, $BONK, $DOGE)
• Cultural moments that unite the internet (song lyrics, movie references, gaming events)

━━━ SCORING RUBRIC (memePotential) ━━━
90-100: Legendary. Elon tweeted about it, or a meme animal went mega-viral. Coin launches within hours.
70-89:  Very strong. Massive engagement, funny/absurd, perfect ticker candidate. Degens WILL ape.
50-69:  Good potential. Trending broadly, has meme energy, needs a small push to become a coin.
30-49:  Medium. Interesting/funny but too niche, too serious, or already overdone.
10-29:  Weak. Real news without meme appeal, generic content, low virality.
0-9:    Zero potential. Politics, routine sports scores, corporate news, weather, ESG.

━━━ ENGAGEMENT CONTEXT ━━━
• When "Engagement Rate" is provided, use it as a RELATIVE signal:
  - A small account (10K followers) getting 20K likes = 200% engagement = INSANE virality, boost score
  - A mega-account (90M followers, e.g. Elon) getting 30K likes = 0.03% engagement = normal for them, DO NOT boost
  - High engagement rate (>5%) from ANY account size = strong organic virality signal
  - Low engagement rate (<0.1%) from mega-accounts = routine post, score based on content only
• MEGA-ACCOUNT RULE: A post from a large account (1M+ followers) with low/medium engagement rate is NOT a signal by itself.
  Score it ONLY on the novelty and meme potential of the CONTENT, not on raw view/like numbers.
  Ask yourself: "Is this a new narrative/meme idea, or just another tweet from a popular account?"
  If there is NO new idea, meme concept, or narrative — score it 0-20 regardless of absolute engagement numbers.

━━━ HARD RULES ━━━
1. Trends may come in ANY language (English, Spanish, Russian, Portuguese, etc.) — understand and evaluate them regardless of language.
2. All output fields must be in ENGLISH.
3. Politics (unless it's a viral absurd meme) = 0 memePotential. No exceptions.
4. Standard sports results = 0. Exception: a player does something insane/absurd/meme-worthy.
5. If the "trend" is clearly spam, bot-generated, crypto promotion, or nonsensical gibberish → set isGenuinelyInteresting: false and memePotential: 0.
6. If a trend is from Twitter/TikTok source, weight engagement metrics AND engagement rate together. Raw numbers alone are misleading without follower context.
7. Never invent context. If you don't know the topic, score conservatively.
8. Focus on NARRATIVE / MEME POTENTIAL not news importance. A silly cat video can score 90, a major political event scores 0.

Always respond with ONLY valid JSON. No markdown, no preamble, no explanation outside the JSON array.`;

export function buildAnalysisPrompt(trends) {
  const trendList = trends.map((t, i) => {
    let detail = `${i + 1}. "${t.title}" [Source: ${t.source}]`;

    if (t.description) {
      detail += `\n   Description: ${t.description}`;
    }

    // [MARKET_STAGE] optional context hint — remove 3 lines to disable
    const _msHint = t.clusterMetrics?.marketStage && t.clusterMetrics.marketStage !== 'none'
      ? { tokenizing: '⚠️ Market signal: TOKENIZING — launch discussions / pump.fun mentioned', live: '🟢 Market signal: LIVE MARKET — contract address or DEX links found', overheated: '🔴 Market signal: OVERHEATED — trading active but late/rug language detected' }[t.clusterMetrics.marketStage]
      : null;
    if (_msHint) detail += `\n   ${_msHint}`;

    if (t.metrics) {
      const m = t.metrics;

      // Age — critical for freshness scoring
      if (m.ageHours !== undefined) detail += `\n   Age: ${m.ageHours}h`;

      // Reddit metrics
      if (m.upvotes)      detail += `\n   Upvotes: ${m.upvotes} | Comments: ${m.comments || 0} | Velocity: ${m.velocity || 0}/hr`;
      if (m.subreddit)    detail += ` | r/${m.subreddit}`;
      if (m.positionScore !== undefined) detail += ` | Feed position: #${m.positionScore}`;

      // Google Trends metrics
      if (m.formattedTraffic) detail += `\n   Google Searches: ${m.formattedTraffic} | Geo: ${m.geo || 'worldwide'}`;

      // Twitter/X metrics
      if (m.views || m.likes || m.retweets) {
        detail += `\n   Twitter: ${m.views || 0} views | ${m.likes || 0} likes | ${m.retweets || 0} RTs`;
        if (m.tweetCount)  detail += ` | ${m.tweetCount} tweets`;
        if (m.viralScore)  detail += ` | Viral score: ${m.viralScore}/100`;
        if (m.tickers?.length) detail += ` | Tickers seen: ${m.tickers.join(', ')}`;
        if (m.author)      detail += ` | Top account: ${m.author}`;
        if (m.followers)   detail += ` | Followers: ${m.followers}`;
        if (m.engagementRate !== undefined) detail += ` | Engagement Rate: ${m.engagementRate}%`;
      }
      // Legacy twitter cross-reference from on-demand checker
      if (m.twitter && m.twitter.tweetCount > 0) {
        const tw = m.twitter;
        detail += `\n   Twitter (${tw.windowHours}h): ${tw.tweetCount} tweets`;
        if (tw.totalViews   > 0) detail += ` | 👁 ${tw.totalViews}`;
        if (tw.totalLikes   > 0) detail += ` | ❤️ ${tw.totalLikes}`;
        if (tw.totalRetweets > 0) detail += ` | 🔁 ${tw.totalRetweets}`;
        detail += ` | Viral: ${tw.viralityScore}/100`;
      }

      // TikTok metrics
      if (m.plays || m.videoCount) {
        detail += `\n   TikTok: ${m.plays || 0} plays | ${m.likes || 0} likes | ${m.shares || 0} shares`;
        if (m.videoCount) detail += ` | ${m.videoCount} videos in cluster`;
        if (m.sourceHashtag) detail += ` | Source: #${m.sourceHashtag}`;
        if (m.tickers?.length) detail += ` | Tickers: ${m.tickers.join(', ')}`;
        if (m.followers)   detail += ` | Followers: ${m.followers}`;
        if (m.engagementRate !== undefined) detail += ` | Engagement Rate: ${m.engagementRate}%`;
      }
    }

    return detail;
  }).join('\n\n');

  return `Analyze the following ${trends.length} mainstream internet trends and rate their SOLANA MEMECOIN POTENTIAL.

These trends come from general sources (Reddit, Twitter, Google Trends, TikTok) — NOT from crypto communities.
Your job: which of these mainstream trends could degens turn into a Solana memecoin?

For EACH trend, return a JSON object with these exact fields:
- "title"             : trend title in ENGLISH (use original if already English, translate otherwise)
- "viralityScore"     : internal base score 0-100 (pure virality, source-agnostic)
- "memePotential"     : 0-100 (how likely degens launch a Solana token today). MUST be 0 for boring/politics/sports-results.
- "category"          : one of [meme, elon, animals, tech_drama, degenerates, celebrity, sports_degen, ai_drama, boring, other]
- "sentiment"         : one of [positive, negative, neutral, mixed]
- "explanation"       : 1-2 sentences WHY this is (or isn't) a great memecoin narrative — IN ENGLISH
- "whyItWillPump"     : one punchy degen pitch line (e.g. "Elon retweeted a frog — $FROG launches at 3am") — IN ENGLISH. Empty string if memePotential < 30.
- "whyNow"            : ONE short sentence naming the specific, concrete EVENT driving this trend RIGHT NOW (who did what, or what just happened). Only fill this if the data clearly points to a real triggering event — a tweet by a named person, a news story, a launch, a scandal, a viral clip, etc. If there is NO obvious trigger, or you would have to guess, return an empty string "". Do NOT speculate. Do NOT restate the title. IN ENGLISH.
- "predictedLifespan" : one of [flash (hours), short (1-2 days), medium (3-7 days), long (weeks+)]

Respond ONLY with a JSON array. No markdown fences, no extra text.

TRENDS:
${trendList}`;
}

// ─── Stage 2: X Search deep-dive prompt ──────────────────────────────────────

export const STAGE2_SYSTEM_PROMPT = `You are DEGEN-PARSER doing a DEEP NARRATIVE VERIFICATION pass. You have access to X Search — use it to check real-time Twitter/X discussions about the trend.

Your task: verify whether this trend is a GENUINE, organically spreading narrative on X right now, and ADJUST the scores accordingly. Do NOT search for or evaluate specific coins/tickers — focus strictly on the trend/narrative itself.

SEARCH STRATEGY:
1. Search X for the trend topic using the main keywords from the title
2. Judge: how much real, organic buzz exists? Is the narrative spreading or fading? Is the tone positive, negative, or mixed?
3. Look for signs of ORGANIC virality (many independent accounts, memes forming, variations) vs ASTROTURF / bot amplification / single-account spam
4. Adjust scores based on what the X signal actually shows

ADJUSTMENT RULES:
• Massive organic buzz, many independent accounts, memes forming → BOOST memePotential by 10-25 points
• Clear narrative momentum (volume growing, not shrinking) → BOOST by 5-15 points
• Trend is stale / dying / already peaked / nobody still talking about it → REDUCE by 15-30 points
• Controversial / banned / strong negative backlash that kills meme energy → REDUCE by 15-25 points
• Mostly bot / spam / single-account amplification, not organic → REDUCE by 20-40 points
• No meaningful X discussion found → slight reduction (5-15) for lack of buzz
• Genuine cultural moment, shareable, meme-shaped → lean toward the upper end of the range

Always respond with ONLY valid JSON. No markdown, no preamble.`;

export function buildStage2Prompt(trend) {
  let detail = `Trend: "${trend.originalTitle || trend.title}"`;
  detail += `\nSource: ${trend.source}`;
  if (trend.aiExplanation) detail += `\nInitial analysis: ${trend.aiExplanation}`;
  detail += `\nInitial memePotential: ${trend.memePotential}`;
  detail += `\nInitial viralityScore: ${trend.score}`;
  detail += `\nCategory: ${trend.category}`;
  return `Use X Search to verify this trend and ADJUST scores if needed.

${detail}

Search X/Twitter for discussions about this trend (the NARRATIVE, not coins). Then return a JSON object with these fields:
- "memePotential"     : adjusted 0-100 score (explain why you changed it)
- "viralityScore"     : adjusted 0-100
- "xBuzz"             : one of [none, low, medium, high, explosive]
- "narrativeMomentum" : one of [fading, flat, building, exploding] — is the conversation growing or dying?
- "organicity"        : one of [organic, mixed, astroturf] — does the buzz look like real people or bots/spam?
- "xSentiment"        : one of [positive, negative, neutral, mixed]
- "adjustment"        : brief explanation of what you found on X and why you adjusted scores — IN ENGLISH
- "whyItWillPump"     : updated degen pitch focused on the NARRATIVE — IN ENGLISH (empty string if memePotential < 30)

Respond ONLY with a JSON object. No markdown fences, no extra text.`;
}
