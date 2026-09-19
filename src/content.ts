import { sticker } from "./sticker";
import type { ClassifyResponse, Message, PostPayload, Reason, UiSettings, Verdict } from "./types";

// Sélecteurs LinkedIn : les classes sont obfusquées et bougent souvent, on vise
// en priorité les attributs data-* (bien plus stables) puis des fallbacks.
const POST_SELECTORS = [
  // nouveau front React : le fil est une liste ARIA, un listitem par post
  '[data-testid="mainFeed"] [role="listitem"]',
  // ancien front Ember
  'div[data-id^="urn:li:activity"]',
  'div[data-urn^="urn:li:activity"]',
  "div.feed-shared-update-v2",
];
const TEXT_SELECTORS = [
  '[data-testid="expandable-text-box"]',
  ".update-components-text",
  ".feed-shared-update-v2__description",
  ".feed-shared-inline-show-more-text",
];
// Les commentaires réutilisent les mêmes composants de texte que les posts.
const COMMENTS_SELECTOR = '[data-testid*="commentList"], [componentkey^="replaceableComment"]';
const AUTHOR_SELECTORS = [
  ".update-components-actor__title",
  ".update-components-actor__name",
];

const PROCESSED = "lkcleanProcessed";
// Attribut plutôt que classe : React réécrit className à chaque rendu, pas les attributs qu'il ignore.
const HIDDEN_ATTR = "data-lkclean-hidden";
const MAX_CONCURRENT = 4;

const REASON_LABEL: Record<Reason, string> = {
  engagement_bait: "engagement bait",
  self_promo: "auto-promo",
  off_topic: "hors de tes centres d'intérêt",
  blocked_topic: "sujet masqué",
  sponsored: "sponsorisé",
};

// ---------- extraction ----------

function firstText(root: Element, selectors: string[]): string {
  for (const sel of selectors) {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest(COMMENTS_SELECTOR)) continue;
      let t = el.innerText?.trim() ?? "";
      // Retire le libellé du bouton « … plus » inclus dans la boîte de texte.
      const more = el.querySelector<HTMLElement>('[data-testid="expandable-text-button"]')?.innerText.trim();
      if (more && t.endsWith(more)) t = t.slice(0, -more.length).trim();
      if (t) return t;
    }
  }
  return "";
}

// \b ne fonctionne pas après « é » : on borne avec des lookarounds Unicode.
const SPONSORED_RE = /(?<!\p{L})(sponsoris[ée]e?|promoted|promue?)(?!\p{L})/u;

// Le libellé peut être collé au nom de l'auteur dans innerText (« Acme CorpSponsorisé ») :
// on regarde aussi chaque petit élément feuille de l'en-tête isolément.
function hasSponsoredLabel(el: HTMLElement): boolean {
  let checked = 0;
  for (const leaf of el.querySelectorAll<HTMLElement>("span, p, a, div")) {
    if (leaf.childElementCount > 0) continue;
    if (leaf.closest(`${COMMENTS_SELECTOR}, ${TEXT_SELECTORS.join(",")}`)) continue;
    if (++checked > 40) break;
    const t = (leaf.textContent ?? "").trim().toLowerCase();
    if (t.length <= 30 && SPONSORED_RE.test(t)) return true;
  }
  return false;
}

function authorOf(el: HTMLElement): string {
  const named = firstText(el, AUTHOR_SELECTORS);
  if (named) return named.split("\n")[0] ?? "";
  // Nouveau front : pas d'attribut stable, on prend le premier lien de profil/page qui porte un nom.
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]')) {
    if (a.closest(COMMENTS_SELECTOR)) continue;
    const name = a.innerText.trim().split("\n")[0];
    if (name) return name.slice(0, 80);
  }
  return "";
}

function extract(el: HTMLElement): PostPayload | null {
  // Pas de repli sur innerText : sans vrai texte (image seule), on jugerait le post sur ses boutons.
  const text = firstText(el, TEXT_SELECTORS);
  // Le nouveau front n'expose plus l'URN (les componentkey sont des UUID par rendu) :
  // à défaut, on identifie le post par un hash de son texte, stable entre rechargements.
  const id =
    el.getAttribute("data-id") ??
    el.getAttribute("data-urn") ??
    el.querySelector("[data-urn]")?.getAttribute("data-urn") ??
    `h:${hash(text || el.innerText.slice(0, 300))}`;
  const author = authorOf(el);
  // On ne regarde que l'en-tête (avant le texte du post), sinon « I got promoted » passe pour une pub.
  const full = el.innerText;
  const textStart = text ? full.indexOf(text.slice(0, 40)) : -1;
  const head = (textStart > 0 ? full.slice(0, textStart) : full.slice(0, 300)).toLowerCase();
  const sponsored = SPONSORED_RE.test(head) || hasSponsoredLabel(el);

  return { id, author, text, sponsored };
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

// ---------- rendu ----------

let ui: UiSettings = {
  enabled: true,
  showKeptReason: true,
  showSticker: true,
  noiseThreshold: 0.7,
  interestThreshold: 0.35,
};

const pct = (x: number) => `${Math.round(x * 100)} %`;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// LinkedIn gère son thème sombre par classe, pas par prefers-color-scheme : on mesure le fond réel.
function isDarkPage(): boolean {
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return false;
  const [r, g, b] = m.map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}

/** Résumé en quelques mots d'un verdict, partagé entre la note du post et la pastille. */
function verdictLabel(v: Verdict): string {
  if (v.hide) return v.reason ? REASON_LABEL[v.reason] : "masqué";
  const match = v.scores?.matches_interests;
  return match !== undefined ? `intérêt ${pct(match)}` : "peu de bruit";
}

type ChipState = "plain" | "near" | "over";

// Où se situe chaque score par rapport au seuil qui fait masquer : franchi, frôlé (à 15 points), ou loin.
function scoreStates(v: Verdict): { label: string; value: number; state: ChipState; hint: string }[] {
  const sc = v.scores ?? {};
  const out: ReturnType<typeof scoreStates> = [];
  const m = sc.matches_interests;
  if (m !== undefined) {
    const state = m < ui.interestThreshold ? "over" : m < ui.interestThreshold + 0.15 ? "near" : "plain";
    out.push({ label: "intérêt", value: m, state, hint: `Masqué sous ${pct(ui.interestThreshold)}` });
  }
  for (const [key, label] of [["engagement_bait", "bait"], ["self_promo", "promo"]] as const) {
    const x = sc[key];
    if (x === undefined) continue;
    const state = x >= ui.noiseThreshold ? "over" : x > ui.noiseThreshold - 0.15 ? "near" : "plain";
    out.push({ label, value: x, state, hint: `Masqué à partir de ${pct(ui.noiseThreshold)}` });
  }
  return out;
}

function scoreChips(v: Verdict): HTMLElement[] {
  return scoreStates(v).map(({ label, value, state, hint }) => {
    // Sur un post masqué, seul le score qui a franchi le seuil ressort.
    const shown = v.hide && state === "near" ? "plain" : state;
    const c = node("span", `lkclean-chip lkclean-chip--${shown}`, `${label} ${pct(value)}`);
    c.title = hint;
    return c;
  });
}

function noteKept(el: HTMLElement, v: Verdict): void {
  if (!ui.showKeptReason || !v.scores || el.querySelector(":scope > .lkclean-note")) return;
  const tight = scoreStates(v).some((x) => x.state === "near");
  const why = v.scores.matches_interests !== undefined ? "pertinent pour toi" : "peu de bruit";
  const note = node("div", `lkclean-note${isDarkPage() ? " lkclean--dark" : ""}`);
  const lead = node("span", "lkclean-note__lead");
  lead.append(
    node("span", `lkclean-note__dot${tight ? " lkclean-note__dot--near" : ""}`),
    node("b", "", tight ? "Gardé de justesse" : "Gardé par Jev"),
    ` · ${why}`,
  );
  note.append(lead, ...scoreChips(v));
  el.prepend(note);
}

function hidePost(el: HTMLElement, v: Verdict): void {
  if (el.hasAttribute(HIDDEN_ATTR)) return;
  el.querySelector(":scope > .lkclean-note")?.remove();
  const bar = node("div", `lkclean-bar${isDarkPage() ? " lkclean--dark" : ""}`);
  const reason = node("span", "lkclean-bar__reason");
  reason.append("Post masqué · ", node("b", "", verdictLabel(v)), v.detail ? ` · ${v.detail}` : "");
  const btn = node("button", "", "Afficher");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const shown = el.toggleAttribute(HIDDEN_ATTR) === false;
    btn.textContent = shown ? "Re-masquer" : "Afficher";
    bar.classList.toggle("lkclean-bar--shown", shown);
  });
  bar.append(reason, ...scoreChips(v), btn);
  el.prepend(bar);
  el.setAttribute(HIDDEN_ATTR, "");
}

// ---------- pipeline ----------

const queue: HTMLElement[] = [];
let running = 0;
let apiBroken = false;
const attempts = new WeakMap<HTMLElement, number>();
const MAX_ATTEMPTS = 5;
let seen = 0;

const ANY_POST = POST_SELECTORS.join(",");

function enqueue(el: HTMLElement): void {
  // Les sélecteurs matchent aussi des conteneurs imbriqués : on ne traite que le plus externe.
  const outer = el.parentElement?.closest<HTMLElement>(ANY_POST);
  if (outer) return enqueue(outer);
  if (el.dataset[PROCESSED]) return;
  el.dataset[PROCESSED] = "1";
  if (seen++ === 0) console.info("[lkclean] premier post détecté");
  lastArrival = Date.now();
  kicks = 0;
  queue.push(el);
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const el = queue.shift()!;
    running++;
    void process(el).finally(() => {
      running--;
      pump();
    });
  }
}

async function process(el: HTMLElement): Promise<void> {
  if (apiBroken || !ui.enabled) return;
  const post = extract(el);
  if (!post) return;

  // React insère souvent le conteneur avant son contenu : on libère le post pour qu'une
  // mutation ultérieure (arrivée du texte) le remette en file, dans la limite de MAX_ATTEMPTS.
  if (!post.text && !post.sponsored) {
    const n = (attempts.get(el) ?? 0) + 1;
    attempts.set(el, n);
    if (n < MAX_ATTEMPTS) delete el.dataset[PROCESSED];
    return;
  }

  let res: ClassifyResponse;
  sticker.start();
  try {
    res = await chrome.runtime.sendMessage<Message, ClassifyResponse>({ type: "classify", post });
  } catch (e) {
    console.warn("[lkclean] message error", e);
    sticker.fail("Extension rechargée : actualise la page.");
    return;
  }
  if (!res.ok) {
    console.warn("[lkclean]", res.error);
    sticker.fail(res.error);
    if (/Clé API|Jev 40[13]/.test(res.error)) apiBroken = true;
    return;
  }
  console.debug("[lkclean] verdict", post.author.slice(0, 40), res.verdict);
  sticker.settle(post.author, res.verdict, res.meta, verdictLabel(res.verdict));
  if (!el.isConnected) return;
  if (res.verdict.hide) hidePost(el, res.verdict);
  else noteKept(el, res.verdict);
}

// ---------- relance du scroll infini ----------

// LinkedIn charge la suite quand un marqueur en bas du fil *entre* dans l'écran. Si on masque
// presque tout, le fil devient si court que le marqueur ne quitte plus l'écran : plus aucun
// événement, le fil se fige. On le pousse donc brièvement hors champ (grande marge sous le
// dernier post, invisible car sous le contenu) puis on le laisse revenir.
const PUSH_ATTR = "data-lkclean-push";
const KICK_IDLE_MS = 1500;
const MAX_KICKS = 8;
let lastArrival = Date.now();
let kicks = 0;

function lastPost(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-lkclean-processed]`);
  return all[all.length - 1] ?? null;
}

function kickInfiniteScroll(): void {
  if (document.hidden || running > 0 || queue.length > 0) return;
  if (!document.querySelector(`[${HIDDEN_ATTR}]`)) return; // on n'a rien raccourci : pas notre problème
  if (Date.now() - lastArrival < KICK_IDLE_MS * (1 + kicks) || kicks >= MAX_KICKS) return;
  const last = lastPost();
  if (!last || last.getBoundingClientRect().bottom > window.innerHeight * 1.5) return;

  kicks++;
  lastArrival = Date.now();
  last.setAttribute(PUSH_ATTR, "");
  setTimeout(() => {
    last.removeAttribute(PUSH_ATTR);
    // Pour les chargeurs basés sur la position de scroll plutôt que sur un marqueur.
    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
  }, 250);
}

// ---------- observation du feed ----------

function scan(root: ParentNode): void {
  for (const sel of POST_SELECTORS) {
    root.querySelectorAll<HTMLElement>(sel).forEach(enqueue);
  }
}

function isPost(el: Element): boolean {
  return POST_SELECTORS.some((s) => el.matches(s));
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (isPost(node)) enqueue(node);
      else {
        scan(node);
        // Contenu ajouté à l'intérieur d'un post déjà vu mais encore vide.
        const parent = node.closest<HTMLElement>(ANY_POST);
        if (parent) enqueue(parent);
      }
    }
  }
});

// Si rien n'est détecté sur le fil, on logue la structure de la page (attributs seulement,
// aucun contenu) pour pouvoir réajuster les sélecteurs.
function diagnose(): void {
  if (seen > 0 || !location.pathname.startsWith("/feed")) return;
  const tally = (attr: string) => {
    const m = new Map<string, number>();
    for (const e of document.querySelectorAll(`[${attr}]`)) {
      const k = (e.getAttribute(attr) ?? "").replace(/\d{6,}/g, "N").slice(0, 80);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 40);
  };
  const KEEP = ["data-view-name", "data-testid", "role", "componentkey", "data-id", "data-urn"];
  const outline = (el: Element, d: number, out: string[]): string[] => {
    const a = KEEP.filter((k) => el.hasAttribute(k)).map((k) => `${k}=${(el.getAttribute(k) ?? "").replace(/\d{6,}/g, "N").slice(0, 70)}`);
    if (a.length) out.push(`${"  ".repeat(Math.min(d, 12))}<${el.tagName.toLowerCase()}> ${a.join(" ")} [txt:${(el as HTMLElement).innerText?.length ?? 0}]`);
    if (out.length < 60) for (const c of el.children) outline(c, d + (a.length ? 1 : 0), out);
    return out;
  };
  const main = document.querySelector("main") ?? document.body;
  // Candidat : le plus petit ancêtre commun « raisonnable » d'un gros bloc de texte du fil.
  const big = [...main.querySelectorAll<HTMLElement>("p, span[dir], div[dir]")].find((e) => e.innerText.length > 200);
  let post: Element | null = big ?? null;
  for (let i = 0; post && i < 12 && post.parentElement && post.parentElement !== main; i++) {
    if (post.parentElement.children.length > 3 && (post as HTMLElement).innerText.length > 300) break;
    post = post.parentElement;
  }
  const report = {
    viewNames: tally("data-view-name"),
    testIds: tally("data-testid"),
    roles: tally("role"),
    componentKeys: tally("componentkey").slice(0, 15),
    firstPost: post ? outline(post, 0, []) : "aucun candidat",
  };
  console.warn("[lkclean] DIAGNOSTIC — aucun post détecté, copie ce bloc :\n" + JSON.stringify(report, null, 1));
}

async function loadUi(): Promise<void> {
  try {
    const got = await chrome.runtime.sendMessage<Message, UiSettings>({ type: "getUiSettings" });
    if (got) ui = got;
  } catch {
    // service worker indisponible : on garde les valeurs par défaut
  }
  if (ui.enabled && ui.showSticker) sticker.mount();
  else sticker.unmount();
}

async function start(): Promise<void> {
  await loadUi();
  chrome.storage?.onChanged.addListener((_, area) => {
    if (area === "sync") void loadUi();
  });
  scan(document);
  observer.observe(document.body, { childList: true, subtree: true });
  console.info("[lkclean] actif");
  setTimeout(diagnose, 6000);
  setInterval(kickInfiniteScroll, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
} else {
  void start();
}
