// ─────────────────────────────────────────────────────────────────
// Sincronização do estoque de uma loja com o relatório do ERP
//
// O relatório do ERP é a FOTO do estoque da loja num instante ("14/10/2026
// 08:17"). Entre a foto e o clique em Sincronizar, o sistema pode ter
// registrado vendas, transferências e entradas daquela loja — gravar a foto
// por cima desfaria tudo isso: a venda das 10h voltaria para a prateleira.
//
// Por isso o saldo que fica é:
//
//     saldo do ERP na emissão  +  o que o sistema movimentou DEPOIS dela
//
// A mesma conta resolve, sem regra especial:
//   • produto que não veio no relatório (saldo 0 no ERP) mas recebeu uma
//     transferência depois → fica com a transferência, não zera;
//   • sincronizar de novo com o mesmo arquivo → nada muda, porque os ajustes
//     gravados pela própria sincronização (marcados com `erpSyncId`) ficam
//     fora da soma;
//   • gravação interrompida no meio → clicar de novo termina só o que faltou.
//
// Num produto que já existe, a sincronização mexe em SALDO e PREÇO (à vista e
// a prazo — quem define preço na loja é o ERP). Marca, modelo, medida,
// descrição, custo, foto e observações ficam como estão: podem ter sido
// corrigidos à mão no sistema, e o relatório não tem como saber.
//
// O que ela NÃO decide sozinha (vai para "Conferir" e fica como está):
//   • produto que não veio deste ERP (código sem o prefixo da loja): não há
//     como casar com o relatório;
//   • produto cadastrado no sistema DEPOIS da emissão (à mão ou por outro
//     caminho — não pela própria sincronização): a foto é anterior a ele, e o
//     cadastro em si não é movimentação física;
//   • zerar o que sumiu, quando o relatório não cobre a loja inteira.
//
// Reserva nunca é solta: se a conta der menos do que está preso por reserva
// de cliente, transferência ou pedido de baixa, o saldo para na reserva.
//
// Este arquivo só CALCULA — quem lê e grava no Firestore é o App
// (handleSyncStoreStock). Assim a prévia e a gravação usam a mesma conta.
// ─────────────────────────────────────────────────────────────────
import type {
  ErpStockFile,
  ErpStockFileItem,
  ErpStockReport,
  ErpSyncAction,
  ErpSyncMode,
  ErpSyncPreviewItem,
  ErpSyncResult
} from "../types";
import { mapStockDoc, reservedQuantityOf, toMillis } from "../utils";

// Aceita o formato novo ({ report, items }) e o antigo (a lista pura).
export function parseErpStockFile(raw: unknown): ErpStockFile {
  if (Array.isArray(raw)) return { report: null, items: raw as ErpStockFileItem[] };
  const obj = raw as { report?: ErpStockReport | null; items?: ErpStockFileItem[] } | null;
  if (obj && Array.isArray(obj.items)) return { report: obj.report || null, items: obj.items };
  return { report: null, items: [] };
}

// Hora de emissão do relatório em ms; 0 quando o arquivo não traz (arquivo
// antigo) ou traz uma data ilegível. Nos dois casos não há como separar o
// antes do depois, e a sincronização vira "só cadastrar o que falta".
export function erpReportMillis(report: ErpStockReport | null | undefined): number {
  const ms = report?.issuedAtISO ? Date.parse(report.issuedAtISO) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

// Produto da loja como a sincronização precisa enxergar — lido do SERVIDOR.
export interface ErpLiveDoc {
  id: string;
  sku: string;
  brand: string;
  model: string;
  size: string;
  description: string;
  quantity: number;
  reservedQuantity: number;
  priceCash: number;
  priceInstallment: number;
  createdAtMillis: number;
}

export function toErpLiveDoc(id: string, data: any): ErpLiveDoc {
  // mapStockDoc: os mesmos fallbacks de preço que o resto do sistema usa.
  const item = mapStockDoc(id, data || {});
  return {
    id,
    sku: item.sku,
    brand: item.brand,
    model: item.model,
    size: item.size,
    description: item.description || "",
    quantity: Number(item.quantity) || 0,
    reservedQuantity: reservedQuantityOf(item),
    priceCash: Number(item.priceCash) || 0,
    priceInstallment: Number(item.priceInstallment) || 0,
    createdAtMillis: toMillis(data?.createdAt)
  };
}

export interface ErpMovementAfterReport {
  stockItemId: string;
  sku: string;
  quantity: number;
}

// O que aconteceu na loja depois da emissão do relatório, lido dos documentos
// de `movements` dela:
//   • `movements` entram na soma. Os gravados pela própria sincronização
//     (marcados com `erpSyncId`) ficam de fora — é isso que torna rodar de
//     novo inofensivo.
//   • `syncCreatedIds`: produtos CADASTRADOS por uma sincronização depois da
//     emissão. Eles não caem na regra "cadastrado depois do relatório" — sem
//     isto, sincronizar de novo mandaria para "Conferir" todo produto novo que
//     a primeira rodada criou.
export interface ErpActivityAfterReport {
  movements: ErpMovementAfterReport[];
  syncCreatedIds: Set<string>;
}

export function collectActivityAfterReport(movementDocs: any[], reportMs: number): ErpActivityAfterReport {
  const activity: ErpActivityAfterReport = { movements: [], syncCreatedIds: new Set() };
  for (const data of movementDocs) {
    if (!data || toMillis(data.timestamp) <= reportMs) continue;
    if (data.erpSyncId) {
      if (data.type === "IMPORTACAO" && data.stockItemId) activity.syncCreatedIds.add(String(data.stockItemId));
      continue;
    }
    const quantity = Number(data.quantity) || 0;
    if (!quantity) continue;
    activity.movements.push({ stockItemId: String(data.stockItemId || ""), sku: String(data.sku || ""), quantity });
  }
  return activity;
}

// Linha do plano: o que a prévia mostra, mais o que a gravação precisa.
export interface ErpSyncPlanEntry extends ErpSyncPreviewItem {
  stockItemId?: string;            // ATUALIZAR / ZERAR: o documento a gravar
  reservedQuantity?: number;       // reserva lida no cálculo — a gravação confere
  fileItem?: ErpStockFileItem;     // CRIAR: o cadastro a gravar
}

export interface ErpSyncPlan {
  mode: ErpSyncMode;
  prefix: string;
  canZero: boolean;
  reportMs: number;
  entries: ErpSyncPlanEntry[];
  productsBefore: number;
  unitsBefore: number;
}

const skuKey = (sku: unknown) => String(sku ?? "").trim().toUpperCase();
const cents = (v: unknown) => Math.round((Number(v) || 0) * 100);
const textKey = (v: unknown) => String(v ?? "").toUpperCase().replace(/\s+/g, " ").trim();
const plain = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// O prefixo do código ("SAJ" em "SAJ-910"): diz quais produtos da loja vieram
// deste ERP. Arquivo antigo não traz o cabeçalho — vale o prefixo comum a
// todas as linhas, se houver um só.
function filePrefix(file: ErpStockFile): string {
  const fromReport = skuKey(file.report?.prefix);
  if (fromReport) return fromReport;
  const prefixes = new Set(file.items.map(i => skuKey(i.sku).split("-")[0]).filter(Boolean));
  return prefixes.size === 1 ? [...prefixes][0] : "";
}

function labelOf(x: { description?: string; size?: string; brand?: string; model?: string }): string {
  const desc = String(x.description || "").trim();
  if (desc) return desc;
  return [x.size, x.brand, x.model].filter(v => v && v !== "—").join(" ");
}

const signed = (n: number) => `${n > 0 ? "+" : "−"}${Math.abs(n)}`;

// O que pede atenção primeiro; "sem mudança" por último.
const ACTION_ORDER: Record<ErpSyncAction, number> = {
  ATUALIZAR: 0, ZERAR: 1, CRIAR: 2, CONFERIR: 3, IGNORAR: 4, SEM_MUDANCA: 5
};

export function planErpSync(
  file: ErpStockFile,
  live: ErpLiveDoc[],
  activity: ErpActivityAfterReport = { movements: [], syncCreatedIds: new Set() }
): ErpSyncPlan {
  const reportMs = erpReportMillis(file.report);
  const mode: ErpSyncMode = reportMs > 0 ? "SINCRONIZAR" : "SO_CADASTRAR";
  const prefix = filePrefix(file);
  const canZero = mode === "SINCRONIZAR" && !!file.report?.complete && !!prefix;
  const fromThisErp = (sku: string) => !!prefix && skuKey(sku).startsWith(`${prefix}-`);
  const issuedAt = file.report?.issuedAt || "";

  const bySku = new Map<string, ErpLiveDoc[]>();
  for (const d of live) {
    const k = skuKey(d.sku);
    if (k) bySku.set(k, [...(bySku.get(k) || []), d]);
  }

  // Movimentado depois do relatório, por produto. Movimento com o id do
  // documento casa pelo id; os antigos (sem stockItemId) casam pelo código.
  const movedById = new Map<string, number>();
  const movedBySku = new Map<string, number>();
  for (const m of activity.movements) {
    if (m.stockItemId) {
      movedById.set(m.stockItemId, (movedById.get(m.stockItemId) || 0) + m.quantity);
    } else {
      const k = skuKey(m.sku);
      if (k) movedBySku.set(k, (movedBySku.get(k) || 0) + m.quantity);
    }
  }
  const movedFor = (d: ErpLiveDoc) => (movedById.get(d.id) || 0) + (movedBySku.get(skuKey(d.sku)) || 0);

  // ── O mesmo pneu com dois códigos ─────────────────────────────────
  // Pular código repetido não protege do caso real da Central Autocar: a loja
  // carregada antes por outro caminho, com códigos inventados, e o relatório
  // trazendo os códigos do ERP. Para o sistema são produtos diferentes, e a
  // loja ficaria com o estoque em dobro. Não dá para casar sozinho (as
  // descrições vêm escritas de jeitos diferentes), então o produto novo que
  // tem a MESMA medida e marca de um cadastro de fora deste ERP é apontado.
  const twinsByPair = new Map<string, ErpLiveDoc[]>();
  for (const d of live) {
    if (fromThisErp(d.sku) || !plain(d.size)) continue;
    const pk = `${plain(d.size)}|${plain(d.brand)}`;
    twinsByPair.set(pk, [...(twinsByPair.get(pk) || []), d]);
  }

  const reconcile = (
    d: ErpLiveDoc,
    item: ErpStockFileItem | null,
    reportQuantity: number,
    filePrice: { cash: number; installment: number } | null
  ): ErpSyncPlanEntry => {
    const inReport = item !== null;
    const base = {
      sku: d.sku,
      label: labelOf(item || d),
      stockItemId: d.id,
      reservedQuantity: d.reservedQuantity,
      currentQuantity: d.quantity,
      reportQuantity: inReport ? reportQuantity : null,
      priceBefore: { cash: d.priceCash, installment: d.priceInstallment }
    };

    if (d.createdAtMillis > reportMs && !activity.syncCreatedIds.has(d.id)) {
      return {
        ...base,
        action: "CONFERIR",
        movedAfterReport: 0,
        targetQuantity: null,
        quantityChanged: false,
        priceChanged: false,
        notes: [
          `Cadastrado no sistema depois da emissão do relatório (${issuedAt}): a foto do ERP é anterior ` +
          `ao cadastro. Confira o saldo à mão.`
        ]
      };
    }

    const notes: string[] = [];
    const moved = movedFor(d);
    const erpNow = reportQuantity + moved;
    let target = Math.max(0, erpNow);

    if (!inReport) notes.push("Não está no relatório: saldo 0 no ERP.");
    if (moved !== 0) {
      notes.push(
        `${signed(moved)} un movimentadas no sistema depois do relatório, já somadas ` +
        `(ERP ${reportQuantity} ${signed(moved)} = ${erpNow}).`
      );
    }
    if (erpNow < 0) {
      notes.push("O sistema registrou mais saída depois do relatório do que o ERP tinha — o saldo para em 0.");
    }
    if (d.reservedQuantity > 0 && target < d.reservedQuantity) {
      notes.push(
        `${d.reservedQuantity} un presas por reserva, transferência ou pedido de baixa — ` +
        `o saldo para em ${d.reservedQuantity}.`
      );
      target = d.reservedQuantity;
    } else if (d.reservedQuantity > 0) {
      notes.push(
        `${d.reservedQuantity} un presas (reserva, transferência ou pedido de baixa). Se essa saída já ` +
        `foi lançada no ERP, ela não pode ser baixada de novo aqui.`
      );
    }

    let priceChanged = false;
    let priceAfter: { cash: number; installment: number } | undefined;
    if (filePrice) {
      // ERP sem preço não apaga o preço que o sistema já tem.
      const cash = filePrice.cash > 0 ? filePrice.cash : d.priceCash;
      const installment = filePrice.installment > 0 ? filePrice.installment : d.priceInstallment;
      if (filePrice.cash <= 0 && filePrice.installment <= 0 && (d.priceCash > 0 || d.priceInstallment > 0)) {
        notes.push("Sem preço no ERP — mantido o preço do sistema.");
      }
      priceChanged = cents(cash) !== cents(d.priceCash) || cents(installment) !== cents(d.priceInstallment);
      priceAfter = { cash, installment };
    }

    if (item?.description && d.description && textKey(item.description) !== textKey(d.description)) {
      notes.push(
        `No ERP a descrição agora é "${item.description}" — marca, modelo e medida do sistema foram mantidos.`
      );
    }

    const quantityChanged = target !== d.quantity;
    const action: ErpSyncAction = !quantityChanged && !priceChanged
      ? "SEM_MUDANCA"
      : !inReport && target === 0 ? "ZERAR" : "ATUALIZAR";

    return {
      ...base,
      action,
      movedAfterReport: moved,
      targetQuantity: target,
      quantityChanged,
      priceChanged,
      priceAfter,
      // Produto que já estava zerado e continua zerado não precisa de explicação.
      notes: action === "SEM_MUDANCA" && !inReport ? [] : notes
    };
  };

  const entries: ErpSyncPlanEntry[] = [];
  const seen = new Set<string>();

  for (const item of file.items) {
    const key = skuKey(item.sku);
    const reportQuantity = Math.max(0, Math.trunc(Number(item.quantity) || 0));
    const fileCash = Number(item.priceCash ?? item.price) || 0;
    const fileInstallment = Number(item.priceInstallment ?? item.price) || 0;
    const base = {
      sku: item.sku || "(sem código)",
      label: labelOf(item),
      reportQuantity,
      movedAfterReport: 0,
      quantityChanged: false,
      priceChanged: false
    };

    if (!key || seen.has(key)) {
      entries.push({
        ...base,
        action: "IGNORAR",
        currentQuantity: null,
        targetQuantity: null,
        notes: [key ? "Repetido no próprio arquivo — só a primeira linha foi usada." : "Linha do arquivo sem código."]
      });
      continue;
    }
    seen.add(key);

    const docs = bySku.get(key) || [];
    if (docs.length > 1) {
      entries.push({
        ...base,
        action: "IGNORAR",
        currentQuantity: docs.reduce((acc, d) => acc + d.quantity, 0),
        targetQuantity: null,
        notes: [`Há ${docs.length} cadastros com este código nesta loja — resolva a duplicidade antes de sincronizar.`]
      });
      continue;
    }

    if (docs.length === 0) {
      const notes: string[] = [];
      const twins = plain(item.size) ? twinsByPair.get(`${plain(item.size)}|${plain(item.brand)}`) || [] : [];
      if (twins.length > 0) {
        notes.push(
          `Possível duplicado: a loja já tem ${twins.slice(0, 3).map(t => t.sku).join(", ")} com a mesma ` +
          `medida e marca, com outro código. Se for o mesmo pneu, o estoque vai ficar em dobro.`
        );
      }
      if (fileCash <= 0 && fileInstallment <= 0) notes.push("Sem preço no ERP — entra sem valor no catálogo.");
      entries.push({
        ...base,
        action: "CRIAR",
        currentQuantity: null,
        targetQuantity: reportQuantity,
        quantityChanged: reportQuantity > 0,
        priceAfter: { cash: fileCash, installment: fileInstallment },
        notes,
        fileItem: item
      });
      continue;
    }

    const d = docs[0];
    if (mode === "SO_CADASTRAR") {
      entries.push({
        ...base,
        action: "SEM_MUDANCA",
        currentQuantity: d.quantity,
        targetQuantity: null,
        notes: ["Já existe nesta loja (mesmo código) — o arquivo não traz a hora do relatório, então não é mexido."]
      });
      continue;
    }
    entries.push(reconcile(d, item, reportQuantity, { cash: fileCash, installment: fileInstallment }));
  }

  // O que está na loja e não veio no relatório.
  if (mode === "SINCRONIZAR") {
    for (const [key, docs] of bySku) {
      if (seen.has(key)) continue;
      const d = docs[0];
      const units = docs.reduce((acc, x) => acc + x.quantity, 0);
      const base = {
        sku: d.sku,
        label: labelOf(d),
        currentQuantity: units,
        reportQuantity: null,
        movedAfterReport: 0,
        targetQuantity: null,
        quantityChanged: false,
        priceChanged: false
      };

      if (!fromThisErp(d.sku)) {
        if (units > 0) {
          entries.push({
            ...base,
            action: "CONFERIR",
            notes: [
              `Não veio deste ERP (código sem o prefixo ${prefix || "da loja"}-): não há como conferir com o ` +
              `relatório. Se o mesmo pneu está no relatório com outro código, o estoque está em dobro.`
            ]
          });
        }
        continue;
      }
      if (docs.length > 1) {
        entries.push({
          ...base,
          action: "IGNORAR",
          notes: [`Há ${docs.length} cadastros com este código nesta loja — resolva a duplicidade antes de sincronizar.`]
        });
        continue;
      }
      if (!canZero) {
        if (units > 0) {
          entries.push({
            ...base,
            action: "CONFERIR",
            notes: ["Não está no relatório, mas o relatório não cobre a loja inteira (filtro de grupo ou marca) — não foi zerado."]
          });
        }
        continue;
      }
      entries.push(reconcile(d, null, 0, null));
    }
  }

  // Ordena por tipo de ação mantendo a ordem do relatório dentro de cada uma
  // (o sort do JS é estável).
  entries.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]);

  return {
    mode,
    prefix,
    canZero,
    reportMs,
    entries,
    productsBefore: live.length,
    unitsBefore: live.reduce((acc, d) => acc + d.quantity, 0)
  };
}

export function isErpSyncWrite(action: ErpSyncAction): boolean {
  return action === "CRIAR" || action === "ATUALIZAR" || action === "ZERAR";
}

// Resultado para a tela. `conflicts` (só na gravação): produtos cujo saldo ou
// reserva mudou entre o cálculo e a escrita — ficaram de fora e voltam para
// "Conferir", e sincronizar de novo termina o serviço.
export function summarizeErpSync(
  plan: ErpSyncPlan,
  args: { companyName: string; report: ErpStockReport | null; syncId: string; applied: boolean; conflicts?: string[] }
): ErpSyncResult {
  const conflicts = new Set((args.conflicts || []).map(skuKey));
  const items: ErpSyncPreviewItem[] = plan.entries.map(({ stockItemId, reservedQuantity, fileItem, ...rest }) =>
    conflicts.has(skuKey(rest.sku))
      ? {
          ...rest,
          action: "CONFERIR" as const,
          notes: [...rest.notes, "O saldo mudou durante a gravação e este produto ficou de fora — sincronize de novo para terminar."]
        }
      : rest
  );
  const count = (a: ErpSyncAction) => items.filter(i => i.action === a).length;
  const writes = items.filter(i => isErpSyncWrite(i.action));

  return {
    mode: plan.mode,
    applied: args.applied,
    syncId: args.syncId,
    companyName: args.companyName,
    report: args.report,
    created: count("CRIAR"),
    updated: count("ATUALIZAR"),
    zeroed: count("ZERAR"),
    unchanged: count("SEM_MUDANCA"),
    review: count("CONFERIR"),
    skipped: count("IGNORAR"),
    priceChanges: writes.filter(i => i.priceChanged).length,
    movedAfterReport: items.filter(i => i.movedAfterReport !== 0).length,
    productsBefore: plan.productsBefore,
    unitsBefore: plan.unitsBefore,
    unitsAfter: plan.unitsBefore + writes.reduce((acc, i) => acc + (i.targetQuantity ?? 0) - (i.currentQuantity ?? 0), 0),
    conflicts: args.conflicts || [],
    items
  };
}
