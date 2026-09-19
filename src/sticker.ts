import type { CallMeta, Verdict } from "./types";

// Pastille flottante « activité Jev ». Vit dans un Shadow DOM accroché à <html> :
// hors de l'arbre React de LinkedIn et à l'abri de son CSS.

/** Jev 1.13 : 0,042 $ par million de tokens en entrée, sortie gratuite. */
const USD_PER_TOKEN = 0.042 / 1_000_000;
const SPARK_MAX = 32;
const RECENT_MAX = 5;

interface Recent {
  author: string;
  label: string;
  hidden: boolean;
}

const stats = {
  inflight: 0,
  analysed: 0,
  hidden: 0,
  cacheHits: 0,
  calls: 0,
  tokens: 0,
  msTotal: 0,
  model: "",
  error: "",
  spark: [] as { ms: number; hidden: boolean }[],
  recent: [] as Recent[],
};

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let open = false;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
  font: 500 12.5px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e9edf2; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  font-variant-numeric: tabular-nums;
}
.pill {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 9px;
  padding: 7px 13px 7px 9px; border-radius: 999px;
  background: #12171d; color: #e9edf2; font: inherit;
  box-shadow: 0 0 0 1px #ffffff1f inset, 0 6px 20px #0006;
  transform: rotate(-1.5deg); transition: transform .18s ease;
}
.pill:hover { transform: rotate(0deg) scale(1.03); }
.pill:focus-visible { outline: 2px solid #7fd4c1; outline-offset: 2px; }
.orb { position: relative; width: 18px; height: 18px; flex: none; }
.orb i, .orb b { position: absolute; inset: 0; border-radius: 50%; }
.orb i { background: radial-gradient(circle at 35% 30%, #c8fff1, #38c6a4 55%, #107a63); animation: breathe 3.2s ease-in-out infinite; }
.orb b { border: 2px solid #38c6a4; opacity: 0; }
.busy .orb i { animation: none; }
.busy .orb b { animation: ripple 1s ease-out infinite; }
.error .orb i { background: radial-gradient(circle at 35% 30%, #ffd5cf, #e0533f 55%, #8a2416); animation: none; }
.name { font-weight: 700; letter-spacing: .02em; }
.sep { opacity: .35; }
.muted { color: #9aa6b2; }
.panel {
  width: 264px; padding: 14px; border-radius: 14px; background: #12171d;
  box-shadow: 0 0 0 1px #ffffff1f inset, 0 12px 32px #0008;
}
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.head strong { font-size: 13.5px; }
.grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px 8px; margin-bottom: 12px; }
.stat span { display: block; color: #9aa6b2; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
.stat b { font-size: 14px; font-weight: 650; white-space: nowrap; }
.spark { display: flex; align-items: flex-end; gap: 2px; height: 30px; margin-bottom: 12px; }
.spark i { flex: 1; max-width: 8px; min-height: 2px; border-radius: 2px 2px 0 0; background: #4b5763; }
.spark i.h { background: #38c6a4; }
.spark:empty::after { content: "en attente du premier appel…"; color: #6f7b87; font-size: 11.5px; align-self: center; }
.recent { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 4px; }
.recent li { display: flex; gap: 8px; justify-content: space-between; }
.recent li span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recent li span:last-child { flex: none; color: #9aa6b2; }
.recent li.h span:last-child { color: #7fd4c1; }
.err { color: #ff9d8f; margin: 0 0 10px; overflow-wrap: anywhere; }
.err:empty { display: none; }
.link { all: unset; cursor: pointer; color: #9aa6b2; text-decoration: underline; text-underline-offset: 2px; }
.link:hover, .link:focus-visible { color: #e9edf2; }
.bump { animation: bump .3s ease; display: inline-block; }
@keyframes ripple { from { transform: scale(1); opacity: .8; } to { transform: scale(2.1); opacity: 0; } }
@keyframes breathe { 50% { transform: scale(.82); opacity: .75; } }
@keyframes bump { 40% { transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .orb i, .orb b, .bump, .pill { animation: none !important; transition: none; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const refs: Record<string, HTMLElement> = {};

function build(): void {
  host = el("div");
  host.id = "lkclean-sticker";
  root = host.attachShadow({ mode: "open" });
  const style = el("style");
  style.textContent = CSS;

  const wrap = el("div", "wrap");
  const panel = el("div", "panel");
  panel.hidden = true;
  panel.id = "panel";

  const head = el("div", "head");
  head.append(el("strong", "", "Activité Jev"), (refs.model = el("span", "muted")));

  const grid = el("div", "grid");
  for (const [key, label] of [
    ["analysed", "Analysés"],
    ["hidden", "Masqués"],
    ["inflight", "En cours"],
    ["tokens", "Tokens"],
    ["cost", "Coût"],
    ["latency", "Latence"],
  ] as const) {
    const s = el("div", "stat");
    s.append(el("span", "", label), (refs[key] = el("b", "", "0")));
    grid.append(s);
  }

  refs.spark = el("div", "spark");
  refs.spark.title = "Latence des derniers appels (vert = post masqué)";
  refs.recent = el("ul", "recent");
  refs.err = el("p", "err");
  const opts = el("button", "link", "Réglages");
  opts.type = "button";
  opts.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "openOptions" }));
  panel.append(head, grid, refs.spark, refs.recent, refs.err, opts);

  const pill = el("button", "pill");
  pill.type = "button";
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute("aria-controls", "panel");
  const orb = el("span", "orb");
  orb.append(el("i"), el("b"));
  pill.append(orb, el("span", "name", "Jev"), el("span", "sep", "·"), (refs.summary = el("span")));
  pill.addEventListener("click", () => {
    open = !open;
    panel.hidden = !open;
    pill.setAttribute("aria-expanded", String(open));
  });

  refs.wrap = wrap;
  wrap.append(panel, pill);
  root.append(style, wrap);
}

function setText(node: HTMLElement | undefined, text: string, bump = false): void {
  if (!node || node.textContent === text) return;
  node.textContent = text;
  if (bump) {
    node.classList.remove("bump");
    void node.offsetWidth; // relance l'animation
    node.classList.add("bump");
  }
}

function render(): void {
  if (!root) return;
  const s = stats;
  refs.wrap?.classList.toggle("busy", s.inflight > 0);
  refs.wrap?.classList.toggle("error", s.error !== "");

  const share = s.analysed ? ` (${Math.round((s.hidden / s.analysed) * 100)} %)` : "";
  setText(refs.summary, s.error ? "en panne" : `${s.analysed} lus · ${s.hidden} masqués`, true);
  setText(refs.analysed, String(s.analysed));
  setText(refs.hidden, `${s.hidden}${share}`);
  setText(refs.inflight, String(s.inflight));
  setText(refs.tokens, s.tokens >= 10_000 ? `${(s.tokens / 1000).toFixed(1)}k` : String(s.tokens));
  setText(refs.cost, `${(s.tokens * USD_PER_TOKEN).toFixed(4).replace(".", ",")} $`);
  setText(refs.latency, s.calls ? `${Math.round(s.msTotal / s.calls)} ms` : "—");
  setText(refs.model, s.model);
  setText(refs.err, s.error);
  if (refs.cost) refs.cost.title = `${s.calls} appels · ${s.cacheHits} verdicts servis par le cache`;

  if (refs.spark) {
    const max = Math.max(1, ...s.spark.map((p) => p.ms));
    refs.spark.replaceChildren(
      ...s.spark.map((p) => {
        const bar = el("i", p.hidden ? "h" : "");
        bar.style.height = `${Math.max(7, (p.ms / max) * 100)}%`;
        return bar;
      }),
    );
  }
  refs.recent?.replaceChildren(
    ...s.recent.map((r) => {
      const li = el("li", r.hidden ? "h" : "");
      li.append(el("span", "", r.author || "Post"), el("span", "", r.label));
      return li;
    }),
  );
}

export const sticker = {
  mount(): void {
    if (!host) build();
    if (host && !host.isConnected) document.documentElement.append(host);
    render();
  },
  unmount(): void {
    host?.remove();
  },
  start(): void {
    stats.inflight++;
    render();
  },
  /** Fin d'un passage, qu'il y ait eu appel à Jev ou non. */
  settle(author: string, verdict: Verdict, meta: CallMeta, label: string): void {
    stats.inflight = Math.max(0, stats.inflight - 1);
    stats.error = "";
    if (meta.evaluated || verdict.hide) {
      stats.analysed++;
      if (verdict.hide) stats.hidden++;
      stats.recent = [{ author, label, hidden: verdict.hide }, ...stats.recent].slice(0, RECENT_MAX);
    }
    if (meta.cached) stats.cacheHits++;
    if (meta.evaluated && !meta.cached) {
      stats.calls++;
      stats.tokens += meta.inputTokens;
      stats.msTotal += meta.ms;
      stats.spark = [...stats.spark, { ms: meta.ms, hidden: verdict.hide }].slice(-SPARK_MAX);
      if (meta.model) stats.model = meta.model;
    }
    render();
  },
  fail(message: string): void {
    stats.inflight = Math.max(0, stats.inflight - 1);
    stats.error = message;
    render();
  },
};
