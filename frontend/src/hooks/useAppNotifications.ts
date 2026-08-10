import { useCallback, useEffect, useRef, useState } from "react";
import { AppNotification, NotificationType, StockItem, TransferOrder, TransferStatus, UserRole } from "../types";
import { toMillis } from "../utils";

const MAX_NOTIFICATIONS = 40;
const LOW_STOCK_THRESHOLD = 4; // mirrors the "Alertas de Reposição" KPI card in App.tsx

type NotifUser = { uid: string; role: UserRole; companyId?: string } | null;

function storageKey(uid: string) {
  return `notif_center_v1_${uid}`;
}

function loadStored(uid: string): AppNotification[] {
  try {
    const raw = localStorage.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStored(uid: string, list: AppNotification[]) {
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify(list.slice(0, MAX_NOTIFICATIONS)));
  } catch {
    // Storage full/unavailable (private browsing, etc.) — notifications still work in-memory for the session.
  }
}

// Who performed the transition that produced this status, if anyone identifiable.
// Used to avoid notifying a user about an action they themselves just took
// (e.g. the person who signed the dispatch doesn't need a bell alert about it).
function getTransferActorUid(transfer: TransferOrder, prevStatus: TransferStatus | null): string | null {
  if (prevStatus === null) return transfer.requestedByUid || null;
  if (transfer.status === "EM_TRANSITO") return transfer.dispatch?.sender?.signedByUid || transfer.delivery?.signedByUid || null;
  if (transfer.status === "CONCLUIDO") return transfer.arrival?.receiver?.signedByUid || transfer.receipt?.signedByUid || null;
  if (transfer.status === "CANCELADO") return transfer.cancelledByUid || null;
  return null;
}

function describeTransferEvent(
  transfer: TransferOrder,
  prevStatus: TransferStatus | null,
  user: { role: UserRole; companyId?: string }
): { type: NotificationType; title: string; message: string } | null {
  const isGlobal = user.role === "admin" || user.role === "vendedor" || !user.companyId;
  const isSource = user.companyId === transfer.sourceCompanyId;
  const isDestination = user.companyId === transfer.destinationCompanyId;
  const itemCount = (transfer.items || []).length;
  const itemsLabel = itemCount === 1 ? "1 item" : `${itemCount} itens`;
  const route = `${transfer.sourceCompanyName} → ${transfer.destinationCompanyName}`;
  const status = transfer.status;

  // Brand-new transfer document (this user just saw it appear for the first time).
  if (prevStatus === null) {
    if (status === "AGENDADO") {
      return {
        type: "TRANSFER_UPDATE",
        title: "Transferência agendada",
        message: isGlobal
          ? `${route}: ${itemsLabel} agendados por ${transfer.requestedByName}.`
          : isSource
          ? `${itemsLabel} agendados para envio a ${transfer.destinationCompanyName}.`
          : `${transfer.sourceCompanyName} agendou o envio de ${itemsLabel} para sua empresa.`
      };
    }
    if (status === "PENDENTE") {
      return {
        type: isSource || isGlobal ? "TRANSFER_ACTION_REQUIRED" : "TRANSFER_UPDATE",
        title: "Nova transferência",
        message: isGlobal
          ? `${route}: nova transferência com ${itemsLabel}, aguardando envio.`
          : isSource
          ? `${itemsLabel} aguardando sua assinatura de envio para ${transfer.destinationCompanyName}.`
          : `${transfer.sourceCompanyName} está preparando o envio de ${itemsLabel} para sua empresa.`
      };
    }
    return null;
  }

  if (status === "PENDENTE" && prevStatus === "AGENDADO") {
    return {
      type: isSource || isGlobal ? "TRANSFER_ACTION_REQUIRED" : "TRANSFER_UPDATE",
      title: "Liberada para envio",
      message: isGlobal
        ? `${route}: data agendada atingida — ${itemsLabel} liberados para envio.`
        : isSource
        ? `Data agendada atingida: ${itemsLabel} aguardando sua assinatura de envio.`
        : `${transfer.sourceCompanyName}: transferência liberada para envio.`
    };
  }

  if (status === "EM_TRANSITO" && prevStatus !== "EM_TRANSITO") {
    return {
      type: isDestination || isGlobal ? "TRANSFER_ACTION_REQUIRED" : "TRANSFER_UPDATE",
      title: "Transferência em trânsito",
      message: isGlobal
        ? `${route}: envio confirmado, ${itemsLabel} a caminho.`
        : isDestination
        ? `${itemsLabel} de ${transfer.sourceCompanyName} a caminho — confirme o recebimento.`
        : `Envio confirmado: ${itemsLabel} a caminho de ${transfer.destinationCompanyName}.`
    };
  }

  if (status === "CONCLUIDO" && prevStatus !== "CONCLUIDO") {
    return {
      type: "TRANSFER_COMPLETED",
      title: "Transferência concluída",
      message: isGlobal
        ? `${route}: ${itemsLabel} recebidos com sucesso.`
        : isDestination
        ? `Recebimento confirmado: ${itemsLabel} de ${transfer.sourceCompanyName} já estão no seu estoque.`
        : `${transfer.destinationCompanyName} confirmou o recebimento de ${itemsLabel}.`
    };
  }

  if (status === "CANCELADO" && prevStatus !== "CANCELADO") {
    return {
      type: "TRANSFER_CANCELLED",
      title: "Transferência cancelada",
      message: `${route}: ${itemsLabel} — ${transfer.cancelReason || "sem motivo informado"}.`
    };
  }

  return null;
}

function describeStockEvent(
  item: StockItem,
  prevQty: number,
  newQty: number
): { type: NotificationType; title: string; message: string } | null {
  const label = `${item.brand} ${item.model} ${item.size}`.trim();
  if (newQty <= 0 && prevQty > 0) {
    return { type: "STOCK_OUT", title: "Ruptura de estoque", message: `${label}: saldo zerado.` };
  }
  if (newQty > 0 && newQty <= LOW_STOCK_THRESHOLD && prevQty > LOW_STOCK_THRESHOLD) {
    return { type: "STOCK_LOW", title: "Estoque baixo", message: `${label}: restam apenas ${newQty} un.` };
  }
  return null;
}

/**
 * Derives an in-app notification feed (bell icon) from the real-time transfer
 * and stock streams App.tsx already subscribes to. Nothing new is fetched here —
 * this hook just diffs each update against the previous snapshot to detect
 * genuinely new events (status transitions, stock crossing into a low/zero band),
 * and persists the resulting feed per-user in localStorage so it survives reloads.
 *
 * `transfersReady` / `stockReady` gate the very first diff so a fresh login
 * doesn't replay the entire transfer/stock history as a flood of notifications —
 * the first snapshot after each becomes ready is used only to seed state.
 */
export function useAppNotifications(
  user: NotifUser,
  transfers: TransferOrder[],
  transfersReady: boolean,
  stock: StockItem[],
  stockReady: boolean
) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const prevTransfersRef = useRef<Map<string, TransferOrder> | null>(null);
  const transfersSeededRef = useRef(false);
  const prevStockRef = useRef<Map<string, number> | null>(null);
  const stockSeededRef = useRef(false);
  const userIdRef = useRef<string | null>(null);

  // (Re)load per-user feed and reset diff state whenever the logged-in user changes.
  useEffect(() => {
    prevTransfersRef.current = null;
    transfersSeededRef.current = false;
    prevStockRef.current = null;
    stockSeededRef.current = false;

    if (!user) {
      userIdRef.current = null;
      setNotifications([]);
      return;
    }
    userIdRef.current = user.uid;
    setNotifications(loadStored(user.uid));
  }, [user?.uid]);

  const pushNotifications = useCallback((incoming: AppNotification[]) => {
    if (!userIdRef.current || incoming.length === 0) return;
    setNotifications(prev => {
      const merged = [...incoming, ...prev].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NOTIFICATIONS);
      saveStored(userIdRef.current as string, merged);
      return merged;
    });
  }, []);

  // Diff transfer status transitions.
  useEffect(() => {
    if (!user || !transfersReady) return;

    const currentMap = new Map(transfers.map(t => [t.id, t]));

    if (!transfersSeededRef.current) {
      transfersSeededRef.current = true;
      prevTransfersRef.current = currentMap;
      return;
    }

    const prevMap = prevTransfersRef.current || new Map();
    const generated: AppNotification[] = [];

    for (const t of transfers) {
      const prevT = prevMap.get(t.id);
      const prevStatus: TransferStatus | null = prevT ? prevT.status : null;
      if (prevStatus === t.status) continue;

      const actorUid = getTransferActorUid(t, prevStatus);
      if (actorUid && actorUid === user.uid) continue; // don't notify yourself about your own action

      const desc = describeTransferEvent(t, prevStatus, user);
      if (!desc) continue;

      generated.push({
        id: `transfer:${t.id}:${t.status}`,
        type: desc.type,
        title: desc.title,
        message: desc.message,
        createdAt: toMillis(t.updatedAt) || Date.now(),
        read: false,
        refId: t.id,
        targetTab: "transfers"
      });
    }

    prevTransfersRef.current = currentMap;
    if (generated.length) pushNotifications(generated);
  }, [transfers, transfersReady, user, pushNotifications]);

  // Diff stock quantities crossing into "low" / "out" bands.
  useEffect(() => {
    if (!user || !stockReady) return;

    const currentMap = new Map(stock.map(s => [s.id, s.quantity]));

    if (!stockSeededRef.current) {
      stockSeededRef.current = true;
      prevStockRef.current = currentMap;
      return;
    }

    const prevMap = prevStockRef.current || new Map();
    const generated: AppNotification[] = [];
    const stockTargetTab = user.role === "alimentador" ? "inventory" : "unified";

    for (const item of stock) {
      const prevQty = prevMap.get(item.id);
      if (prevQty === undefined || prevQty === item.quantity) continue;

      const desc = describeStockEvent(item, prevQty, item.quantity);
      if (!desc) continue;

      generated.push({
        id: `stock:${item.id}:${desc.type}:${Date.now()}`,
        type: desc.type,
        title: desc.title,
        message: desc.message,
        createdAt: Date.now(),
        read: false,
        refId: item.id,
        targetTab: stockTargetTab
      });
    }

    prevStockRef.current = currentMap;
    if (generated.length) pushNotifications(generated);
  }, [stock, stockReady, user, pushNotifications]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => {
      if (!prev.some(n => !n.read)) return prev;
      const updated = prev.map(n => (n.read ? n : { ...n, read: true }));
      if (userIdRef.current) saveStored(userIdRef.current, updated);
      return updated;
    });
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev => {
      const updated = prev.map(n => (n.id === id ? { ...n, read: true } : n));
      if (userIdRef.current) saveStored(userIdRef.current, updated);
      return updated;
    });
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    if (userIdRef.current) saveStored(userIdRef.current, []);
  }, []);

  return { notifications, unreadCount, markAllAsRead, markAsRead, clearAll };
}
