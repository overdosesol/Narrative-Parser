# Catalyst Twitter Context

Этот файл используется как постоянная память для Twitter/shilling сессий по проекту `Catalyst` / `TrendScout`.

## Session Contract

- This file is the working memory for Twitter/shilling sessions
- During these sessions, other project files must not be modified unless the user explicitly requests it
- This file may be updated to store context, drafts, published tweets, and posting notes

## Purpose

- Хранить рабочий контекст по продукту
- Фиксировать стиль и tone of voice аккаунта
- Хранить черновики, идеи и заметки для следующих постов
- History of published posts lives in `posts/history.md`

## Product Context

- Product: `Catalyst` (`TrendScout` / `Narrative Parser` в кодовой базе)
- Core idea: AI system for early narrative detection in the trenches
- Main job: monitor `Reddit`, `Twitter/X`, `TikTok`, and `Google Trends` 24/7
- Goal: detect viral narratives before they fully hit CT and estimate which ones can become Solana memecoins in the next `24-72h`
- Product angle: speed, timing, signal quality, early edge

## Messaging Pillars

- Early narrative detection
- Finding trends before the crowd
- Multi-source monitoring
- Signal over noise
- Actionable edge for memecoin traders
- Explanations of how the system works
- Build in public around detection/scoring infrastructure

## Tone Of Voice

- Language: English
- Short, clean, high-signal writing
- Confident, but not cringe or overhyped
- Product-first framing
- Slightly more alive and punchy than dry corporate copy
- Add a small amount of degen / crypto-native language when it fits naturally
- Stay near an official brand voice: sharp, credible, controlled
- Focus on user edge, not generic feature announcements
- Prefer strong opening hook
- Keep paragraphs short and scannable
- Use lists when explaining mechanics
- End with a concise takeaway line

## Style Notes From Existing Posts

- Start with one strong claim or observation
- Add spacing between short paragraphs
- Explain either:
  - what Catalyst does
  - how the system works
  - why timing matters
- Reuse vocabulary that fits the brand:
  - `narratives`
  - `viral`
  - `before`
  - `edge`
  - `trenches`
  - `24/7`
- Add light crypto-native phrasing when useful:
  - `CT`
  - `degens`
  - `ape`
  - `front-run the narrative`
  - `crowded trade`
  - `obvious in hindsight`
- Do not overdo degen slang; use it as spice, not as the whole voice
- Common structure:
  - Hook
  - 3-6 short lines or bullets
  - Closing sentence with the edge / why it matters

## Writing Prompt For Future Drafts

Use this writing direction when drafting tweets:

- Write in English
- Keep the post concise, sharp, and easy to scan
- Sound slightly degen and crypto-native, but still credible and close to an official product voice
- Avoid sounding like exaggerated shilling or low-effort hype
- Prefer one core insight per tweet
- Emphasize timing, edge, narrative spread, signal quality, or trader advantage
- If degen phrasing is used, keep it light and intentional
- The result should feel more alive than SaaS copy, but cleaner than pure CT slang

## Visual Style Guide

These notes define the image style for Catalyst Twitter posts. Future image prompts should follow this direction.

### Core Visual Identity

- Black background is the default base
- Minimal, high-contrast compositions
- White primary elements and typography
- Red is the main accent color
- Occasional subtle RGB/glitch edges are allowed on the mascot/logo
- Visual feel: sharp, dark, tactical, signal-driven, slightly cyberpunk
- Overall style should feel like a clean crypto intelligence brand, not a generic SaaS brand

### Brand Motifs

- Main mascot/logo: the Catalyst cat / fox-like head mark
- The mascot can appear as:
  - clean white symbol
  - white symbol with light glitch / chromatic aberration
  - avatar-style central icon on black
- The mascot should feel soft-clean and recognizable, similar to the current avatar
- Preferred mascot shape:
  - rounded cat head silhouette
  - simple pointed ears
  - minimal face details
  - small dark oval eyes
  - tiny nose / mouth mark
  - short whiskers when appropriate
  - clean icon-like silhouette, close to the existing avatar
- Expression should feel calm, mysterious, soft, and signal-like rather than aggressive
- Prefer outline / translucent white / frosted white treatment over fully solid white fill
- The mascot may have a subtle transparent glow or glassy white look, but should remain minimal
- If the mascot becomes muddy or low-contrast, reduce or remove the outer glow so the silhouette reads more clearly
- Readability of the mascot is more important than atmospheric glow
- Platform logos can be used when relevant:
  - Reddit
  - X
  - TikTok
  - Google Trends / chart arrow symbol
- Use arrows, loops, node flows, and directional movement to communicate spread, detection, routing, and alerts

### Composition Rules

- Keep layouts simple and immediately readable
- Prefer one central idea per image
- Use large empty black space when possible
- Prefer centered or strongly structured compositions
- Text, if present, should be large, bold, and easy to read at Twitter size
- Diagrams should be minimal, not dense UI mockups
- Use visual hierarchy with 3 colors at most: black, white, red
- Visual logic must be believable at a glance
- Avoid fake causal chains that imply one post directly creates activity on unrelated platforms
- If multiple platforms are shown, present them as monitored signal sources or parallel signal surfaces, not as a literal transformation pipeline unless that pipeline is real
- Prefer concepts like detection, convergence, spread, clustering, filtering, ranking, or alerting over made-up AI sci-fi mechanics

### Typography

- Bold, uppercase sans-serif works best
- Clean, geometric, modern type
- Short phrases only
- Text should feel punchy and declarative
- Avoid paragraph-heavy graphics
- Prefer no punctuation in large headline text when it improves visual clarity
- If two statements are stacked, separate them with spacing, a bar, or a graphic divider instead of punctuation when possible

### Allowed Visual Treatments

- Light glitch effects
- Slight CRT / scanline / static texture
- Neon red glow used sparingly
- Clean arrows and flow diagrams
- Boxed metrics / labeled modules
- Minimal iconography
- Red underlines / bars / structural dividers
- Red framing brackets / crop marks / research-note markers
- Thin convergence lines or restrained ripple arcs

### Avoid

- Colorful rainbow palettes
- Soft pastel gradients
- Cartoon meme art
- Busy dashboard screenshots as final artwork
- Photorealistic humans
- 3D coins, rockets, moons, lambos
- Overdesigned sci-fi interfaces
- Cute or playful mascot rendering
- Rounded kawaii cat faces
- Soft pet-logo aesthetics
- Fully solid heavy white mascot fills when a lighter translucent treatment would work better
- Any mascot with goofy or overexpressive emotion
- Generic red signal blobs, glowing red flares, or vague red energy bursts
- Any style that feels noisy, childish, or scammy

### Reference Style Summary

- Reference 1: ecosystem loop around the mascot; black background, white symbols, simple arrows, subtle glitch energy
- Reference 2: bold statement poster; mostly text, very little decoration, strong red accent, premium and aggressive
- Reference 3: minimal process diagram; red arrows, white labels, black base, simple schematic explanation
- Reference 4: avatar/logo treatment; central white mascot with glitch distortion on black, this is the strongest brand anchor
- Mascot note: current preferred mascot direction is the softer avatar-style cat head, not the sharper predator-head variant
- Direction shift: avoid visuals that look like generic crypto ads, AI dashboards, or scammy "alpha tool" creatives
- Preferred direction now: editorial research cover / manifesto poster / field-note artifact

### Image Prompt Direction For ChatGPT

When generating images in ChatGPT, keep prompts aligned with this:

- square format for Twitter
- black background
- white Catalyst mascot or white typography as the main focal point
- mascot should use a softer avatar-like cat head with translucent / outline white treatment when possible
- red accents only where needed for emphasis
- minimal composition
- bold, high-contrast, instantly readable
- slight glitch/CRT texture is welcome
- should feel like a dark crypto intelligence poster, not ad creative spam

## Prompt Writing Rules

These rules should be followed in future sessions and by other models when writing prompts for tweets or images.

### General Prompt Style

- Write prompts in clear English
- Be specific, not shorthand
- Describe the goal first, then the structure, then the style, then the constraints
- Prefer full instructions over short vague prompts
- Make the prompt readable and well-separated by sections
- The prompt should be usable as-is in ChatGPT or adapted with minimal edits for other models

### Why This Works

- Detailed prompts produce more consistent results
- Structured prompts reduce random stylistic drift between sessions and models
- Explicit constraints help preserve brand consistency
- Strong prompts should explain both what to do and what to avoid

### Prompt Structure Template

When possible, prompts should follow this order:

1. What to create
2. Brand / style constraints
3. Main concept or message
4. Composition or writing structure
5. Specific brand elements
6. Mood / tone
7. Text to include, if any
8. Typography / formatting notes, if relevant
9. Avoid list
10. One final sentence describing the desired overall result

### Image Prompt Rules

- Start with the exact asset type: `Create a square Twitter image...`
- State the brand system early: black / white / red, minimal, high-contrast, Catalyst style
- Explain the visual logic clearly so the model does not invent nonsense cause-and-effect
- Describe the composition left-to-right or center-focused
- Specify how the mascot should look if it appears
- Include text-on-image explicitly if needed
- Always include an `Avoid:` section
- End with one line summarizing the final feel of the image

### Tweet Writing Prompt Rules

- State the desired tone explicitly:
  - English
  - concise
  - sharp
  - slightly degen
  - still close to an official brand voice
- Tell the model the tweet should focus on one insight only
- Mention whether the post should be:
  - positioning
  - educational
  - thesis-driven
  - product explanation
  - build-in-public
- If needed, ask for multiple options with different intensity levels
- Prefer prompts that mention what to avoid: cringe shilling, generic startup tone, overhype, vague claims

### Cross-Model Consistency Rule

- Prompts should be written so another GPT/Claude/Gemini/OpenCode session can reuse them without extra explanation
- Do not rely on hidden context if the prompt can include it directly
- Important brand constraints should be embedded in the prompt itself, not assumed
- If a visual or tweet depends on a specific reference, describe the reference in words inside the prompt

### Preferred Prompt Quality

- Good prompts from this workflow are usually long, explicit, and well-structured
- Short prompts are acceptable only if they preserve all critical brand constraints
- If choosing between short and precise vs shorter and vaguer, prefer precise

### Working Rule For Future Sessions

- When writing prompts, match the level of detail used in this file
- Do not reduce prompts to one-liners unless explicitly asked
- The current preferred prompt style is the detailed format used in this session because it produces the most reliable results

### Image System Rules

- Every image should look like it belongs to the same brand system
- If the image is text-led, keep it poster-like and severe
- If the image is explanatory, keep it diagrammatic and stripped-down
- If the mascot is used, preserve the existing avatar vibe: white mark, black field, light glitch energy
- Default question before generating a visual: can this be simplified further?
- Default question before generating a visual: does the logic make sense instantly, without explanation?
- Better question: does this feel like a brand artifact or a scammy crypto ad?
- Prefer visuals that look like:
  - a manifesto cover
  - a research note cover
  - an intelligence brief artifact
  - an editorial culture/tech poster
- Avoid visuals that look like:
  - an AI tool landing page
  - a trading bot promo
  - a growth-hack crypto ad

### Preferred Visual Direction

- Stronger uniqueness comes from worldview, typography, and restraint, not from adding more crypto visual tropes
- The image should support one thesis, not explain the entire product
- The image should feel native to smart crypto/design Twitter, not like paid ad creative
- Use one visual metaphor per post at most
- Favor editorial composition over product explainer composition
- If a red accent object is needed, prefer graphic structure over glowing abstraction
- Best red accent replacements for vague "signal blob" visuals:
  - framing brackets
  - red underline / bar
  - convergence lines
  - restrained ripple arcs
  - small editorial labels
- Remove small metadata blocks if they make the visual feel busy or fake-editorial

## Published Posts

### Post 1

- URL: https://x.com/Catalystparser/status/2043693175248695630
- Theme: product introduction
- Notes:
  - Introduces Catalyst
  - Explains the high-level value proposition
  - Frames the system as the fastest narrative detection system for the trenches

### Post 2

- URL: https://x.com/Catalystparser/status/2043799591670427972
- Theme: how Catalyst works
- Notes:
  - Explains the system in stages
  - Educational / explainer format
  - Good reference for process posts and breakdown threads

### Post 3

- URL: https://x.com/Catalystparser/status/2044113458954895496
- Theme: timing and why being early matters
- Notes:
  - Contrasts early signal discovery vs seeing narratives only after they hit CT
  - Strong positioning around timing edge
  - Good reference for thesis-driven posts

## Posting Rules For Future Sessions

- Match the existing Catalyst voice and formatting
- Keep posts in English unless explicitly requested otherwise
- Avoid bloated marketing language
- Prefer clear claims over vague hype
- Tie every post to one concrete angle
- If describing a feature, explain why it matters to the trader
- Maintain consistency with the product's real capabilities in code
- In Twitter/shilling sessions, do not modify other project files unless the user explicitly asks for it
- Do not save draft tweets in this file while brainstorming
- Save tweet text here only after the user explicitly confirms the tweet was published

## Draft Log

Add future drafts here before posting.

## Published Log

Add newly published tweets here with:

- Date
- URL
- Theme
- Final text
- Notes on performance or follow-up ideas

## Session Notes

- Current working assumption: public brand is `Catalyst`
- Codebase/internal name: `TrendScout`
- Need to keep brand wording consistent in public-facing posts
- Scope rule: this file is the working memory for Twitter content; other project files must remain untouched unless explicitly requested by the user
- Future tweet drafts should lean slightly more degen and more alive, while staying controlled and near-official in tone
