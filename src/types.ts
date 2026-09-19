export interface Settings {
  enabled: boolean;
  apiKey: string;
  model: string;
  /** Une ligne par centre d'intérêt, ex. "IA appliquée", "product management" */
  interests: string[];
  /** Sujets à masquer d'office, ex. "offres d'emploi", "crypto" */
  blocked: string[];
  /** Masquer si P(correspond aux intérêts) < seuil */
  interestThreshold: number;
  /** Masquer si P(engagement bait / auto-promo) > seuil */
  noiseThreshold: number;
  /** Ne jamais masquer un post de moins de N caractères (souvent une image seule) */
  minChars: number;
  hideSponsored: boolean;
  /** Afficher, sur les posts gardés, pourquoi Jev les a laissés passer */
  showKeptReason: boolean;
  /** Pastille flottante « activité Jev » sur la page LinkedIn */
  showSticker: boolean;
}

/** Sous-ensemble des réglages exposé au content script (jamais la clé API). */
export type UiSettings = Pick<
  Settings,
  "enabled" | "showKeptReason" | "showSticker" | "noiseThreshold" | "interestThreshold"
>;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  apiKey: "",
  model: "jev-latest",
  interests: [],
  blocked: [],
  interestThreshold: 0.35,
  noiseThreshold: 0.7,
  minChars: 40,
  hideSponsored: true,
  showKeptReason: true,
  showSticker: true,
};

export type Reason =
  | "engagement_bait"
  | "self_promo"
  | "off_topic"
  | "blocked_topic"
  | "sponsored";

export interface Verdict {
  hide: boolean;
  reason?: Reason;
  detail?: string;
  /** scores bruts, utiles pour le debug */
  scores?: Record<string, number>;
}

export interface PostPayload {
  id: string;
  author: string;
  text: string;
  sponsored: boolean;
}

/** Ce qu'a coûté le verdict : sert à la pastille d'activité. */
export interface CallMeta {
  /** false si aucun appel à Jev n'a été nécessaire (sponsorisé, trop court, filtrage coupé) */
  evaluated: boolean;
  cached: boolean;
  ms: number;
  inputTokens: number;
  model?: string;
}

export type Message =
  | { type: "classify"; post: PostPayload }
  | { type: "getUiSettings" }
  | { type: "openOptions" };

export type ClassifyResponse =
  | { ok: true; verdict: Verdict; meta: CallMeta }
  | { ok: false; error: string };
