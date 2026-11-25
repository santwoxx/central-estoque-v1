// ─────────────────────────────────────────────────────────────────
// Ficha técnica do pneu: posição, lonas, índice de carga, câmara e DOT
//
// O que o frotista pergunta antes do preço: o pneu é de direção ou de tração,
// quantas lonas, se leva câmara, e de quando é (DOT). No ERP isso só existe
// escrito na descrição ("295/80 R22.5 DIR DURABLE DR266", "18PR 143/141") e o
// DOT vai no campo de observação. Aqui cada informação tem campo próprio na
// ficha, e enquanto o dono não preenche, o sistema LÊ da descrição — o mesmo
// esquema da linha do produto (utils/productLine.ts): o que foi escolhido na
// ficha sempre vence o que foi lido.
//
// Este arquivo não importa nada de propósito: é testado direto com os dados
// das lojas, fora do navegador.
// ─────────────────────────────────────────────────────────────────

export type TruckPosition = "DIRECIONAL" | "TRACAO" | "LIVRE" | "MISTO";
export type TubeType = "SEM_CAMARA" | "COM_CAMARA";
export type Construction = "RADIAL" | "CONVENCIONAL";

export const TRUCK_POSITIONS: ReadonlyArray<{ id: TruckPosition; label: string; short: string; hint: string }> = [
  { id: "DIRECIONAL", label: "Direcional", short: "DIR", hint: "Eixo dianteiro, de direção (pneu liso)" },
  { id: "TRACAO", label: "Tração", short: "TRA", hint: "Eixo de tração (pneu borrachudo)" },
  { id: "LIVRE", label: "Livre rolagem", short: "LIVRE", hint: "Carreta, reboque e eixo livre" },
  { id: "MISTO", label: "Misto", short: "MISTO", hint: "Uso misto (asfalto e terra) ou todas as posições" }
];

export const TUBE_TYPES: ReadonlyArray<{ id: TubeType; label: string }> = [
  { id: "SEM_CAMARA", label: "Sem câmara" },
  { id: "COM_CAMARA", label: "Com câmara" }
];

export function isTruckPosition(value: unknown): value is TruckPosition {
  return value === "DIRECIONAL" || value === "TRACAO" || value === "LIVRE" || value === "MISTO";
}

export function isTubeType(value: unknown): value is TubeType {
  return value === "SEM_CAMARA" || value === "COM_CAMARA";
}

export function positionLabel(position: TruckPosition): string {
  return TRUCK_POSITIONS.find(p => p.id === position)?.label || position;
}

const norm = (s?: string) =>
  (s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/,/g, ".").replace(/\s+/g, " ").trim();

// ── Posição ────────────────────────────────────────────────────────
// Como as lojas escrevem: "DIR", "DIRECIONAL", "DIRECI" (cortado pelo ERP),
// "LISO"; "TRA", "TRACAO", "BORRACHUDO", "DRIVE" (Pirelli "Itineris Drive");
// "MISTO", "MIX"; "CARRETA", "LIVRE". Vale a PRIMEIRA palavra que aparece.
const POSITION_WORDS: { position: TruckPosition; rx: RegExp }[] = [
  { position: "DIRECIONAL", rx: /\b(?:DIRECIONAL|DIRECIONA|DIRECION|DIRECIO|DIRECI|DIREC|DIR|LISO|STEER)\b|\bDI$/g },
  { position: "TRACAO", rx: /\b(?:TRACAO|TRACA|TRAC|TRA|BORRACHUDO|DRIVE|TRACTION)\b/g },
  { position: "LIVRE", rx: /\b(?:LIVRE|CARRETA|REBOQUE|TRAILER|TRL)\b/g },
  { position: "MISTO", rx: /\b(?:MISTO|MISTA|MIX|ON\/OFF)\b/g }
];

export function detectTruckPosition(text: string, brand?: string): TruckPosition | null {
  // "DRIVE FORCE" é MARCA e "DRIVE MAX"/"DRIVEMAX" é linha de pneu de van e de
  // carro (Speedmax) — nenhum dos dois é pneu de tração.
  let t = norm(text);
  if (norm(brand) === "DRIVE FORCE" || /\bDRIVE FORCE\b/.test(t)) t = t.replace(/\bDRIVE FORCE\b/g, " ");
  t = t.replace(/\bDRIVE\s?MAX\w*/g, " ");
  let best: { position: TruckPosition; at: number } | null = null;
  for (const { position, rx } of POSITION_WORDS) {
    rx.lastIndex = 0;
    const m = rx.exec(t);
    if (m && (!best || m.index < best.at)) best = { position, at: m.index };
  }
  return best ? best.position : null;
}

// ── Onde a posição faz sentido ─────────────────────────────────────
// Direcional/tração é conversa de caminhão e ônibus: aro 17.5, 19.5, 22.5,
// convencional (750-16, 900-20, 1000-20) e radial em polegada (1000R20).
// Pneu de van (tipo C) é Carga, mas não tem posição — sem esta separação, o
// filtro "Sem posição" encheria de pneu de van a lista do que falta completar.
function heavyTruckSize(text: string): boolean {
  const s = norm(text);
  if (!s) return false;
  if (/^\d{1,3}(?:\.\d{1,2})?(?:\/\d{2})?\s*R\s?(?:17|19|22|24)\.5\b/.test(s)) return true;
  if (/^(?:\d{1,2}(?:\.\d{2})?|\d{4})\s?R\s?(?:20|22|24)\b/.test(s)) return true;
  const bias = s.match(/^(\d{1,2}\.\d{2}|\d{3,4})\s*(?:-|\/|X|\s)\s*(\d{2}(?:\.\d)?)(?![\d.])/);
  if (bias) {
    const width = bias[1].includes(".") ? parseFloat(bias[1]) : parseFloat(bias[1]) / 100;
    return width >= 5 && parseFloat(bias[2]) >= 16;
  }
  return false;
}

export function isHeavyTruckTire(item: { size?: string; description?: string }): boolean {
  if (heavyTruckSize(item.size || "")) return true;
  // Medida só na descrição ("750/16LT 122/118K DIR CHENGSAN", tamanho "—").
  const words = norm(item.description).split(" ");
  for (let i = 0; i < words.length; i++) {
    if (/^\d/.test(words[i]) && heavyTruckSize(words.slice(i).join(" "))) return true;
  }
  return false;
}

// ── Lonas e índice de carga ────────────────────────────────────────
export function detectPlyRating(text: string): number | null {
  const m = norm(text).match(/\b(\d{1,2})\s?(?:PR|LONAS)\b/);
  if (!m) return null;
  const ply = parseInt(m[1], 10);
  return ply >= 4 && ply <= 30 ? ply : null;
}

// "149/146L", "135/133J", "106/104R", "143/141". Os dois números com três
// dígitos: é o que separa o índice de uma medida ("275/80").
export function detectLoadIndex(text: string): string | null {
  const m = norm(text).match(/\b(\d{3}\/\d{3}[A-Z]?)(?![\w./])/);
  return m ? m[1] : null;
}

// ── Construção e câmara ────────────────────────────────────────────
// Radial tem "R" entre a largura e o aro ("295/80 R22.5", "1000R20");
// convencional é a medida em polegada com hífen ("1000-20", "900/20").
export function detectConstruction(size: string): Construction | null {
  const s = norm(size);
  if (!s) return null;
  if (/\d\s?Z?R\s?\d{2}/.test(s)) return "RADIAL";
  if (/^(?:\d{1,2}\.\d{2}|\d{3,4})\s*(?:-|\/|X|\s)\s*\d{2}(?:\.\d)?(?![\d.])/.test(s)) return "CONVENCIONAL";
  return null;
}

// Aro "meio" (17.5, 19.5, 22.5) é sempre sem câmara; convencional de
// caminhão e o radial em polegada de aro inteiro (1000R20, 11.00 R22) levam
// câmara e protetor. "TT"/"TL" escritos na descrição mandam.
export function detectTubeType(size: string, text: string): TubeType | null {
  const t = norm(text);
  if (/\bTT\b/.test(t)) return "COM_CAMARA";
  if (/\bTL\b/.test(t)) return "SEM_CAMARA";
  const s = norm(size);
  if (!s) return null;
  if (/R\s?\d{2}\.5\b/.test(s)) return "SEM_CAMARA";
  if (/^\d{3}(?:\/\d{2})?\s?R\s?\d{2}\s?C\b/.test(s)) return "SEM_CAMARA";
  if (detectConstruction(s) === "CONVENCIONAL") return "COM_CAMARA";
  if (/^(?:\d{1,2}(?:\.\d{2})?|\d{4})\s?R\s?(?:20|22|24)\b/.test(s)) return "COM_CAMARA";
  return null;
}

// ── DOT (semana e ano de fabricação) ───────────────────────────────
// Os quatro últimos números do DOT na lateral: "2125" = semana 21 de 2025.
// O campo aceita vários lotes ("2125, 3424"), com ou sem a palavra DOT e com
// barra ou hífen ("21/25").
export type DotParse = { codes: string[]; invalid: string[] };

function dotIsValid(code: string, now: Date): boolean {
  const week = parseInt(code.slice(0, 2), 10);
  const year = 2000 + parseInt(code.slice(2), 10);
  if (week < 1 || week > 53) return false;
  const nowYear = now.getFullYear();
  if (year > nowYear) return false;
  if (year === nowYear && week > isoWeek(now) + 1) return false;
  return year >= 2000;
}

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function parseDotInput(input: string, now: Date = new Date()): DotParse {
  const codes: string[] = [];
  const invalid: string[] = [];
  // Sem o `norm` das medidas: ele troca vírgula por ponto, e aqui a vírgula
  // separa um lote do outro ("2125, 3424").
  const parts = (input || "")
    .toUpperCase()
    .replace(/\bDOT\b/g, " ")
    .split(/[;,.\s]+/)
    .filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    // "21/25" ou "21-25" → "2125"; "21 25" chega aqui separado e é juntado.
    const slash = p.match(/^(\d{1,2})[/-](\d{2})$/);
    if (slash) p = slash[1].padStart(2, "0") + slash[2];
    else if (/^\d{2}$/.test(p) && /^\d{2}$/.test(parts[i + 1] || "")) p = p + parts[++i];
    if (/^\d{4}$/.test(p) && dotIsValid(p, now)) {
      if (!codes.includes(p)) codes.push(p);
    } else {
      invalid.push(parts[i]);
    }
  }
  // Do mais antigo para o mais novo: é a ordem em que se vende.
  codes.sort((a, b) => dotSortKey(a) - dotSortKey(b));
  return { codes, invalid };
}

const dotSortKey = (code: string) => parseInt(code.slice(2), 10) * 100 + parseInt(code.slice(0, 2), 10);

// Data aproximada de fabricação (segunda-feira da semana do DOT).
export function dotDate(code: string): Date {
  const week = parseInt(code.slice(0, 2), 10);
  const year = 2000 + parseInt(code.slice(2), 10);
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  return monday;
}

export function dotAgeMonths(code: string, now: Date = new Date()): number {
  const d = dotDate(code);
  return Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()));
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

export function dotLabel(code: string): string {
  const d = dotDate(code);
  return `${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

export function dotAgeLabel(code: string, now: Date = new Date()): string {
  const months = dotAgeMonths(code, now);
  if (months < 1) return "fabricado este mês";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const y = years ? `${years} ano${years > 1 ? "s" : ""}` : "";
  const m = rest ? `${rest} ${rest > 1 ? "meses" : "mês"}` : "";
  return `há ${[y, m].filter(Boolean).join(" e ")}`;
}

// Idade que pede atenção: 3 anos (avisar antes de vender) e 5 anos (antigo —
// muito cliente recusa, e frota quase sempre).
export const DOT_WARN_MONTHS = 36;
export const DOT_OLD_MONTHS = 60;

// ── Ficha efetiva ──────────────────────────────────────────────────
type SpecSource = {
  size?: string;
  brand?: string;
  model?: string;
  description?: string;
  notes?: string;
  truckPosition?: string;
  plyRating?: number;
  loadIndex?: string;
  tubeType?: string;
  dot?: string[];
};

export type TireSpec = {
  position: TruckPosition | null;
  positionFromForm: boolean;
  ply: number | null;
  loadIndex: string | null;
  tube: TubeType | null;
  construction: Construction | null;
  // DOTs do campo próprio; sem ele, o "DOT 2125" escrito nas anotações.
  dots: string[];
  dotsFromNotes: boolean;
};

const cache = new WeakMap<object, TireSpec>();

export function tireSpecOf(item: SpecSource): TireSpec {
  const hit = cache.get(item);
  if (hit) return hit;
  const text = `${item.model || ""} ${item.description || ""}`;
  const explicitDots = Array.isArray(item.dot) ? item.dot.filter(c => /^\d{4}$/.test(c)) : [];
  let dots = explicitDots;
  let dotsFromNotes = false;
  if (!dots.length) {
    const fromNotes = [...norm(item.notes).matchAll(/\bDOT\s?:?\s?(\d{2}[/-]?\d{2})\b/g)].map(m => m[1]).join(", ");
    if (fromNotes) {
      dots = parseDotInput(fromNotes).codes;
      dotsFromNotes = dots.length > 0;
    }
  }
  const spec: TireSpec = {
    position: isTruckPosition(item.truckPosition) ? item.truckPosition : detectTruckPosition(text, item.brand),
    positionFromForm: isTruckPosition(item.truckPosition),
    ply: Number(item.plyRating) > 0 ? Number(item.plyRating) : detectPlyRating(text),
    loadIndex: (item.loadIndex || "").trim() ? norm(item.loadIndex) : detectLoadIndex(text),
    tube: isTubeType(item.tubeType) ? item.tubeType : detectTubeType(item.size || "", text),
    construction: detectConstruction(item.size || ""),
    dots,
    dotsFromNotes
  };
  cache.set(item, spec);
  return spec;
}
