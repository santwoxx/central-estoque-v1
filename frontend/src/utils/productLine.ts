// ─────────────────────────────────────────────────────────────────
// Linha do produto: Passeio, Carga, Agrícola/Industrial ou Acessórios
//
// O ERP não separa nada: pneu de carro, de caminhão, de trator, câmara de ar e
// roda de ferro saem todos na mesma lista, e a diferença só existe no texto
// ("PNEU 295/80 R22.5 TRA ...", "CAMARA DE AR 900-20"). Aqui a linha é
// DESCOBERTA pela medida e pela descrição, e o dono da loja pode corrigir na
// ficha do produto — a escolha dele (`line` no documento) sempre vence.
//
// Como a linha é calculada quando o campo não existe, nenhum produto antigo
// precisa ser regravado, e o produto que chega pelo relatório do ERP já entra
// na aba certa.
//
// Este arquivo não importa nada de propósito: é testado direto com os dados das
// lojas, fora do navegador.
// ─────────────────────────────────────────────────────────────────

export type ProductLine = "PASSEIO" | "CARGA" | "AGRO" | "ACESSORIO";
export type LineFilter = "ALL" | ProductLine;

export const PRODUCT_LINES: ReadonlyArray<{ id: ProductLine; label: string; hint: string }> = [
  { id: "PASSEIO", label: "Passeio", hint: "Carro, SUV e camionete" },
  // Pneu tipo C (de van e utilitário) é carga — decisão da loja em 25/11/2026.
  { id: "CARGA", label: "Carga", hint: "Caminhão, ônibus e van (pneu tipo C)" },
  { id: "AGRO", label: "Agrícola e Industrial", hint: "Trator, implemento, máquina, empilhadeira e quadriciclo" },
  { id: "ACESSORIO", label: "Acessórios", hint: "Câmara de ar, protetor, roda e válvula" }
];

export function isProductLine(value: unknown): value is ProductLine {
  return value === "PASSEIO" || value === "CARGA" || value === "AGRO" || value === "ACESSORIO";
}

export function lineLabel(line: ProductLine): string {
  return PRODUCT_LINES.find(l => l.id === line)?.label || line;
}

type LineSource = { line?: string; size?: string; brand?: string; model?: string; description?: string };

const norm = (s?: string) =>
  (s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/,/g, ".").replace(/\s+/g, " ").trim();

// O produto É o acessório: a palavra abre a descrição (como a loja e o ERP
// escrevem) ou é a "marca" que o script do ERP grava para separar a categoria.
const ACCESSORY_START = /^(CAMARA|PROTETOR|RODA|VALVULA|LONA|BICO|COLARINHO)\b/;
const ACCESSORY_BRANDS = new Set(["CAMARA DE AR", "CAMARA", "PROTETOR", "RODA", "VALVULA", "LONA"]);

const AGRO_WORDS =
  /\b(AGRICOLA|TRATOR|IMPLEMENTO|COLHEITADEIRA|EMPILHADEIRA|INDUSTRIAL|INDUST|OTR|QUADRICICLO|ATV|RETROESCAVADEIRA|MOTONIVELADORA|CARREGADEIRA)\b/;
// Carcaça e recapado são do mundo do caminhão ("Z CARCAÇA 295 XBRI ...").
const CARGA_WORDS = /\b(CAMINHAO|ONIBUS|CARGA|CARCACA|RECAPADO|RECAPAGEM|RECAUCHUTADO|RESSOLADO)\b/;

// Van e utilitário: a loja nem sempre escreve o "C" na medida ("225/75 R16
// ZMAX VANMEJOR C30"), mas o nome da linha do pneu entrega. A lona (8PR, 10PR)
// NÃO serve de pista: pneu A/T de camionete também é 10PR. Pneu de camionete
// tem "LT" na medida ("LT265/75 R16", "31X10.50 R15LT") e continua em Passeio.
const VAN_MODELS = /\b(VAN|VANCO|VANCONTACT|VANCAP|VANMAX|VANMEJOR|EUROVAN|EURV2|CARGO|SU-?\s?810)\b/;
const LIGHT_TRUCK = /\bLT\s?\d|\bLT\b|R\d{2}LT\b/;

// Lê a linha numa medida que COMEÇA no texto recebido. Devolve null quando o
// texto não começa por uma medida que diga a linha (o pneu de passeio comum).
function lineFromSize(text: string): ProductLine | null {
  const s = text;
  if (!s) return null;

  // Protetor e roda são cadastrados pelo aro ("ARO 16", "ARO 17.5").
  if (/^ARO\b/.test(s)) return "ACESSORIO";

  // Agrícola: largura com UMA casa decimal (12.4-24, 18.4-30, 19.5L-24,
  // 17.5-25), implemento (12.5/80-18, 10.0/75-15.3) e quadriciclo/empilhadeira
  // em polegada (24X8-12, 28X9-15). Caminhão convencional usa DUAS casas
  // (10.00-20) — é essa diferença que separa um do outro.
  if (/^\d{1,2}\.\d\s*\/\s*\d{2}/.test(s)) return "AGRO";
  if (/^\d{2}\s*X\s*\d+(?:\.\d+)?\s*-\s*\d{1,2}\b/.test(s)) return "AGRO";
  if (/^\d{1,2}\.\dL?\s*-\s*\d{2}(?![\d.])/.test(s)) return "AGRO";

  // Caminhão e ônibus radial: aro 17.5, 19.5, 22.5 ou 24.5 ("295/80 R22.5",
  // "215/75R17.5", "11 R22.5", "8.5R17.5").
  if (/^\d{1,3}(?:\.\d{1,2})?(?:\/\d{2})?\s*R\s?(?:17|19|22|24)\.5\b/.test(s)) return "CARGA";
  // 10-16.5, 14-17.5, 15-19.5: minicarregadeira e implemento (polegada com hífen).
  if (/^\d{1,2}\s*-\s*(?:16|17|19)\.5\b/.test(s)) return "AGRO";

  // Convencional em polegada: 750-16, 900-20, 1000-20, 10.00 R20, 1100-22,
  // 1300 24, 6.50-10. O código de três/quatro dígitos só vale de 500 para cima
  // — abaixo disso é largura em milímetro de pneu de passeio (175/70).
  const bias = s.match(/^(\d{1,2}\.\d{2}|\d{3,4})\s*(?:-|X|\/|R|\s)\s*(\d{1,2}(?:\.\d)?)(?![\d.])/);
  if (bias) {
    const width = bias[1].includes(".") ? parseFloat(bias[1]) : parseFloat(bias[1]) / 100;
    const rim = parseFloat(bias[2]);
    if (width >= 5) {
      if (rim <= 15) return "AGRO";   // 6.50-10, 7.00-12, 8.25-15: empilhadeira e máquina
      if (width >= 13) return "AGRO"; // 1300-24, 1400-24: motoniveladora
      return "CARGA";                 // 7.50-16, 9.00-20, 10.00-20, 11.00-22, 12.00-24
    }
  }

  // Pneu tipo C (comercial): "205/75 R16C", "195 R14C", "225/70 R15 C".
  if (/^\d{3}(?:\/\d{2})?\s?R\s?\d{2}(?:\.\d)?\s?C\b/.test(s)) return "CARGA";

  return null;
}

// A medida pode estar no campo próprio ou no meio da descrição ("PNEU COMUM
// 900-20 TRA ANTEO"): tenta o campo e, se ele não disser nada, cada palavra da
// descrição como começo de uma medida.
function lineFromText(size: string, description: string): ProductLine | null {
  const fromSize = lineFromSize(size);
  if (fromSize) return fromSize;
  const words = description.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (!/^\d/.test(words[i]) && words[i] !== "ARO") continue;
    const found = lineFromSize(words.slice(i).join(" "));
    if (found) return found;
  }
  return null;
}

export function detectProductLine(item: LineSource): ProductLine {
  const size = norm(item.size);
  const brand = norm(item.brand);
  const model = norm(item.model);
  const description = norm(item.description);

  if (
    ACCESSORY_BRANDS.has(brand) ||
    ACCESSORY_START.test(description) ||
    ACCESSORY_START.test(brand) ||
    /^ARO\b/.test(size)
  ) {
    return "ACESSORIO";
  }

  const all = `${size} ${brand} ${model} ${description}`;
  if (AGRO_WORDS.test(all)) return "AGRO";

  const bySize = lineFromText(size, description);
  if (bySize) return bySize;

  if (CARGA_WORDS.test(all)) return "CARGA";
  if (!LIGHT_TRUCK.test(all) && VAN_MODELS.test(`${model} ${description}`)) return "CARGA";
  return "PASSEIO";
}

// A linha que vale para o produto: a escolhida na ficha, ou a descoberta.
// O resultado fica guardado por objeto: as listas recalculam a linha a cada
// filtro, e o documento só muda quando o estoque chega de novo do banco.
const cache = new WeakMap<object, ProductLine>();

export function productLineOf(item: LineSource): ProductLine {
  if (isProductLine(item.line)) return item.line;
  const hit = cache.get(item);
  if (hit) return hit;
  const line = detectProductLine(item);
  cache.set(item, line);
  return line;
}

// Contagem por linha para as abas, a partir da lista que a tela já filtrou
// por busca/loja (a aba mostra quantos tem DENTRO do que está sendo visto).
export function countByLine<T>(list: T[], lineOf: (item: T) => ProductLine): Record<LineFilter, number> {
  const counts: Record<LineFilter, number> = { ALL: list.length, PASSEIO: 0, CARGA: 0, AGRO: 0, ACESSORIO: 0 };
  for (const item of list) counts[lineOf(item)] += 1;
  return counts;
}
