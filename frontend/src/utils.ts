import { StockFlowType } from "./types";

// ──────────────────────────────────────────────────────────────
// Motivos sugeridos para movimentação de pneus, por tipo de operação.
//
// Vive aqui porque DUAS telas gravam entrada/saída: o módulo completo (aba
// Entradas e Saídas, operação com vários pneus) e o atalho por linha do
// Estoque Unificado. As duas precisam oferecer exatamente os mesmos motivos,
// senão o histórico fica com rótulos diferentes para a mesma coisa.
// O último item ("Outro") libera o campo de texto livre.
// ──────────────────────────────────────────────────────────────
export const STOCK_FLOW_REASONS: Record<StockFlowType, string[]> = {
  ENTRADA: [
    "Compra / Reposição",
    "Devolução de cliente",
    "Retorno de garantia",
    "Sobra de inventário",
    "Outro"
  ],
  SAIDA: [
    "Venda",
    "Garantia / Troca",
    "Uso interno / Frota",
    "Perda / Avaria",
    "Falta de inventário",
    "Outro"
  ]
};

// Atalhos de quantidade — pneu quase sempre entra/sai em par ou jogo completo.
export const QUICK_QTY = [1, 2, 4];

// Strips everything except digits, so "225/65 R17", "225 65 17" and
// "22565r17" all normalize to the same "2256517" — lets users search tire
// sizes without worrying about slashes, spaces, the "R", or case.
export function normalizeTireSize(value: string): string {
  return (value || "").replace(/[^0-9]/g, "");
}

// Fuzzy tire-size match: true if `query` (in any common format) is a
// substring of `itemSize` once both are reduced to digits only.
export function matchesTireSize(itemSize: string, query: string): boolean {
  const normalizedQuery = normalizeTireSize(query);
  if (normalizedQuery.length < 2) return false;
  return normalizeTireSize(itemSize).includes(normalizedQuery);
}

// ─────────────────────────────────────────────────────────────────
// Saldo reservado x saldo livre
//
// Um pneu pode estar fisicamente no galpao e mesmo assim nao poder ser vendido:
// se uma transferencia aprovada o reservou para outra empresa, aquela quantidade
// fica presa em `reservedQuantity` ate o despacho (ou ate a reserva ser liberada).
// Todo lugar que da baixa/vende tem que raciocinar sobre o LIVRE, nunca sobre o
// total. Os documentos antigos nao tem o campo — por isso o `?? 0` aqui e nao
// espalhado por cada tela.
// ─────────────────────────────────────────────────────────────────
export function reservedQuantityOf(item: { reservedQuantity?: number } | null | undefined): number {
  const reserved = Number(item?.reservedQuantity) || 0;
  return reserved > 0 ? reserved : 0;
}

export function availableQuantity(
  item: { quantity?: number; reservedQuantity?: number } | null | undefined
): number {
  const total = Number(item?.quantity) || 0;
  return Math.max(0, total - reservedQuantityOf(item));
}

export function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

export function formatDate(timestamp: any): string {
  if (!timestamp) return "N/D";
  
  // Handle Firestore Timestamp or standard Dates
  let date: Date;
  if (timestamp.toDate && typeof timestamp.toDate === "function") {
    date = timestamp.toDate();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === "string" || typeof timestamp === "number") {
    date = new Date(timestamp);
  } else if (timestamp.seconds) {
    date = new Date(timestamp.seconds * 1000);
  } else {
    return "N/D";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

// Resolves a Firestore Timestamp (or plain Date/string/number) into milliseconds since epoch.
// Shared by App.tsx (transfer scheduling/sorting) and the notification center (event ordering).
export function toMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value.seconds) return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Short, human-friendly relative timestamp for notification feeds ("há 5 min").
// Falls back to a plain dd/mm date once the event is more than a week old.
export function formatRelativeTime(millis: number): string {
  if (!millis) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - millis) / 1000));

  if (diffSec < 30) return "agora";
  if (diffSec < 60) return `${diffSec}s atrás`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `há ${diffHour} h`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `há ${diffDay} d`;

  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(new Date(millis));
}

export function exportToCSV(data: any[], columns: { key: string; label: string }[], filename: string) {
  // Build header row
  const headers = columns.map(col => `"${col.label.replace(/"/g, '""')}"`).join(";");
  
  // Build data rows
  const rows = data.map(item => {
    return columns.map(col => {
      let val = item[col.key];
      if (val === undefined || val === null) {
        val = "";
      } else if (typeof val === "object") {
        // If it's a date or timestamp
        if (val.toDate) {
          val = formatDate(val);
        } else {
          val = JSON.stringify(val);
        }
      }
      // Format quantities / numbers if needed, or escape strings
      const stringVal = String(val).replace(/"/g, '""');
      return `"${stringVal}"`;
    }).join(";");
  });

  const csvContent = "\uFEFF" + [headers, ...rows].join("\n"); // Include BOM for proper Excel encoding
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${filename}.csv`);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
