/**
 * preset-config.js — single source of truth for ALL per-preset pipeline knobs.
 *
 * Each search preset (general / animals / culture / celebrities / events) gets a
 * full self-contained config covering every layer of the pipeline that should
 * differ by topic:
 *
 *   sources  — collector inputs (subreddits, X queries, TikTok hashtags, ...)
 *   junk     — junk-filter penalties (formerly filter-profiles.js)
 *   alerts   — alert thresholds + alertScore weights + stale decay
 *   cluster  — clustering similarity weights + thresholds
 *
 * Storage: a single `presetConfigs` setting holds a sparse JSON blob of
 * overrides, shape:
 *
 *   { "<preset>": { "<group>": { "<sub-namespace>"?: { "<field>": <value> } } } }
 *
 * Only fields that DIFFER from the default are stored, so the blob stays tiny.
 * Resolution: `resolvePresetConfig(preset, overrides)` deep-merges defaults +
 * the override patch and returns a fully populated config.
 *
 * IMPORTANT: when adding a new field, also add a range descriptor to
 * PRESET_FIELD_RANGES so the admin UI knows how to render + validate it.
 *
 * NOTE on `sources`: groups are namespaced PER PLATFORM
 *   (sources.reddit / sources.twitter / sources.tiktok / sources.googletrends)
 * so future per-source knobs (e.g. `twitter.minViews`, `tiktok.minPlays`)
 * can be added without disturbing the storage shape.
 */

// Ordered. Keep in sync with collectors/twitter.js, reddit.js, tiktok.js,
// admin/server.js scanner-config preset switcher.
export const PRESET_KEYS = Object.freeze([
  'general', 'animals', 'culture', 'celebrities', 'events',
]);

// Top-level groups. Order is also the order admin UI renders accordions in.
export const PRESET_GROUPS = Object.freeze(['sources', 'junk', 'alerts', 'cluster']);

// ── Field range / type metadata ────────────────────────────────────────────────
//
// Used by:
//   - admin UI to render the right control (slider / chip-input / number)
//   - validateProfileOverrides() to range-check POST'd values server-side
//
// Type vocabulary:
//   'int'   — whole number, range [min, max], step
//   'float' — fractional, range [min, max], step (used for weights 0..1)
//   'list'  — array of strings; `max` = max items, `itemMaxLen` per-item len
//
// `label` and `desc` are RU strings rendered in admin (operator-only UI).

export const PRESET_FIELD_RANGES = Object.freeze({
  // ── Sources — per-platform namespaces ──────────────────────────────────────
  sources: {
    reddit: {
      subreddits:        { type: 'list',  max: 30, itemMaxLen: 64,
                           label: 'Subreddits',
                           desc: 'Список subreddit’ов без префикса r/. Сканер делает 1 запрос на каждый.' },
      minUpvotes:        { type: 'int',   min: 100, max: 100000, step: 500,
                           label: 'Min upvotes',
                           desc: 'Порог апвотов чтобы пост попал в pipeline.' },
      postsPerSubreddit: { type: 'int',   min: 10,  max: 200,    step: 10,
                           label: 'Posts/subreddit',
                           desc: 'Сколько hot-постов брать с каждого subreddit’а.' },
    },
    twitter: {
      queries:           { type: 'list',  max: 20, itemMaxLen: 256,
                           label: 'X queries',
                           desc: 'Поисковые запросы. По циклу запускается 2 (rotated).' },
    },
    tiktok: {
      // Note: per-preset TikTok control was removed 2026-05-05. TikTok runs
      // globally (env TIKTOK_ENABLED) using live-discovery from TikTok
      // Creative Center as primary hashtag source. The hardcoded list below
      // is only fallback for when the trends actor fails. To kill TikTok
      // entirely → admin "Сканеры → 📡 Площадки" toggle (global, per-source).
      hashtags:          { type: 'list',  max: 30, itemMaxLen: 64,
                           label: 'TikTok hashtags (fallback)',
                           desc: 'Hardcoded fallback-список хэштегов. Используется ТОЛЬКО если live-discovery (clockworks/tiktok-trends-scraper) упал или не успел сделать первый fetch. Primary source — live-trending из TikTok Creative Center, refresh раз в 12h.' },
    },
    xtrends: {
      enabled:           { type: 'int', min: 0, max: 1, step: 1,
                           label: 'Enabled',
                           desc: '1 = ловим X trends в этом пресете, 0 = выкл. Источник Apify, refresh 30 мин.' },
      topN:              { type: 'int', min: 5, max: 50, step: 5,
                           label: 'Top N trends',
                           desc: 'Сколько верхних трендов брать с каждого fetch (всего US-trends ~50). Все идут через AI скоринг.' },
    },
    googletrends: {
      // reserved namespace; per-source fields will be added later
    },
  },

  // ── Junk filter — was filter-profiles.PROFILE_FIELD_RANGES ──────────────────
  junk: {
    politicsPenalty:     { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'Политика',     desc: 'Штраф если кластер о политике/войне.' },
    kpopPenalty:         { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'K-pop / фандом', desc: 'Штраф за стан-культуру.' },
    celebNoisePenalty:   { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'Celeb-noise',  desc: 'Рутинный celeb-шум (интервью, red carpet).' },
    noMemeShapePenalty:  { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'Нет meme-shape', desc: 'Штраф если нет животных/абсурда/мемов.' },
    noContentPenalty:    { type: 'int',   min: 0, max: 50,  step: 1,
                           label: 'Нет контента (text-only)',
                           desc: 'Штраф за пост без картинок/видео. Чисто текстовые посты получают -X к качеству. Не применяется к google_trends (там медиа нет by design).' },
    safeOverrideDivisor: { type: 'int',   min: 1, max: 10,  step: 1,
                           label: 'Safe-override ÷', desc: 'Делитель при наличии meme-сигнала (меньше = сильнее override).' },
    memeShapeBoost:      { type: 'int',   min: 0, max: 30,  step: 1,
                           label: 'Meme-shape буст',
                           desc: 'Прибавка к emergenceScore при mem-сигнале. 2+ сигнала → ×1.5. 0 = отключено.' },
  },

  // ── Alerts — thresholds, weights, stale decay ──────────────────────────────
  alerts: {
    thresholds: {
      alertThreshold:    { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'Floor (alertScore)',
                           desc: 'Минимальный alertScore чтобы дойти до Telegram-алерта.' },
      minScoreToSave:    { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'Min score to save',
                           desc: 'Тренды ниже не сохраняются в БД.' },
      maxAlertsPerCycle: { type: 'int',   min: 0, max: 50,  step: 1,
                           label: 'Max alerts / cycle',
                           desc: '0 = безлимит. Кап на цикл сканера.' },
      alertHardJunkStop: { type: 'int',   min: 0, max: 100, step: 5,
                           label: 'Hard junk stop',
                           desc: 'junkPenalty ≥ этого → никогда не алертить.' },
    },
    // POSITIVE weight constraint: sum ≤ 1.0 — enforced in validatePresetOverrides
    weights: {
      weightMemePotential: { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                             label: 'meme', desc: 'AI memePotential.' },
      weightVirality:      { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                             label: 'virality', desc: 'AI/heuristic виральность.' },
      weightEmergence:     { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                             label: 'emergence', desc: 'cluster velocity + spread + ideaBoost.' },
      weightTwitter:       { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                             label: 'twitter', desc: 'on-platform X сигнал.' },
      weightFeedback:      { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                             label: 'feedback', desc: 'global 👍/👎 bias.' },
      weightJunk:          { type: 'float', min: 0, max: 1, step: 0.05,
                             label: 'junk (×)', desc: 'Множитель junk-штрафа (вычитается).' },
    },
    stale: {
      staleDecayPerHour:    { type: 'float', min: 0, max: 10, step: 0.25,
                              label: 'Stale / hour',
                              desc: 'Очков снимается с alertScore за каждый час старения (после grace).' },
      staleDecayGraceHours: { type: 'int',   min: 0, max: 168, step: 1,
                              label: 'Grace period (hours)',
                              desc: 'Часы без штрафа за старение.' },
      staleDecayCap:        { type: 'int',   min: 0, max: 100, step: 5,
                              label: 'Stale cap',
                              desc: 'Максимальный суммарный штраф за старение.' },
    },
  },

  // ── Cluster — similarity weights & threshold ────────────────────────────────
  // POSITIVE weight constraint: sum ≤ 1.0 — enforced in validatePresetOverrides
  cluster: {
    simThreshold:        { type: 'float', min: 0.3, max: 0.9,  step: 0.01,
                           label: 'Sim threshold',
                           desc: 'Минимальная similarity чтобы считать два item’а одним кластером.' },
    timePenaltyHours:    { type: 'int',   min: 0,   max: 168,  step: 1,
                           label: 'Time penalty (h)',
                           desc: 'Дамп similarity 1.0→0.7 если items >N часов apart.' },
    weightEmbedding:     { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                           label: 'embedding', desc: 'Cosine similarity embeddings.' },
    weightPhash:         { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                           label: 'phash', desc: 'Image dHash.' },
    weightEntity:        { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                           label: 'entity', desc: 'entityCanonical[] overlap.' },
    weightTicker:        { type: 'float', min: 0, max: 1, step: 0.05, positive: true,
                           label: 'ticker', desc: 'Shared $TICKER.' },
  },
});

// ── Default configs per preset ─────────────────────────────────────────────────
//
// These are the bootstrapped values. On first start, the migration in
// database.js folds any legacy globals (filterProfiles, alertThreshold,
// alertWeight*, alertStaleDecay*) into the override blob — but the defaults
// here MUST already produce identical scoring behaviour vs. pre-PR baseline
// for `general` (the legacy active preset).

// Per-preset defaults. Updated 2026-05-01 (post-Grok audit):
//   - Sources audited for 2025-2026 relevance: dead/overlapping items removed,
//     fresh slang / current K-pop groups / trending hashtags added
//   - alerts.thresholds + .weights + .stale and cluster.* now ALL diverge by
//     preset (used to be uniform via shared DEFAULT_ALERTS / DEFAULT_CLUSTER)
//
// Tuning rationale per preset:
//   general:     broad net, mixed lifespan, medium density. Balanced weights.
//   animals:     slow lifespan (cute capybara stays cute), low density, meme-
//                dominant. phash heavy (visual matching), gentle stale-decay.
//   culture:     short lifespan (memes die fast), very high density, meme-
//                dominant. phash + embedding heavy, aggressive stale-decay.
//   celebrities: short lifespan, very high density, virality-dominant. Strict
//                junk-multiplier (0.55) — celeb-noise floods otherwise.
//   events:      hours-long lifespan (news rots), medium density, emergence-
//                dominant. embedding+entity heavy (one event = many framings),
//                very aggressive stale-decay (cap 60), short cluster window 6h.
//
// Σ POSITIVE weight invariant (alerts.weights and cluster.* both):
//   general/animals/culture/celebrities/events all = 1.00 exactly.

export const DEFAULT_PRESET_CONFIGS = Object.freeze({
  general: {
    sources: {
      // ── Sources are a CURATED MIX from animals/culture/celebrities/events
      // — 2-3 picks per theme — instead of the previous broad-firehose model
      // (r/all + r/popular + word-soup queries + generic fyp hashtags). The
      // firehose approach drowned the feed in low-quality junk; themed
      // presets work well because their inputs are pre-filtered by topic.
      // General now inherits that curation from all 4, evenly distributed.
      reddit: {
        // 11 subs total: 2 animals + 3 culture + 2 celebrities + 2 events +
        // 2 broad universal (Damnthatsinteresting / nextfuckinglevel —
        // surprise/awe content that fits no theme but reliably goes viral).
        subreddits: [
          // animals (broadest from animals preset)
          'aww', 'NatureIsFuckingLit',
          // culture (largest, most universal meme hubs)
          'memes', 'dankmemes', 'Unexpected',
          // celebrities (broadest pop-culture hubs)
          'popculturechat', 'movies',
          // events (breaking news + weird-real)
          'worldnews', 'nottheonion',
          // universal awe/surprise — kept from old General
          'Damnthatsinteresting', 'nextfuckinglevel',
        ],
        // Mid-bar — themed subs are smaller-volume than r/all's 10K hurdle,
        // but bigger than animals' 3K floor. 5K balances quality vs miss-rate.
        minUpvotes:        5000,
        postsPerSubreddit: 50,
      },
      twitter: {
        // 6 queries — 1-2 per theme. Themed keywords replaced the previous
        // word-soup ("a OR the OR is OR to") that pulled ANY viral tweet
        // regardless of topic. Each query lifted from its respective preset.
        queries: [
          // animals — combined dog/cat/pet net (single query saves 1 slot)
          '(dog OR puppy OR cat OR kitten OR pet OR animal) min_faves:10000 -is:retweet',
          // culture — generic meme + 2025-2026 slang (both proven in culture preset)
          '(meme OR memes OR viral OR trend) min_faves:10000 -is:retweet',
          '(skibidi OR delulu OR rizz OR aura OR brainrot OR mewing) min_faves:10000 -is:retweet',
          // celebrities — entertainment + music (combined for breadth)
          '(movie OR film OR series OR netflix OR album OR music OR celebrity) min_faves:10000 -is:retweet',
          // events — breaking + AI/tech (highest signal categories)
          '(breaking OR "breaking news" OR happening OR urgent OR alert) min_faves:10000 -is:retweet',
          '(AI OR ChatGPT OR robot OR artificial intelligence) min_faves:10000 -is:retweet',
        ],
      },
      tiktok: {
        // Hardcoded fallback list — used only if live-discovery from TikTok
        // Creative Center fails. Primary source is the live trending pool
        // refreshed every 12h. Mix of all 4 themes (3/3/3/3) so a fallback
        // run still produces somewhat varied content.
        hashtags: [
          // animals
          'animalsoftiktok', 'petsoftiktok', 'funnydogs',
          // culture
          'storytime', 'relatablememes', 'brainrotmemes',
          // celebrities
          'kpopfyp', 'fandomdrama', 'celebdrama',
          // events
          'weathertok', 'stormchasing', 'aitechnology',
        ],
      },
      // X Trends — broad cast, take top 20 (covers most of US live trends).
      // Note: per-preset topN is currently informational only; X Trends rework
      // 2026-05-05 hardcoded top-3 via env. Kept here for forward-compat.
      xtrends:      { enabled: 1, topN: 20 },
      googletrends: {},
    },
    junk: {
      politicsPenalty: 40, kpopPenalty: 30, celebNoisePenalty: 20,
      noMemeShapePenalty: 20, noContentPenalty: 5, safeOverrideDivisor: 3, memeShapeBoost: 10,
    },
    alerts: {
      thresholds: { alertThreshold: 60, minScoreToSave: 0, maxAlertsPerCycle: 5, alertHardJunkStop: 70 },
      // feedback 0.10→0.15 (в curated mix юзер-голоса важнее raw виральности),
      // компенсация: viral 0.20→0.15. Σ = 1.00.
      weights:    { weightMemePotential: 0.45, weightVirality: 0.15, weightEmergence: 0.20, weightTwitter: 0.05, weightFeedback: 0.15, weightJunk: 0.50 },
      // 3-day life: 24h grace + 48h decay at 1pt/hr → tail-end 72h.
      stale:      { staleDecayPerHour: 1, staleDecayGraceHours: 24, staleDecayCap: 48 },
    },
    cluster: { simThreshold: 0.55, timePenaltyHours: 24, weightEmbedding: 0.40, weightPhash: 0.30, weightEntity: 0.20, weightTicker: 0.10 },
  },

  animals: {
    sources: {
      reddit: {
        // Kept all 8 originals (low overlap, all unique signal). Added 2:
        // FunnyAnimals (dedicated, rising) + AnimalMemes (bridge to culture).
        subreddits: [
          'aww', 'AnimalsBeingDerps', 'AnimalsBeingBros', 'AnimalsBeingJerks',
          'NatureIsFuckingLit', 'Eyebleach', 'rarepuppers', 'capybara',
          'FunnyAnimals', 'AnimalMemes',
        ],
        minUpvotes:        5000,
        postsPerSubreddit: 50,
      },
      twitter: {
        // Removed: (animal OR pet OR cute) too broad / overlap with others;
        //          (duck OR frog OR monkey OR bear OR hamster) too narrow.
        // Added: capybara/otter/redpanda for trending exotic-cute (capybara
        //        is undefeated 2025-2026), and a niche fail/derp/wholesome query.
        queries: [
          '(dog OR puppy OR doggo OR pupper) min_faves:10000 -is:retweet',
          '(cat OR kitten OR kitty OR meow) min_faves:10000 -is:retweet',
          '(rescue OR adopt OR stray OR shelter) (dog OR cat OR animal) min_faves:5000 -is:retweet',
          '(funny OR hilarious OR silly) (dog OR cat OR animal OR pet) min_faves:5000 -is:retweet',
          '(capybara OR otter OR redpanda) min_faves:5000 -is:retweet',
          '(pet OR animal) (fail OR derp OR wholesome) min_faves:5000 -is:retweet',
        ],
      },
      tiktok: {
        // Hardcoded fallback list (animal-themed) for when live-discovery
        // fails. In practice live trending hashtags from TikTok Creative
        // Center will surface animal-related ones organically when relevant.
        hashtags: [
          'animalsoftiktok', 'petsoftiktok', 'funnydogs', 'funnycats',
          'exoticpets', 'babyanimals', 'blackcatsoftiktok', 'catsoftiktok',
          'doglovers', 'animalvideos', 'farmanimals', 'animalkingdom',
          'puppylove', 'bunny', 'fosteringsaveslives',
        ],
      },
      // X Trends — animals rarely make top trends, take 10 (less noise)
      xtrends:      { enabled: 1, topN: 10 },
      googletrends: {},
    },
    junk: {
      politicsPenalty: 60, kpopPenalty: 40, celebNoisePenalty: 30,
      noMemeShapePenalty: 15, noContentPenalty: 8, safeOverrideDivisor: 3, memeShapeBoost: 14,
    },
    alerts: {
      thresholds: { alertThreshold: 55, minScoreToSave: 0, maxAlertsPerCycle: 5, alertHardJunkStop: 70 },
      weights:    { weightMemePotential: 0.45, weightVirality: 0.20, weightEmergence: 0.15, weightTwitter: 0.05, weightFeedback: 0.15, weightJunk: 0.40 },
      stale:      { staleDecayPerHour: 2, staleDecayGraceHours: 24, staleDecayCap: 30 },
    },
    cluster: { simThreshold: 0.55, timePenaltyHours: 48, weightEmbedding: 0.30, weightPhash: 0.50, weightEntity: 0.10, weightTicker: 0.10 },
  },

  culture: {
    sources: {
      reddit: {
        // Kept all 8 (TikTokCringe explicitly retained vs Grok's recommend —
        // it's a unique TikTok-to-Reddit propagation signal, 2M+ subscribers).
        // Added: ContagiousLaughter (2025-2026 growth), HolUp (absurdist),
        //        196 (chaotic gen-z), mildlyinfuriating (peak meme content
        //        — covered by adding via culture's curiosity radius).
        subreddits: [
          'memes', 'dankmemes', 'Unexpected', 'facepalm', 'TikTokCringe',
          'OutOfTheLoop', 'KnowYourMeme', 'therewasanattempt',
          'ContagiousLaughter', 'HolUp', '196',
        ],
        minUpvotes:        8000,   // Meme subs are big — bar slightly raised
        postsPerSubreddit: 50,
      },
      twitter: {
        // Removed: (cancel OR ratio OR timeline OR main character) — dated
        //          2023-2024 slang, low fresh signal.
        //          (gen z OR millennial OR boomer OR tiktok OR trend) — too
        //          meta/broad, overlaps with other queries.
        // Added: (skibidi OR delulu OR rizz OR aura OR brainrot OR mewing) —
        //        actively dominant gen-z slang in 2025-2026.
        //        (tiktok OR reels OR fyp) viral/trending — cross-platform reaction signal.
        queries: [
          '(meme OR memes OR viral OR trend) min_faves:10000 -is:retweet',
          '(funny OR hilarious OR lmao OR lol OR bruh) min_faves:10000 -is:retweet',
          '(slay OR iconic OR based OR goated OR era) min_faves:10000 -is:retweet',
          '(insane OR crazy OR wild OR unhinged OR unreal) min_faves:10000 -is:retweet',
          '(skibidi OR delulu OR rizz OR aura OR brainrot OR mewing) min_faves:10000 -is:retweet',
          '(tiktok OR reels OR fyp) (viral OR trending) min_faves:10000 -is:retweet',
        ],
      },
      tiktok: {
        // Hardcoded fallback list of named memes — used only if live-discovery
        // from TikTok Creative Center fails. The live trending pool (refreshed
        // every 12h) is the primary hashtag source and surfaces current memes
        // organically; this list is a safety net for when the trends actor
        // is down or hasn't done its first fetch after restart.
        //
        // Snapshot 2026-05-05 — Grok web-search of named meme formats actively
        // spreading at the time. Each entry is a specific viral meme (sound /
        // catchphrase / character / format), not a category tag.
        hashtags: [
          'ohokbecause',                  // wordplay-trend "sub had a way" / "doctor had a pepper", boxing-step dance to track 212
          'rahskeleton',                  // skeleton character yelling "RAHHH", chaotic situations
          'rememberwhoyouare',            // catchphrase meme "remember who you are [demographic]"
          'dontleavemedry',               // catchphrase slang replacing "don't leave me hanging"
          'homerdroppedhisdonut',         // sound-driven AI meme with Homer Simpson "D'oh!" remix
          'blueshirtkid',                 // character meme — boy in blue shirt dancing sturdy
          'areyoucomingtothetree',        // catchphrase from Hunger Games in phonk/conveyor edits
          'ijusthitthejackpot',           // sound-driven meme on rap track for everyday wins
          'theworstthingshecansayisno',   // catchphrase meme in humor/meme contexts
          'bigarch',                      // food-meme on Arby's Big Arch — parodies, CEO reactions
          'goofinator',                   // 2026 slang catchphrase for goofy behavior
          'aimyguy',                      // catchphrase "AI, my guy" universal comment
          'followthattune',               // sound-driven trend on Gymskin "follow that tune"
          'everythinghallelujah',         // sound-driven trend on Justin Bieber "Hallelujah"
        ],
      },
      // X Trends — memes spike fast in trends, take 25
      xtrends:      { enabled: 1, topN: 25 },
      googletrends: {},
    },
    junk: {
      politicsPenalty: 30, kpopPenalty: 10, celebNoisePenalty: 20,
      noMemeShapePenalty: 25, noContentPenalty: 6, safeOverrideDivisor: 3, memeShapeBoost: 12,
    },
    alerts: {
      thresholds: { alertThreshold: 60, minScoreToSave: 10, maxAlertsPerCycle: 5, alertHardJunkStop: 75 },
      weights:    { weightMemePotential: 0.45, weightVirality: 0.25, weightEmergence: 0.10, weightTwitter: 0.15, weightFeedback: 0.05, weightJunk: 0.50 },
      // 4-day life: 48h grace (мем разгорается без штрафа) + 48h decay at 1pt/hr.
      stale:      { staleDecayPerHour: 1, staleDecayGraceHours: 48, staleDecayCap: 48 },
    },
    cluster: { simThreshold: 0.50, timePenaltyHours: 12, weightEmbedding: 0.40, weightPhash: 0.40, weightEntity: 0.10, weightTicker: 0.10 },
  },

  celebrities: {
    sources: {
      reddit: {
        // Removed: hiphopheads (too niche/music-focused, overlap with popheads).
        // Added: Deuxmoi (gossip account fan-sub, leak signal),
        //        kpop (dedicated K-pop fandom drama, dominant in 2026).
        subreddits: [
          'popculturechat', 'Fauxmoi', 'entertainment', 'movies', 'television',
          'popheads', 'kpop', 'Deuxmoi',
        ],
        minUpvotes:        5000,
        postsPerSubreddit: 50,
      },
      twitter: {
        // Removed: (elon OR musk OR trump OR biden) — politics bleed (junk
        //          penalty in non-events presets); Trump/election now belong
        //          in events anyway.
        //          (taylor OR beyonce OR drake OR kanye OR rihanna) — names
        //          partially cooling; sabrina/olivia/doja covered via the
        //          generic music/celebrity queries.
        // Added: dominant K-pop groups query + targeted K-pop drama query.
        queries: [
          '(movie OR film OR series OR netflix OR disney) min_faves:10000 -is:retweet',
          '(album OR song OR music OR concert OR tour) min_faves:10000 -is:retweet',
          '(celebrity OR famous OR star OR interview OR paparazzi) min_faves:10000 -is:retweet',
          '(award OR grammy OR oscar OR golden globe) min_faves:10000 -is:retweet',
          '(bts OR blackpink OR straykids OR seventeen OR twice) min_faves:10000 -is:retweet',
          '(kpop OR k-pop OR idol) (drama OR comeback OR scandal) min_faves:5000 -is:retweet',
        ],
      },
      tiktok: {
        // Hardcoded fallback list (celebrity-themed) for when live-discovery
        // fails. Live trending hashtags from TikTok Creative Center will
        // surface celeb-drama tags organically when they spike.
        hashtags: [
          'kpopfyp', 'kpopdance', 'kpopedit', 'kpopstan', 'kpopfandom',
          'fandomdrama', 'celebdrama', 'hollywooddrama', 'kpopnews',
          'kpopidol', 'viraledit', 'kdrama',
        ],
      },
      // X Trends — celebs flood the trending list, take 25
      xtrends:      { enabled: 1, topN: 25 },
      googletrends: {},
    },
    junk: {
      politicsPenalty: 40, kpopPenalty: 15, celebNoisePenalty: 0,
      noMemeShapePenalty: 25, noContentPenalty: 5, safeOverrideDivisor: 3, memeShapeBoost: 10,
    },
    alerts: {
      thresholds: { alertThreshold: 70, minScoreToSave: 0, maxAlertsPerCycle: 5, alertHardJunkStop: 70 },
      // meme/viral в этом пресете — основные сигналы (рекалибровка под AI-judgment +
      // organic engagement). Cross-platform spread в emergence убран на уровне
      // clusterer'а 4 мая (single-source velocity/breakout остались) — поэтому
      // emerge=0.10 не "вредный" сигнал. feedback=0 — celeb-фандомы поляризованы.
      weights:    { weightMemePotential: 0.50, weightVirality: 0.30, weightEmergence: 0.10, weightTwitter: 0.10, weightFeedback: 0.00, weightJunk: 0.55 },
      stale:      { staleDecayPerHour: 3, staleDecayGraceHours: 12, staleDecayCap: 40 },
    },
    cluster: { simThreshold: 0.55, timePenaltyHours: 24, weightEmbedding: 0.40, weightPhash: 0.30, weightEntity: 0.25, weightTicker: 0.05 },
  },

  events: {
    sources: {
      reddit: {
        // Removed: UpliftingNews — more "feel-good" than breaking events
        //          (better fits in general).
        // Added: nottheonion (weird-real events, "this is real not satire").
        subreddits: [
          'worldnews', 'news', 'technology', 'space',
          'Futurology', 'science', 'nottheonion',
        ],
        minUpvotes:        3000,   // News subs are lower-volume — catch breaking early
        postsPerSubreddit: 50,
      },
      twitter: {
        // Added political-cycle query for 2026 election relevance.
        // Note: Trump/election keywords belong here, not in celebrities,
        // because junk-filter has politicsPenalty=15 in events (low) vs 40+ elsewhere.
        queries: [
          '(breaking OR "breaking news" OR happening OR urgent OR alert) min_faves:10000 -is:retweet',
          '(NASA OR space OR mars OR moon OR launch OR rocket) min_faves:10000 -is:retweet',
          '(earthquake OR hurricane OR flood OR wildfire OR disaster) min_faves:5000 -is:retweet',
          '(championship OR final OR world cup OR super bowl OR olympics) min_faves:10000 -is:retweet',
          '(protest OR march OR rally OR movement OR strike) min_faves:10000 -is:retweet',
          '(AI OR ChatGPT OR robot OR artificial intelligence) min_faves:10000 -is:retweet',
          '(trump OR election OR debate OR primary OR vote OR campaign) min_faves:10000 -is:retweet',
        ],
      },
      tiktok: {
        // Hardcoded fallback list (events/news-themed) for when live-discovery
        // fails. Live trending hashtags from TikTok Creative Center will
        // surface event-driven tags organically (weathertok/tornadotok spike
        // around real disasters; aitechnology/technews around AI launches).
        hashtags: [
          'weathertok', 'tornadotok', 'stormchasing', 'aitechnology',
          'technews', 'sportshighlights', 'championsleague', 'nbaplayoffs',
          'ucl', 'spaceexploration', 'sciencefacts', 'breakingweather',
        ],
      },
      // X Trends — events dominate trending; take 30 (broadest cap, breaking news drives a lot)
      xtrends:      { enabled: 1, topN: 30 },
      googletrends: {},
    },
    junk: {
      politicsPenalty: 15, kpopPenalty: 30, celebNoisePenalty: 20,
      noMemeShapePenalty: 10, noContentPenalty: 0, safeOverrideDivisor: 2, memeShapeBoost: 4,
    },
    alerts: {
      thresholds: { alertThreshold: 60, minScoreToSave: 0, maxAlertsPerCycle: 5, alertHardJunkStop: 75 },
      weights:    { weightMemePotential: 0.10, weightVirality: 0.30, weightEmergence: 0.35, weightTwitter: 0.15, weightFeedback: 0.10, weightJunk: 0.30 },
      stale:      { staleDecayPerHour: 5, staleDecayGraceHours: 6, staleDecayCap: 60 },
    },
    cluster: { simThreshold: 0.45, timePenaltyHours: 6, weightEmbedding: 0.45, weightPhash: 0.15, weightEntity: 0.30, weightTicker: 0.10 },
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────────

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/**
 * Deep-clone a config tree. Used so callers can mutate without poisoning
 * the frozen DEFAULT_PRESET_CONFIGS.
 */
function clone(value) {
  if (Array.isArray(value)) return value.slice();
  if (isObj(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = clone(value[k]);
    return out;
  }
  return value;
}

/**
 * Recursively merge an override patch into a defaults tree.
 * Arrays are REPLACED, not concatenated (a list override fully wins).
 * Unknown keys in the patch are ignored (defensive against stale blobs).
 */
function deepMerge(defaults, patch) {
  if (!isObj(patch)) return clone(defaults);
  if (!isObj(defaults)) return clone(patch);
  const out = {};
  for (const k of Object.keys(defaults)) {
    if (k in patch) {
      const dv = defaults[k];
      const pv = patch[k];
      if (isObj(dv) && isObj(pv)) out[k] = deepMerge(dv, pv);
      else                         out[k] = clone(pv);
    } else {
      out[k] = clone(defaults[k]);
    }
  }
  // Keys present in patch but not in defaults: preserved verbatim. This lets
  // experimental fields land in storage without being silently dropped.
  for (const k of Object.keys(patch)) {
    if (!(k in defaults)) out[k] = clone(patch[k]);
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Resolve the effective config for a preset by deep-merging defaults with
 * any per-preset override patch.
 *
 * @param {string} preset       — preset key (general/animals/...)
 * @param {Object} [overrides]  — full overrides blob shape `{ <preset>: {...} }`
 * @returns {Object} fully populated config { sources, junk, alerts, cluster }
 */
export function resolvePresetConfig(preset, overrides = null) {
  const key = preset && PRESET_KEYS.includes(preset) ? preset : 'general';
  const base = DEFAULT_PRESET_CONFIGS[key];
  if (!isObj(overrides)) return clone(base);
  const patch = overrides[key];
  if (!isObj(patch)) return clone(base);
  return deepMerge(base, patch);
}

/**
 * Return a full table of effective configs for ALL presets. Useful for the
 * admin UI which renders a tab strip + needs every config server-resolved.
 */
export function getEffectivePresetConfigs(overrides = null) {
  const out = {};
  for (const key of PRESET_KEYS) {
    out[key] = resolvePresetConfig(key, overrides);
  }
  return out;
}

// ── Validation ─────────────────────────────────────────────────────────────────
//
// Walks the override blob, range-checks every leaf against PRESET_FIELD_RANGES,
// and strips fields that equal the default (keeps blob compact). Throws on
// any structural violation (unknown preset / unknown field / out-of-range).

function rangesAt(path) {
  // path = ['sources', 'reddit'], ['junk'], ['alerts', 'weights'], etc.
  let node = PRESET_FIELD_RANGES;
  for (const segment of path) {
    if (!isObj(node) || !(segment in node)) return null;
    node = node[segment];
  }
  return isObj(node) ? node : null;
}

function defaultsAt(presetKey, path) {
  let node = DEFAULT_PRESET_CONFIGS[presetKey];
  for (const segment of path) {
    if (!isObj(node) || !(segment in node)) return undefined;
    node = node[segment];
  }
  return node;
}

function validateLeafValue(meta, value, fqPath) {
  const t = meta.type;
  if (t === 'list') {
    if (!Array.isArray(value)) {
      throw new Error(`${fqPath}: must be an array`);
    }
    if (meta.max != null && value.length > meta.max) {
      throw new Error(`${fqPath}: too many items (max ${meta.max})`);
    }
    const cleaned = [];
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (typeof v !== 'string') {
        throw new Error(`${fqPath}[${i}]: must be a string`);
      }
      const trimmed = v.trim();
      if (trimmed.length === 0) continue; // drop blanks silently
      if (meta.itemMaxLen && trimmed.length > meta.itemMaxLen) {
        throw new Error(`${fqPath}[${i}]: too long (max ${meta.itemMaxLen})`);
      }
      cleaned.push(trimmed);
    }
    // Dedup while preserving order
    const seen = new Set();
    return cleaned.filter(x => seen.has(x) ? false : (seen.add(x), true));
  }
  // numeric
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`${fqPath}: not a number`);
  }
  if (meta.min != null && num < meta.min) {
    throw new Error(`${fqPath}: must be >= ${meta.min}`);
  }
  if (meta.max != null && num > meta.max) {
    throw new Error(`${fqPath}: must be <= ${meta.max}`);
  }
  if (t === 'int') return Math.round(num);
  return num;
}

/**
 * Recursive walker. For every leaf in `patch`:
 *   - find the matching range descriptor in PRESET_FIELD_RANGES
 *   - validate / coerce the value
 *   - if it equals the default, drop it (keep the override blob minimal)
 * Returns the cleaned subtree (may be {} if every value was default).
 */
function cleanSubtree(presetKey, path, patch) {
  if (!isObj(patch)) return null;
  const meta = rangesAt(path);
  if (meta === null) {
    // No range descriptor at this path → unknown subtree
    throw new Error(`${[presetKey, ...path].join('.')}: unknown subtree`);
  }
  const out = {};
  for (const [field, rawVal] of Object.entries(patch)) {
    const childMeta = meta[field];
    if (!childMeta) {
      throw new Error(`${[presetKey, ...path, field].join('.')}: unknown field`);
    }
    if (childMeta.type) {
      // Leaf descriptor
      const fqPath  = [presetKey, ...path, field].join('.');
      const cleaned = validateLeafValue(childMeta, rawVal, fqPath);
      const dflt    = defaultsAt(presetKey, [...path, field]);
      // Skip if equal to default (compact blob)
      if (Array.isArray(cleaned) && Array.isArray(dflt) &&
          cleaned.length === dflt.length &&
          cleaned.every((v, i) => v === dflt[i])) {
        continue;
      }
      if (!Array.isArray(cleaned) && cleaned === dflt) continue;
      out[field] = cleaned;
    } else {
      // Nested subtree (e.g. sources.reddit / alerts.weights)
      const sub = cleanSubtree(presetKey, [...path, field], rawVal);
      if (sub && Object.keys(sub).length > 0) out[field] = sub;
    }
  }
  return out;
}

/**
 * Constraint check: positive weight groups that must sum to ≤ 1.0.
 * Operates on the EFFECTIVE merged config (after applying patch on defaults).
 */
function assertWeightBudgets(presetKey, effective) {
  // alerts.weights — POSITIVE = everything except weightJunk
  const aw = effective.alerts?.weights || {};
  const positiveAlerts = ['weightMemePotential', 'weightVirality',
    'weightEmergence', 'weightTwitter', 'weightFeedback'];
  const sumA = positiveAlerts.reduce((s, k) => s + (Number(aw[k]) || 0), 0);
  if (sumA > 1.0001) {
    throw new Error(
      `${presetKey}.alerts.weights: positive sum is ${sumA.toFixed(2)} (> 1.00). ` +
      `Reduce other weights first.`
    );
  }
  // cluster — all 4 weight* are positive
  const cw = effective.cluster || {};
  const positiveCluster = ['weightEmbedding', 'weightPhash', 'weightEntity', 'weightTicker'];
  const sumC = positiveCluster.reduce((s, k) => s + (Number(cw[k]) || 0), 0);
  if (sumC > 1.0001) {
    throw new Error(
      `${presetKey}.cluster: positive sum is ${sumC.toFixed(2)} (> 1.00). ` +
      `Reduce other weights first.`
    );
  }
}

/**
 * Read the stored MANUAL overrides blob from DB settings. Tolerates missing /
 * malformed JSON — returns {} so callers always get a valid object.
 */
export function readPresetOverrides(db) {
  const raw = db?.getSetting?.('presetConfigs', null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) { return {}; }
}

/**
 * Read the AUTO overrides blob (written by tag-refresher Grok-call).
 * Same shape as manual overrides but stored under a different settings key.
 * Manual overrides ALWAYS win when both slots have a value for the same field.
 */
export function readPresetAutoOverrides(db) {
  const raw = db?.getSetting?.('presetConfigsAuto', null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) { return {}; }
}

/**
 * Read per-tag pin lock-mask. Shape: { <preset>: { <sourceType>: [<tag>, ...] } }
 * — locked items are protected from auto-refresh deletion. Manual overrides
 * already win by merge-order, so this is specifically about preventing
 * auto-refresh from overwriting individual list items.
 */
export function readPresetTagsLocked(db) {
  const raw = db?.getSetting?.('presetTagsLocked', null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) { return {}; }
}

/**
 * Convenience: resolve the active preset's config in a single call.
 * Used by collectors / scorer / clusterer / alert-loop on every cycle.
 *
 *   const cfg = getActivePresetConfig(db);
 *   // cfg.sources.reddit.subreddits, cfg.alerts.thresholds.alertThreshold, ...
 *
 * @param {Object} db                 — TrendDatabase instance
 * @param {Object} [opts]
 * @param {string} [opts.fallback]    — preset to use if activePreset setting is missing/invalid (default 'general')
 * @returns {{ preset: string, ...config }} effective config + which preset was resolved
 */
export function getActivePresetConfig(db, opts = {}) {
  const fallback = opts.fallback || 'general';
  const stored = db?.getSetting?.('activePreset', fallback) || fallback;
  const preset = PRESET_KEYS.includes(stored) ? stored : fallback;
  // 3-layer merge: defaults → auto-overrides → manual-overrides
  // Manual ALWAYS wins. Auto is the middle layer (Grok-suggested values).
  // If the same field appears in both auto and manual — manual is used.
  const autoOverrides = readPresetAutoOverrides(db);
  const manualOverrides = readPresetOverrides(db);
  const merged = mergeOverrideBlobs(autoOverrides, manualOverrides);
  const config = resolvePresetConfig(preset, merged);
  return { preset, ...config };
}

/**
 * Deep-merge two override blobs. Used to combine auto + manual layers.
 * Manual wins on conflict (passed second). Both blobs are sparse — fields
 * absent in BOTH simply don't appear in the merged result, and resolvePresetConfig
 * fills them from DEFAULT_PRESET_CONFIGS.
 */
function mergeOverrideBlobs(auto, manual) {
  const out = {};
  for (const preset of PRESET_KEYS) {
    const a = auto?.[preset];
    const m = manual?.[preset];
    if (!a && !m) continue;
    if (!a) { out[preset] = m; continue; }
    if (!m) { out[preset] = a; continue; }
    out[preset] = deepMerge(a, m);  // manual wins
  }
  return out;
}

/**
 * Sanitize and validate an overrides payload. Throws on the first error.
 * Returns a clean blob safe to JSON.stringify into settings.presetConfigs.
 *
 *   in:   { animals: { junk: { politicsPenalty: 75 }, alerts: { weights: { weightMemePotential: 0.4 } } } }
 *   out:  same shape, but with values coerced + defaults stripped
 */
export function validatePresetOverrides(input) {
  if (input == null) return {};
  if (!isObj(input)) throw new Error('presetConfigs: must be an object');
  const out = {};
  for (const [preset, patch] of Object.entries(input)) {
    if (!PRESET_KEYS.includes(preset)) {
      throw new Error(`presetConfigs: unknown preset '${preset}'`);
    }
    if (!isObj(patch)) throw new Error(`presetConfigs.${preset}: must be an object`);
    const cleanedPreset = {};
    for (const [group, body] of Object.entries(patch)) {
      if (!PRESET_GROUPS.includes(group)) {
        throw new Error(`presetConfigs.${preset}: unknown group '${group}'`);
      }
      const sub = cleanSubtree(preset, [group], body);
      if (sub && Object.keys(sub).length > 0) cleanedPreset[group] = sub;
    }
    // Budget guard: assert sums on the EFFECTIVE merged config (not just patch)
    const effective = deepMerge(DEFAULT_PRESET_CONFIGS[preset], cleanedPreset);
    assertWeightBudgets(preset, effective);
    if (Object.keys(cleanedPreset).length > 0) out[preset] = cleanedPreset;
  }
  return out;
}
