import { collection, deleteField, doc, onSnapshot, serverTimestamp, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import type { StockItem } from "../types";

// ─────────────────────────────────────────────────────────────────
// Custo fora do catálogo público
//
// A coleção `stock` é pública: o catálogo /consulta lê dela sem login. O custo
// (costPrice) ficava ali dentro, à vista de qualquer um que soubesse usar a
// API do Firebase. Agora ele mora em `stock_costs/{id}`, que só o
// administrador e os donos de loja leem (ver firestore.rules).
//
// Como funciona, sem mexer nos vários pontos que gravam custo:
//   • As telas continuam gravando `costPrice` no produto, como sempre.
//   • O navegador de quem cuida de loja (admin e donos) MOVE em seguida o custo
//     que aparecer no produto público: grava em stock_costs e apaga do produto
//     numa gravação só — as duas coisas acontecem, ou nenhuma.
//   • Na leitura vale o custo recém-digitado (ainda no produto); senão, o
//     guardado em stock_costs.
//   • Custo 0 é "não informado" (ver types.ts): um 0 no produto público só é
//     apagado, nunca sobrescreve o custo guardado. Por isso restaurar um
//     arquivo sem custo não apaga os custos protegidos.
//
// Enquanto a regra de stock_costs não estiver publicada no Firebase, a leitura
// falha ("permission-denied"): nada é movido e tudo segue como antes.
// ─────────────────────────────────────────────────────────────────

export const PRIVATE_COSTS_COLLECTION = "stock_costs";
// Produtos por gravação ao mover (2 operações cada; o limite é 500). Para o
// dono, a regra confere a loja de cada produto com um get(), e o Firebase
// aceita no máximo 20 documentos consultados por gravação em lote (medido no
// emulador: 17 passam, 19 não; 12 deixa folga).
export const MOVE_CHUNK_ADMIN = 50;
export const MOVE_CHUNK_OWNER = 12;
export const moveChunkFor = (user: StaffUser | null | undefined) => (user?.role === "admin" ? MOVE_CHUNK_ADMIN : MOVE_CHUNK_OWNER);
// Trava de segurança contra algum ponto do sistema que regrave o custo sem
// parar: no máximo 5 movimentos do mesmo produto a cada 10 minutos. (Editar a
// ficha regrava o custo no produto e ele é movido de novo — isso é normal.)
export const MAX_MOVES_PER_ITEM = 5;
export const MOVE_WINDOW_MS = 10 * 60_000;

export type PrivateCostsStatus = "off" | "loading" | "ok" | "unavailable";

// Produto que ainda tem o campo costPrice no documento público.
export interface PublicCostEntry {
  id: string;
  value: number;
  companyId: string;
}

type StaffUser = { role?: string; companyId?: string | null };

export const isCostStaff = (user: StaffUser | null | undefined) => user?.role === "admin" || user?.role === "alimentador";

// Custo recém-digitado (no produto) > custo guardado > o que veio (0).
export function withPrivateCosts(items: StockItem[], costs: Map<string, number>): StockItem[] {
  if (costs.size === 0) return items;
  return items.map(item => {
    if (Number(item.costPrice) > 0) return item;
    const saved = costs.get(item.id);
    return saved && saved > 0 ? { ...item, costPrice: saved } : item;
  });
}

// Lê do documento bruto do Firestore se o campo existe (mesmo valendo 0).
export function publicCostEntryOf(id: string, data: Record<string, unknown>): PublicCostEntry | null {
  if (!("costPrice" in data) || data.costPrice === undefined) return null;
  return { id, value: Number(data.costPrice) || 0, companyId: String(data.companyId || "") };
}

// O que este usuário pode mover, pelas regras de `stock`: o administrador,
// tudo; o dono, só a própria loja.
export function movableEntries(entries: PublicCostEntry[], user: StaffUser | null | undefined): PublicCostEntry[] {
  if (!user) return [];
  if (user.role === "admin") return entries;
  if (user.role === "alimentador" && user.companyId) return entries.filter(e => e.companyId === user.companyId);
  return [];
}

// Escolhe o próximo lote a mover e anota a tentativa em `history` (id → horários).
// Produto que já foi movido 5 vezes nos últimos 10 minutos espera.
export function nextMoveChunk(
  entries: PublicCostEntry[],
  user: StaffUser | null | undefined,
  history: Map<string, number[]>,
  now = Date.now()
): PublicCostEntry[] {
  const recent = (id: string) => (history.get(id) || []).filter(at => now - at < MOVE_WINDOW_MS);
  const pending = movableEntries(entries, user).filter(entry => recent(entry.id).length < MAX_MOVES_PER_ITEM);
  const chunk = pending.slice(0, moveChunkFor(user));
  for (const entry of chunk) history.set(entry.id, [...recent(entry.id), now]);
  return chunk;
}

// Lote recusado (produto apagado no meio do caminho, regra etc.): esses
// produtos esperam a janela de 10 minutos antes de tentar de novo.
export function holdAfterFailure(chunk: PublicCostEntry[], history: Map<string, number[]>, now = Date.now()) {
  for (const entry of chunk) history.set(entry.id, Array(MAX_MOVES_PER_ITEM).fill(now));
}

// Um lote: grava o custo em stock_costs (se for > 0) e apaga do produto.
// Não toca em updatedAt: a sincronização do ERP compara datas e não pode achar
// que o produto foi editado.
export async function movePublicCosts(entries: PublicCostEntry[], uid: string): Promise<void> {
  if (entries.length === 0) return;
  const batch = writeBatch(db);
  for (const entry of entries) {
    if (entry.value > 0) {
      batch.set(
        doc(db, PRIVATE_COSTS_COLLECTION, entry.id),
        { costPrice: entry.value, companyId: entry.companyId, updatedAt: serverTimestamp(), updatedBy: uid },
        { merge: true }
      );
    }
    batch.update(doc(db, "stock", entry.id), { costPrice: deleteField() });
  }
  await batch.commit();
}

export function subscribePrivateCosts(onData: (costs: Map<string, number>) => void, onError: (err: unknown) => void): () => void {
  return onSnapshot(
    collection(db, PRIVATE_COSTS_COLLECTION),
    snapshot => {
      const costs = new Map<string, number>();
      snapshot.forEach(docSnap => {
        const value = Number(docSnap.data().costPrice);
        if (value > 0) costs.set(docSnap.id, value);
      });
      onData(costs);
    },
    onError
  );
}

// Ao excluir produtos, apaga o custo guardado deles (melhor esforço: custo
// órfão não aparece em lugar nenhum, só ocupa espaço).
export async function deletePrivateCosts(ids: string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += 400) {
    const batch = writeBatch(db);
    ids.slice(start, start + 400).forEach(id => batch.delete(doc(db, PRIVATE_COSTS_COLLECTION, id)));
    await batch.commit();
  }
}
