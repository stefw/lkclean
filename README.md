# lkclean

**English** · [Français](README.fr.md)

A Chrome extension (Manifest V3, TypeScript) that cleans up your LinkedIn feed.
Every post is sent to **Jev**, the typed classification model from
[TypeSafe AI](https://typesafe.ai), which returns probabilities instead of prose.
Engagement bait, self-promotion, off-topic and sponsored posts are collapsed into
a one-line bar, and every decision is explained right on the post.

> Not affiliated with LinkedIn or TypeSafe AI. You need your own TypeSafe API key.

## What it does

- **Hides the noise** – engagement bait, humble-brags, sponsored posts, topics you
  block, and posts unrelated to the interests you list.
- **Explains itself** – hidden posts show the reason and the scores, with a
  *Show* / *Hide again* toggle. Kept posts get a discreet "Kept by Jev" line with
  their scores; a score close to the threshold turns orange ("kept, barely"), which
  makes tuning the thresholds easy.
- **Jev activity sticker** – a small floating badge (bottom left) pulses while
  calls are in flight. Click it for posts analysed/hidden, calls in flight, tokens,
  estimated cost, average latency, a latency sparkline and the latest verdicts.
- **Keeps infinite scroll alive** – when most posts are collapsed the feed becomes
  too short for LinkedIn's "load more" trigger; lkclean nudges it without moving
  your reading position.
- **Cheap and fast** – one API call per post, all questions evaluated in parallel,
  verdicts cached per session. Roughly $0.042 per million input tokens: a scrolling
  session costs a fraction of a cent.

## How it works

1. A content script watches the feed with a `MutationObserver` and picks up each
   post: `[data-testid="mainFeed"] [role="listitem"]` on LinkedIn's current React
   front end (text in `[data-testid="expandable-text-box"]`), with fallbacks for the
   legacy `data-id="urn:li:activity:…"` markup. Posts are identified by a hash of
   their text, since LinkedIn no longer exposes a stable id.
2. Author and text go to the service worker, which calls
   `POST https://api.typesafe.ai/v1/systemone` with a *state*
   `{ user_interests, post }` and several typed questions in a single request:

   | Question | Type | Meaning |
   | --- | --- | --- |
   | `engagement_bait` | `noul` | clickbait, rhetorical closing question, hollow storytelling |
   | `self_promo` | `noul` | "thrilled to announce", humble-brag, company PR |
   | `matches_interests` | `noul` | does the post cover one of your interests? |
   | `blocked_topic` | `choice` | topics you always want hidden |

3. Plain code turns the probabilities into a verdict using your thresholds
   (`decide()` in `src/background.ts`). No free-text parsing anywhere.
4. The content script collapses or annotates the post and updates the sticker.

The API key lives only in the service worker: it is never sent to the LinkedIn
page or to the content script.

## Install

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable *Developer mode* → *Load unpacked*
→ select the `dist/` folder.

Click the extension icon to open the settings: paste your TypeSafe key
(from [console.typesafe.ai](https://console.typesafe.ai)), list your interests
(one per line), optionally list blocked topics, and adjust the thresholds.
Reload LinkedIn.

After each rebuild, press ↻ on the extension card in `chrome://extensions`, then
reload the LinkedIn tab.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Interests | empty | If empty, only noise is filtered (bait, self-promo, sponsored) |
| Blocked topics | empty | Always hidden when Jev is ≥ 60 % confident |
| Noise threshold | 70 % | Hide when P(bait) or P(self-promo) is above it |
| Interest threshold | 35 % | Hide when P(matches interests) is below it |
| Hide sponsored | on | Detected locally, no API call |
| Minimum length | 40 chars | Shorter posts are never evaluated |
| Explain kept posts | on | The "Kept by Jev" line |
| Activity sticker | on | The floating Jev badge |
| Model | `jev-latest` | Pin a version such as `jev-1.13.0` once your thresholds are tuned |

The UI is currently in French.

## Privacy

- The author name and text of each post displayed in your feed are sent to the
  TypeSafe API for classification. Nothing else leaves your browser, and lkclean
  has no server or analytics of its own.
- The API key is stored in Chrome's synced storage (`chrome.storage.sync`).
- Verdicts are cached in `chrome.storage.session` and cleared when the browser
  closes or the settings change.

## Development

```bash
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
```

| File | Role |
| --- | --- |
| `src/content.ts` | post detection, extraction, hiding/annotating, infinite-scroll nudge |
| `src/sticker.ts` | the Jev activity sticker (Shadow DOM) |
| `src/background.ts` | questions, decision logic, cache, API calls |
| `src/jev.ts` | minimal typed client for the System One endpoint |
| `src/options.ts`, `public/options.*` | settings page |

To change what gets filtered, edit `buildQuestions()` and `decide()` in
`src/background.ts`. Jev evaluates every question independently and in parallel,
so an extra question costs almost no latency.

## When LinkedIn changes its markup

LinkedIn's DOM changes regularly. Selectors are grouped at the top of
`src/content.ts` (`POST_SELECTORS`, `TEXT_SELECTORS`, `AUTHOR_SELECTORS`).

If no post is detected 6 seconds after landing on `/feed`, the extension logs a
`[lkclean] DIAGNOSTIC` block in the page console describing the page structure
(attribute names only, no content). That block is all you need to write new
selectors. Every verdict is also logged at the *Verbose* console level.

A red **!** badge on the extension icon means the last API call failed (missing or
rejected key, API unreachable); the message is in the sticker and in the console.

## License

[MIT](LICENSE)
