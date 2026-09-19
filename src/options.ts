import { DEFAULT_SETTINGS, type Settings } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fields = {
  enabled: $<HTMLInputElement>("enabled"),
  apiKey: $<HTMLInputElement>("apiKey"),
  model: $<HTMLInputElement>("model"),
  interests: $<HTMLTextAreaElement>("interests"),
  blocked: $<HTMLTextAreaElement>("blocked"),
  noiseThreshold: $<HTMLInputElement>("noiseThreshold"),
  interestThreshold: $<HTMLInputElement>("interestThreshold"),
  hideSponsored: $<HTMLInputElement>("hideSponsored"),
  minChars: $<HTMLInputElement>("minChars"),
  showKeptReason: $<HTMLInputElement>("showKeptReason"),
  showSticker: $<HTMLInputElement>("showSticker"),
};
const noiseOut = $<HTMLOutputElement>("noiseOut");
const interestOut = $<HTMLOutputElement>("interestOut");
const status = $<HTMLSpanElement>("status");

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const pct = (v: string) => `${Math.round(Number(v) * 100)} %`;

function render(s: Settings): void {
  fields.enabled.checked = s.enabled;
  fields.apiKey.value = s.apiKey;
  fields.model.value = s.model;
  fields.interests.value = s.interests.join("\n");
  fields.blocked.value = s.blocked.join("\n");
  fields.noiseThreshold.value = String(s.noiseThreshold);
  fields.interestThreshold.value = String(s.interestThreshold);
  fields.hideSponsored.checked = s.hideSponsored;
  fields.minChars.value = String(s.minChars);
  fields.showKeptReason.checked = s.showKeptReason;
  fields.showSticker.checked = s.showSticker;
  noiseOut.value = pct(fields.noiseThreshold.value);
  interestOut.value = pct(fields.interestThreshold.value);
}

function read(): Settings {
  return {
    enabled: fields.enabled.checked,
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim() || DEFAULT_SETTINGS.model,
    interests: lines(fields.interests.value),
    blocked: lines(fields.blocked.value),
    noiseThreshold: Number(fields.noiseThreshold.value),
    interestThreshold: Number(fields.interestThreshold.value),
    hideSponsored: fields.hideSponsored.checked,
    minChars: Math.max(0, Number(fields.minChars.value) || 0),
    showKeptReason: fields.showKeptReason.checked,
    showSticker: fields.showSticker.checked,
  };
}

async function load(): Promise<void> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  render({ ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) });
}

async function save(): Promise<void> {
  await chrome.storage.sync.set(read());
  status.textContent = "Enregistré. Les nouveaux posts suivent ces réglages ; recharge LinkedIn pour réévaluer le fil.";
  setTimeout(() => (status.textContent = ""), 4000);
}

fields.noiseThreshold.addEventListener("input", () => (noiseOut.value = pct(fields.noiseThreshold.value)));
fields.interestThreshold.addEventListener("input", () => (interestOut.value = pct(fields.interestThreshold.value)));
$<HTMLButtonElement>("save").addEventListener("click", () => void save());
void load();
