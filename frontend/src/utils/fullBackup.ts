import { collection, getDocs, query, where, Timestamp } from "firebase/firestore";
import { db } from "../firebase";

// ─────────────────────────────────────────────────────────────────
// Backup completo
//
// Um arquivo só com tudo o que o sistema guarda. Mantém as chaves do backup
// 2.0 — `companies`, `custom_credentials`, `stock` e `movements`, que são o que
// a tela Restaurar do administrador lê — e acrescenta o que antes ficava de
// fora: usuários, transferências, baixas (stock_exits), sugestões, pedidos de
// assinatura e, se pedido, as fotos dos produtos.
//
// Duas formas de gerar:
//   • Botão "Baixar backup completo" (administrador): o histórico inteiro.
//   • Automático, toda semana, às 18h (administrador): o mesmo arquivo, mas
//     com os movimentos dos últimos 35 dias. Ler o histórico inteiro toda
//     semana gastaria milhares de leituras da cota diária do Firebase; o
//     estado atual (estoque, preços, pedidos abertos) vai sempre completo.
// ─────────────────────────────────────────────────────────────────

export const FULL_BACKUP_VERSION = "2.1";
export const WEEKLY_BACKUP_DAYS = 7;
export const WEEKLY_MOVEMENTS_DAYS = 35;

const LAST_FULL_BACKUP_KEY = "cs.lastFullBackupAt";

// Coleções que entram além de estoque, movimentos, empresas e acessos. Se uma
// delas não puder ser lida (regra do Firebase), o backup sai sem ela e avisa —
// melhor um arquivo com quase tudo do que nenhum.
const EXTRA_COLLECTIONS = ["users", "transfers", "stock_exits", "suggestions", "signature_requests"] as const;

export const BACKUP_LABELS: Record<string, string> = {
  companies: "empresas",
  custom_credentials: "acessos",
  stock: "produtos",
  movements: "movimentos",
  users: "usuários",
  transfers: "transferências",
  stock_exits: "baixas e reservas",
  suggestions: "sugestões",
  signature_requests: "assinaturas",
  stock_photos: "fotos"
};

type Row = Record<string, unknown> & { id: string };

async function readAll(name: string): Promise<Row[]> {
  const snap = await getDocs(collection(db, name));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export interface FullBackupOptions {
  // Empresas e acessos já carregados na tela (mesmo formato do backup 2.0).
  // Sem eles, são lidos do Firebase.
  companies?: unknown[];
  credentials?: unknown[];
  includePhotos?: boolean;
  // Só os movimentos dos últimos N dias. Sem valor: o histórico inteiro.
  movementsSinceDays?: number;
  onProgress?: (label: string) => void;
}

export interface FullBackupResult {
  data: Record<string, unknown>;
  counts: Record<string, number>;
  failed: string[];
}

export async function buildFullBackup(options: FullBackupOptions = {}): Promise<FullBackupResult> {
  const { includePhotos = false, movementsSinceDays, onProgress } = options;
  const failed: string[] = [];
  const sections: Record<string, unknown[]> = {};

  // Estoque, empresas e acessos são obrigatórios: sem eles o arquivo não
  // restaura, então um erro aqui interrompe o backup.
  onProgress?.(BACKUP_LABELS.stock);
  sections.stock = await readAll("stock");
  onProgress?.(BACKUP_LABELS.companies);
  sections.companies = options.companies ?? (await readAll("companies"));
  sections.custom_credentials = options.credentials ?? (await readAll("custom_credentials"));

  onProgress?.(BACKUP_LABELS.movements);
  try {
    if (movementsSinceDays) {
      const since = Timestamp.fromMillis(Date.now() - movementsSinceDays * 86_400_000);
      const snap = await getDocs(query(collection(db, "movements"), where("timestamp", ">=", since)));
      sections.movements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      sections.movements = await readAll("movements");
    }
  } catch (err) {
    console.warn("[BACKUP] movimentos não lidos:", err);
    sections.movements = [];
    failed.push("movements");
  }

  const optional: string[] = [...EXTRA_COLLECTIONS, ...(includePhotos ? ["stock_photos"] : [])];
  for (const name of optional) {
    onProgress?.(BACKUP_LABELS[name] || name);
    try {
      sections[name] = await readAll(name);
    } catch (err) {
      console.warn(`[BACKUP] ${name} não lido:`, err);
      failed.push(name);
    }
  }

  const data = {
    backupVersion: FULL_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    conteudo: {
      movimentos: movementsSinceDays ? `últimos ${movementsSinceDays} dias` : "histórico inteiro",
      fotos: includePhotos,
      faltou: failed
    },
    ...sections
  };
  const counts = Object.fromEntries(Object.entries(sections).map(([name, rows]) => [name, rows.length]));
  return { data, counts, failed };
}

export function downloadJson(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revogar na hora pode cancelar o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fullBackupFileName = (date = new Date()) => `central-stoque-backup-completo-${localDateKey(date)}.json`;

// Data local (não UTC): às 22h no Brasil o UTC já é o dia seguinte.
export function localDateKey(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Data do último backup completo NESTE aparelho (cada navegador guarda o seu).
export function lastFullBackupAt(): Date | null {
  try {
    const raw = localStorage.getItem(LAST_FULL_BACKUP_KEY);
    const date = raw ? new Date(raw) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

export function markFullBackup(date = new Date()) {
  try {
    localStorage.setItem(LAST_FULL_BACKUP_KEY, date.toISOString());
  } catch {
    // Sem armazenamento (aba anônima): o lembrete só volta a aparecer.
  }
}

// Desfaz a marca quando o backup automático falha, para tentar de novo amanhã.
export function restoreFullBackupMark(previous: Date | null) {
  try {
    if (previous) localStorage.setItem(LAST_FULL_BACKUP_KEY, previous.toISOString());
    else localStorage.removeItem(LAST_FULL_BACKUP_KEY);
  } catch {
    // Sem armazenamento: nada a desfazer.
  }
}

export function isWeeklyBackupDue(now = new Date()): boolean {
  const last = lastFullBackupAt();
  if (!last) return true;
  return now.getTime() - last.getTime() >= WEEKLY_BACKUP_DAYS * 86_400_000 - 60 * 60_000; // 1h de folga
}

export function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([name, total]) => `${total} ${BACKUP_LABELS[name] || name}`)
    .join(", ");
}
