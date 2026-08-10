import { useEffect, useRef, useState } from "react";
import { AppNotification, NotificationType } from "../types";
import { formatRelativeTime } from "../utils";
import {
  Bell,
  BellOff,
  CheckCheck,
  AlertTriangle,
  ArrowLeftRight,
  PackageCheck,
  PackageOpen,
  Ban,
  X
} from "lucide-react";

// Visual language per event type — reuses the exact badge palette TransferOrders.tsx
// already uses for status pills, so the bell reads as part of the same design system
// rather than inventing new "warning colors".
const TYPE_STYLES: Record<NotificationType, { icon: any; iconClass: string; dotClass: string }> = {
  TRANSFER_ACTION_REQUIRED: { icon: AlertTriangle, iconClass: "bg-amber-50 text-amber-800 border-amber-200", dotClass: "bg-amber-500" },
  TRANSFER_UPDATE: { icon: ArrowLeftRight, iconClass: "bg-blue-50 text-blue-800 border-blue-200", dotClass: "bg-blue-500" },
  TRANSFER_COMPLETED: { icon: PackageCheck, iconClass: "bg-emerald-50 text-emerald-800 border-emerald-200", dotClass: "bg-emerald-500" },
  TRANSFER_CANCELLED: { icon: Ban, iconClass: "bg-red-50 text-red-700 border-red-200", dotClass: "bg-red-500" },
  STOCK_LOW: { icon: PackageOpen, iconClass: "bg-amber-50 text-amber-800 border-amber-200", dotClass: "bg-amber-500" },
  STOCK_OUT: { icon: PackageOpen, iconClass: "bg-red-50 text-red-700 border-red-200", dotClass: "bg-red-500" }
};

interface NotificationBellProps {
  notifications: AppNotification[];
  unreadCount: number;
  onMarkAllAsRead: () => void;
  onNotificationClick: (notification: AppNotification) => void;
  /** "dark" for placement on the near-black sidebar/mobile header, "light" for white surfaces. */
  theme?: "dark" | "light";
  align?: "left" | "right";
}

export default function NotificationBell({
  notifications,
  unreadCount,
  onMarkAllAsRead,
  onNotificationClick,
  theme = "dark",
  align = "right"
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevUnreadRef = useRef(unreadCount);

  // Brief bell "wiggle" whenever the unread count goes up (new event arrived).
  useEffect(() => {
    if (unreadCount > prevUnreadRef.current) {
      setRinging(true);
      const timer = setTimeout(() => setRinging(false), 900);
      prevUnreadRef.current = unreadCount;
      return () => clearTimeout(timer);
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const buttonClass =
    theme === "dark"
      ? "p-2 text-slate-400 hover:text-gold-400 rounded-lg hover:bg-slate-900 transition-all cursor-pointer"
      : "p-2 text-slate-400 hover:text-gold-600 rounded-lg hover:bg-slate-100 transition-all cursor-pointer";

  const visible = notifications.slice(0, 25);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`relative ${buttonClass} ${ringing ? "animate-[bellRing_0.7s_ease-in-out]" : ""}`}
        title="Notificações"
        aria-label={`Notificações${unreadCount > 0 ? ` (${unreadCount} não lidas)` : ""}`}
      >
        <Bell size={16} className="stroke-[2px]" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-600 text-white text-[9px] font-black flex items-center justify-center border-2 border-[#0b0f19] leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full mt-2 ${align === "right" ? "right-0" : "left-0"} w-80 max-w-[92vw] bg-white rounded-2xl border border-slate-200 shadow-2xl z-50 animate-scaleUp overflow-hidden`}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-1.5">
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider">Notificações</h3>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 text-[9px] font-black">{unreadCount} novas</span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={onMarkAllAsRead}
                className="flex items-center gap-1 text-[10px] font-bold text-gold-600 hover:text-gold-700 cursor-pointer"
              >
                <CheckCheck size={12} /> Marcar lidas
              </button>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-100">
            {visible.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-slate-400">
                <BellOff size={22} className="stroke-[1.5]" />
                <p className="text-[11px] font-bold">Nenhuma notificação por enquanto</p>
                <p className="text-[10px] text-slate-350 px-6 text-center leading-relaxed">
                  Avisos de transferências e alertas de estoque aparecem aqui em tempo real.
                </p>
              </div>
            ) : (
              visible.map(n => {
                const style = TYPE_STYLES[n.type];
                const Icon = style.icon;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onNotificationClick(n);
                    }}
                    className={`w-full flex items-start gap-2.5 px-4 py-3 text-left transition-colors cursor-pointer hover:bg-slate-50 ${
                      !n.read ? "bg-gold-50/40" : ""
                    }`}
                  >
                    <div className={`h-8 w-8 shrink-0 rounded-lg border flex items-center justify-center ${style.iconClass}`}>
                      <Icon size={14} className="stroke-[2px]" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        {!n.read && <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${style.dotClass}`} />}
                        <p className={`text-[11px] leading-tight truncate ${n.read ? "font-bold text-slate-600" : "font-black text-slate-900"}`}>
                          {n.title}
                        </p>
                      </div>
                      <p className="text-[10.5px] text-slate-500 leading-snug line-clamp-2">{n.message}</p>
                      <p className="text-[9px] text-slate-350 font-semibold uppercase tracking-wide">{formatRelativeTime(n.createdAt)}</p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Toast layer: pops a compact card top-right whenever a brand-new
// notification lands, even if the bell dropdown is closed. Mounted
// once at the app root (not per bell instance) so desktop + mobile
// bell buttons don't each fire their own toast for the same event.
// ─────────────────────────────────────────────────────────────────
interface NotificationToastProps {
  notifications: AppNotification[];
  onNotificationClick: (notification: AppNotification) => void;
}

export function NotificationToast({ notifications, onNotificationClick }: NotificationToastProps) {
  const [toast, setToast] = useState<AppNotification | null>(null);
  const seenTopIdRef = useRef<string | null>(null);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    const top = notifications[0];
    if (!top) return;

    if (!hasMountedRef.current) {
      // First paint after the feed loads from localStorage — don't toast old history.
      hasMountedRef.current = true;
      seenTopIdRef.current = top.id;
      return;
    }

    if (top.id !== seenTopIdRef.current && !top.read) {
      seenTopIdRef.current = top.id;
      setToast(top);
      const timer = setTimeout(() => setToast(null), 7000);
      return () => clearTimeout(timer);
    }
    seenTopIdRef.current = top.id;
  }, [notifications]);

  if (!toast) return null;
  const style = TYPE_STYLES[toast.type];
  const Icon = style.icon;

  return (
    <div className="fixed top-4 right-4 z-[60] w-[calc(100vw-2rem)] max-w-sm animate-scaleUp">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
        <div className="flex items-start gap-2.5 px-4 py-3">
          <div className={`h-8 w-8 shrink-0 rounded-lg border flex items-center justify-center ${style.iconClass}`}>
            <Icon size={14} className="stroke-[2px]" />
          </div>
          <button
            type="button"
            onClick={() => {
              setToast(null);
              onNotificationClick(toast);
            }}
            className="min-w-0 flex-1 text-left cursor-pointer"
          >
            <p className="text-[11px] font-black text-slate-900 leading-tight">{toast.title}</p>
            <p className="text-[10.5px] text-slate-500 leading-snug mt-0.5 line-clamp-2">{toast.message}</p>
          </button>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="p-1 text-slate-350 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0"
            aria-label="Fechar notificação"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
