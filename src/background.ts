import { askJev, type Answer, type Question } from "./jev";
import {
  DEFAULT_SETTINGS,
  type CallMeta,
  type ClassifyResponse,
  type Message,
  type PostPayload,
  type Settings,
  type UiSettings,
  type Verdict,
} from "./types";

interface Classified {
  verdict: Verdict;
  meta: CallMeta;
}
const NO_CALL: CallMeta = { evaluated: false, cached: false, ms: 0, inputTokens: 0 };

// ---------- réglages ----------

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

// ---------- cache des verdicts (session) ----------

const memCache = new Map<string, Verdict>();

async function cacheGet(id: string): Promise<Verdict | undefined> {
  const hit = memCache.get(id);
  if (hit) return hit;
  const key = `v:${id}`;
  const stored = await chrome.storage.session.get(key);
  const v = stored[key] as Verdict | undefined;
  if (v) memCache.set(id, v);
  return v;
}

async function cacheSet(id: string, v: Verdict): Promise<void> {
  memCache.set(id, v);
  await chrome.storage.session.set({ [`v:${id}`]: v });
}

// Un changement de réglages invalide les verdicts.
chrome.storage.onChanged.addListener((_, area) => {
  if (area === "sync") {
    memCache.clear();
    void chrome.storage.session.clear();
    void chrome.action.setBadgeText({ text: "" });
  }
});

// ---------- questions posées à Jev ----------

function buildQuestions(s: Settings) {
  // Consignes en anglais : Jev est entraîné d'abord sur l'anglais (les posts, eux, restent dans leur langue).
  const q: Record<string, Question> = {
    engagement_bait: {
      type: "noul",
      instructions:
        "Is this LinkedIn post engagement bait: content designed primarily to trigger reactions rather than to inform?",
      criteria: {
        true: "Rhetorical closing question (\"Agree?\", \"Thoughts?\", \"Qu'en pensez-vous ?\"), hollow emotional storytelling, clickbait hook, generic opinion with no substance, polls or 'comment X to get Y' mechanics",
        false: "The post delivers concrete information, analysis, data or first-hand experience the reader can use",
      },
    },
    self_promo: {
      type: "noul",
      instructions:
        "Is this post mainly self-promotion (personal announcement, humble-brag, celebrating a job/award/certification) with nothing useful for the reader?",
      criteria: {
        true: "\"I'm thrilled to announce\", new job, certification, thanking the team, company PR, with no takeaway for the reader",
        false: "Even if it talks about the author, the post shares something the reader can act on or learn from",
      },
    },
  };

  if (s.interests.length > 0) {
    q.matches_interests = {
      type: "noul",
      instructions:
        "Does the post substantially cover at least one of the user's interests (listed in state.user_interests)?",
      criteria: {
        true: "The main subject of the post clearly overlaps one of the interests",
        false: "The post is off-topic or only touches the theme in passing",
      },
    };
  }

  // « Lequel ? » : matches_interests ne donne qu'une probabilité globale, pas le sujet concerné.
  if (s.interests.length > 1) {
    const criteria: Record<string, string | null> = { none: "The post does not substantially cover any of them" };
    for (const t of s.interests) criteria[t] = null;
    q.top_interest = {
      type: "choice",
      instructions:
        "Which one of the user's interests does the post cover most substantially? If it covers none of them, answer 'none'.",
      criteria,
    };
  }

  if (s.blocked.length > 0) {
    const criteria: Record<string, string | null> = { none: "None of the blocked topics" };
    for (const t of s.blocked) criteria[t] = null;
    q.blocked_topic = {
      type: "choice",
      instructions:
        "Is the post mainly about one of the topics the user wants hidden? If not, answer 'none'.",
      criteria,
    };
  }

  return q;
}

// ---------- décision ----------

function decide(s: Settings, answers: Record<string, Answer>): Verdict {
  const noul = (k: string) => {
    const a = answers[k];
    return a?.type === "noul" ? a.noul : undefined;
  };
  const scores: Record<string, number> = {};

  const bait = noul("engagement_bait");
  const promo = noul("self_promo");
  const match = noul("matches_interests");
  if (bait !== undefined) scores.engagement_bait = bait;
  if (promo !== undefined) scores.self_promo = promo;
  if (match !== undefined) scores.matches_interests = match;

  // Un seul intérêt déclaré : pas besoin de demander lequel.
  const top = answers.top_interest;
  let interest: string | undefined;
  if (top?.type === "choice") {
    if (top.choice !== "none") interest = top.choice;
    scores.top_interest_confidence = top.confidence;
  } else if (s.interests.length === 1 && match !== undefined && match >= s.interestThreshold) {
    interest = s.interests[0];
  }

  const blocked = answers.blocked_topic;
  if (blocked?.type === "choice") {
    scores.blocked_confidence = blocked.confidence;
    if (blocked.choice !== "none" && blocked.confidence >= 0.6) {
      return { hide: true, reason: "blocked_topic", detail: blocked.choice, interest, scores };
    }
  }

  if (bait !== undefined && bait >= s.noiseThreshold) {
    return { hide: true, reason: "engagement_bait", detail: pct(bait), interest, scores };
  }
  if (promo !== undefined && promo >= s.noiseThreshold) {
    return { hide: true, reason: "self_promo", detail: pct(promo), interest, scores };
  }
  // On ne masque pour hors-sujet que si Jev est vraiment sûr que ça ne colle pas.
  if (match !== undefined && match < s.interestThreshold) {
    return { hide: true, reason: "off_topic", detail: pct(match), scores };
  }
  return { hide: false, interest, scores };
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

// ---------- classification ----------

// Deux demandes simultanées pour le même post ne doivent coûter qu'un appel.
const inflight = new Map<string, Promise<Classified>>();

function classify(post: PostPayload): Promise<Classified> {
  const pending = inflight.get(post.id);
  if (pending) return pending;
  const p = classifyOnce(post)
    .catch((e: unknown) => {
      // Signal visible sur l'icône : sans ça une clé absente/invalide passe inaperçue.
      void chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
      void chrome.action.setBadgeText({ text: "!" });
      throw e;
    })
    .finally(() => inflight.delete(post.id));
  inflight.set(post.id, p);
  return p;
}

async function classifyOnce(post: PostPayload): Promise<Classified> {
  const s = await loadSettings();
  if (!s.enabled) return { verdict: { hide: false }, meta: NO_CALL };

  if (post.sponsored && s.hideSponsored) {
    return { verdict: { hide: true, reason: "sponsored" }, meta: NO_CALL };
  }
  if (post.text.trim().length < s.minChars) return { verdict: { hide: false }, meta: NO_CALL };

  const cached = await cacheGet(post.id);
  if (cached) return { verdict: cached, meta: { ...NO_CALL, evaluated: true, cached: true } };

  if (!s.apiKey) throw new Error("Clé API TypeSafe manquante (voir les options de l'extension).");

  const state = {
    user_interests: s.interests,
    post: { author: post.author, text: post.text.slice(0, 4000) },
  };

  const t0 = performance.now();
  const res = await askJev(s.apiKey, s.model, state, buildQuestions(s));
  const ms = Math.round(performance.now() - t0);
  void chrome.action.setBadgeText({ text: "" });
  const verdict = decide(s, res.answers as Record<string, Answer>);
  await cacheSet(post.id, verdict);
  return {
    verdict,
    meta: { evaluated: true, cached: false, ms, inputTokens: res.usage?.input_tokens ?? 0, model: res.model },
  };
}

// ---------- messagerie ----------

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === "classify") {
    classify(msg.post)
      .then(({ verdict, meta }) => sendResponse({ ok: true, verdict, meta } satisfies ClassifyResponse))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ClassifyResponse),
      );
    return true; // réponse asynchrone
  }
  if (msg.type === "getUiSettings") {
    // Le content script ne reçoit que ce dont il a besoin pour l'affichage : jamais la clé API.
    loadSettings().then((s) =>
      sendResponse({
        enabled: s.enabled,
        showKeptReason: s.showKeptReason,
        showSticker: s.showSticker,
        noiseThreshold: s.noiseThreshold,
        interestThreshold: s.interestThreshold,
      } satisfies UiSettings),
    );
    return true;
  }
  if (msg.type === "openOptions") {
    void chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
