import type { StockItem } from "../types";

// ─────────────────────────────────────────────────────────────────
// Valores que o pneu leva quando muda de loja
//
// A chegada de uma transferência criava o cadastro no destino com preço à
// vista, a prazo e custo ZERADOS (e sem a ficha técnica): o pneu chegava e não
// podia ser vendido pelo preço certo. Agora:
//   • cadastro NOVO no destino: leva os valores e a ficha do pneu de origem;
//   • cadastro que JÁ existe no destino: o que a loja de destino preencheu
//     continua valendo — só o que está vazio/zerado lá é completado.
// Fica de fora o que é de cada loja: promoção, estoque mínimo, fotos e saldo.
// ─────────────────────────────────────────────────────────────────

const VALUE_FIELDS = ["price", "priceCash", "priceInstallment", "costPrice"] as const;
const SPEC_FIELDS = ["line", "truckPosition", "plyRating", "loadIndex", "tubeType", "dot"] as const;

export const TRANSFER_NOTE_PREFIX = "Criado via transferência";

type Source = Partial<StockItem> | Record<string, unknown> | null | undefined;

const hasValue = (field: string, value: unknown): boolean => {
  if ((VALUE_FIELDS as readonly string[]).includes(field) || field === "plyRating") return Number(value) > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
};

const normalizedValue = (field: string, value: unknown): unknown => {
  if ((VALUE_FIELDS as readonly string[]).includes(field) || field === "plyRating") return Number(value);
  if (Array.isArray(value)) return [...value];
  return value;
};

// Campos do pneu de origem para um cadastro NOVO no destino (só o que tem
// valor — o Firestore recusa `undefined`).
export function transferredFields(source: Source): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  const data = source as Record<string, unknown>;
  for (const field of [...VALUE_FIELDS, ...SPEC_FIELDS]) {
    if (hasValue(field, data[field])) out[field] = normalizedValue(field, data[field]);
  }
  return out;
}

// Para um cadastro que já existe no destino: só o que está vazio lá e tem
// valor na origem.
export function missingTransferFields(destination: Source, source: Source): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  const dest = (destination || {}) as Record<string, unknown>;
  const from = transferredFields(source);
  for (const [field, value] of Object.entries(from)) {
    if (!hasValue(field, dest[field])) out[field] = value;
  }
  return out;
}

const sellingPrice = (item: Source) => {
  const data = (item || {}) as Record<string, unknown>;
  return Math.max(Number(data.priceCash) || 0, Number(data.price) || 0, Number(data.priceInstallment) || 0);
};

const normSize = (size: unknown) => String(size || "").replace(/\s+/g, "").toUpperCase();

// Pneu que chegou por transferência antes desta correção e ficou sem preço.
export function needsTransferRepair(item: StockItem): boolean {
  return String(item.notes || "").startsWith(TRANSFER_NOTE_PREFIX) && sellingPrice(item) === 0;
}

// O pneu de origem de um cadastro que chegou zerado: mesmo código, outra loja,
// mesma medida, com preço. Prefere a loja escrita na observação ("Criado via
// transferência de X") e, depois, o cadastro original (que não veio de outra
// transferência).
export function findTransferSource(item: StockItem, all: StockItem[]): StockItem | null {
  const fromName = String(item.notes || "").replace(/^Criado via transferência de\s*/i, "").trim().toLowerCase();
  const candidates = all.filter(
    other =>
      other.id !== item.id &&
      other.companyId !== item.companyId &&
      other.sku === item.sku &&
      normSize(other.size) === normSize(item.size) &&
      sellingPrice(other) > 0
  );
  if (candidates.length === 0) return null;
  const score = (other: StockItem) =>
    (String(other.companyName || "").trim().toLowerCase() === fromName ? 2 : 0) +
    (String(other.notes || "").startsWith(TRANSFER_NOTE_PREFIX) ? 0 : 1);
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}
