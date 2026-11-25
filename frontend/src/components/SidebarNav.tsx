import React, { useEffect, useRef, useState } from "react";
import { BarChart3, Boxes, ChevronDown, ChevronRight, Settings, ShoppingCart } from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Menu lateral em grupos (estilo ERP)
//
// Eram 16 telas numa lista só, que rolava e escondia metade das opções. Agora
// cada tela pertence a um grupo — Estoque, Vendas, Relatórios e Sistema — e só
// o Painel fica solto, no topo.
//
// • Menu com os nomes (a partir de 1024px): o grupo abre e fecha no lugar, um
//   por vez.
// • Só ícones (tablet ou menu recolhido): cada grupo vira um ícone, e o clique
//   abre ao lado a lista das telas COM os nomes. No tablet não existe "passar o
//   mouse" para ver a dica, e 16 ícones soltos não cabiam na altura da tela.
//
// Grupo fechado mostra a soma dos contadores das telas dele (vermelho se houver
// baixa esperando), para nada pendente sumir. Uma tela fora de NAV_TAB_GROUP
// aparece solta, logo abaixo do Painel: nunca some do menu por esquecimento.
// ─────────────────────────────────────────────────────────────────

export type NavGroupId = "estoque" | "vendas" | "relatorios" | "sistema";

type IconType = React.ComponentType<{ size?: number; className?: string }>;

export const NAV_GROUPS: { id: NavGroupId; label: string; icon: IconType }[] = [
  { id: "estoque", label: "Estoque", icon: Boxes },
  { id: "vendas", label: "Vendas", icon: ShoppingCart },
  { id: "relatorios", label: "Relatórios", icon: BarChart3 },
  { id: "sistema", label: "Sistema", icon: Settings }
];

export const NAV_TAB_GROUP: Record<string, NavGroupId> = {
  unified: "estoque",
  inventory: "estoque",
  "stock-flow": "estoque",
  transfers: "estoque",
  "pdf-import": "estoque",
  catalogo: "vendas",
  reservations: "vendas",
  "exit-approvals": "vendas",
  suggestions: "vendas",
  reports: "relatorios",
  "size-history": "relatorios",
  "price-comparison": "relatorios",
  "users-admin": "sistema",
  "how-to-use": "sistema"
};

export type SidebarNavItem<T extends string> = {
  tab: T;
  icon: IconType;
  label: string;
  badge?: number;
  badgeTone?: "gold" | "red";
};

const badgeClass = (tone?: "gold" | "red") => (tone === "red" ? "bg-red-500 text-white" : "bg-gold-500 text-slate-900");

const itemTone = (active: boolean) =>
  active
    ? "bg-slate-900 text-gold-400 shadow-[0_2px_10px_rgba(212,147,33,0.15)] border-gold-500/30 font-black"
    : "text-slate-350 border-transparent hover:bg-slate-900/60 hover:text-white";

function Badge({ count, tone, className = "" }: { count: number; tone?: "gold" | "red"; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-black ${badgeClass(tone)} ${className}`}>
      {count}
    </span>
  );
}

interface SidebarNavProps<T extends string> {
  items: SidebarNavItem<T>[];
  activeTab: T;
  onSelect: (tab: T) => void;
  openGroup: NavGroupId | null;
  onOpenGroupChange: (group: NavGroupId | null) => void;
  // true = menu largo a partir de 1024px (com os nomes); false = só ícones.
  wide: boolean;
}

// Lista aberta ao lado de um ícone de grupo (menu só de ícones).
type Flyout = { group: NavGroupId; top: number; left: number };

const FLYOUT_ID = "menu-lateral-grupo";
// Altura aproximada de uma linha e do título da lista — só para a lista não
// passar do fim da tela quando o ícone está lá embaixo.
const FLYOUT_ROW = 38;
const FLYOUT_CHROME = 48;

export default function SidebarNav<T extends string>({ items, activeTab, onSelect, openGroup, onOpenGroupChange, wide }: SidebarNavProps<T>) {
  // Sem os tipos do React instalados, os hooks devolvem `any`: o tipo vai à mão.
  const [flyoutState, setFlyout] = useState(null);
  const flyout: Flyout | null = flyoutState;
  const flyoutRef: { current: HTMLDivElement | null } = useRef(null);
  const triggerRef: { current: HTMLButtonElement | null } = useRef(null);

  const topItems = items.filter(item => !NAV_TAB_GROUP[item.tab]);
  const groups = NAV_GROUPS.map(group => ({ ...group, items: items.filter(item => NAV_TAB_GROUP[item.tab] === group.id) })).filter(
    group => group.items.length > 0
  );
  const groupSummary = (group: (typeof groups)[number]) => ({
    hasActive: group.items.some(item => item.tab === activeTab),
    total: group.items.reduce((acc, item) => acc + (item.badge || 0), 0),
    urgent: group.items.some(item => item.badgeTone === "red" && (item.badge || 0) > 0)
  });

  // A lista ao lado fecha ao clicar fora, apertar Esc ou mudar a largura da
  // janela (girar o tablet). Só a altura mudando não conta: no celular e no
  // tablet a barra de endereço do navegador aparece e some sozinha.
  useEffect(() => {
    if (!flyout) return;
    const close = () => setFlyout(null);
    const openWidth = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== openWidth) close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // O próprio ícone do grupo abre e fecha no clique dele.
      if (flyoutRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [flyout]);

  const toggleFlyout = (group: NavGroupId, count: number, event: any) => {
    if (flyout?.group === group) {
      setFlyout(null);
      return;
    }
    const button = event.currentTarget as HTMLButtonElement;
    triggerRef.current = button;
    const rect = button.getBoundingClientRect();
    const railRight = button.closest("aside")?.getBoundingClientRect().right ?? rect.right + 12;
    const height = FLYOUT_CHROME + count * FLYOUT_ROW;
    const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - height - 8));
    setFlyout({ group, top, left: railRight + 8 });
    // Aberto pelo teclado (Enter/Espaço): o foco já vai para a primeira tela.
    if (event.detail === 0) requestAnimationFrame(() => flyoutRef.current?.querySelector("button")?.focus());
  };

  // Tela com o nome: solta no topo, dentro de um grupo aberto ou na lista ao lado.
  const labeledItem = (item: SidebarNavItem<T>, nested: boolean, afterSelect?: () => void) => {
    const Icon = item.icon;
    const active = activeTab === item.tab;
    return (
      <button
        key={item.tab}
        type="button"
        onClick={() => {
          onSelect(item.tab);
          afterSelect?.();
        }}
        aria-current={active ? "page" : undefined}
        className={`relative w-full shrink-0 flex items-center gap-2.5 border text-left rounded-xl transition-all cursor-pointer ${
          nested ? "py-2 px-2.5 text-[12px] font-semibold" : "py-2.5 px-3.5 text-xs font-bold"
        } ${itemTone(active)}`}
      >
        <Icon size={nested ? 14 : 16} className="stroke-[2px] shrink-0" />
        <span className="flex-1 min-w-0 leading-tight">{item.label}</span>
        <Badge count={item.badge || 0} tone={item.badgeTone} />
      </button>
    );
  };

  const grouped = (
    <>
      {topItems.map(item => labeledItem(item, false))}
      {groups.map(group => {
        // Grupo com uma tela só (ex.: o vendedor em Sistema) não precisa de
        // pasta: vira item direto.
        if (group.items.length === 1) return labeledItem(group.items[0], false);
        const open = openGroup === group.id;
        const { hasActive, total, urgent } = groupSummary(group);
        const GroupIcon = group.icon;
        return (
          <div key={group.id} className="shrink-0">
            <button
              type="button"
              onClick={() => onOpenGroupChange(open ? null : group.id)}
              aria-expanded={open}
              className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-xs font-bold border border-transparent transition-all cursor-pointer hover:bg-slate-900/60 ${
                hasActive ? "text-white" : "text-slate-350 hover:text-white"
              }`}
            >
              <GroupIcon size={16} className={`stroke-[2px] shrink-0 ${hasActive ? "text-gold-400" : ""}`} />
              <span className="flex-1 text-left">{group.label}</span>
              {!open && <Badge count={total} tone={urgent ? "red" : "gold"} />}
              <ChevronDown size={14} className={`shrink-0 text-slate-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
            </button>
            {open && (
              <div className="mt-0.5 mb-1.5 ml-[1.15rem] pl-2.5 border-l border-slate-800 flex flex-col gap-0.5">
                {group.items.map(item => labeledItem(item, true))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );

  // ── Só ícones ──
  const railItem = (item: SidebarNavItem<T>) => {
    const Icon = item.icon;
    const active = activeTab === item.tab;
    return (
      <button
        key={item.tab}
        type="button"
        onClick={() => {
          setFlyout(null);
          onSelect(item.tab);
        }}
        title={item.label}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        className={`relative w-full shrink-0 py-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-center ${itemTone(active)}`}
      >
        <Icon size={16} className="stroke-[2px] shrink-0" />
        <Badge count={item.badge || 0} tone={item.badgeTone} className="absolute top-0.5 right-1" />
      </button>
    );
  };

  const railGroups = groups.map(group => {
    if (group.items.length === 1) return railItem(group.items[0]);
    const open = flyout?.group === group.id;
    const { hasActive, total, urgent } = groupSummary(group);
    const GroupIcon = group.icon;
    return (
      <button
        key={group.id}
        type="button"
        data-rail-group={group.id}
        onClick={(event: any) => toggleFlyout(group.id, group.items.length, event)}
        title={group.label}
        aria-label={`${group.label} — abrir as telas`}
        aria-expanded={open}
        aria-controls={open ? FLYOUT_ID : undefined}
        className={`relative w-full shrink-0 py-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-center ${
          hasActive ? itemTone(true) : open ? "bg-slate-900 text-white border-slate-700" : itemTone(false)
        }`}
      >
        <GroupIcon size={16} className="stroke-[2px] shrink-0" />
        {/* Setinha no canto: este ícone abre uma lista. */}
        <ChevronRight size={10} className={`absolute bottom-1 right-1.5 stroke-[2.5px] ${open ? "text-white" : "text-slate-600"}`} />
        <Badge count={total} tone={urgent ? "red" : "gold"} className="absolute top-0.5 right-1" />
      </button>
    );
  });

  // Quem tem poucas telas (o vendedor tem 4) vê todas direto, sem abrir grupo.
  const flatRail = items.length <= 6;

  const flyoutGroup = flyout ? groups.find(group => group.id === flyout.group) : undefined;

  return (
    <>
      {/* Com os nomes (a partir de 1024px): grupos que abrem e fecham. */}
      {wide && (
        <nav aria-label="Menu principal" className="nav-scroll hidden lg:flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto overscroll-contain -mx-1 px-1">
          {grouped}
        </nav>
      )}
      {/* Só ícones (tablet ou menu recolhido): o Painel e um ícone por grupo. */}
      <nav
        aria-label="Menu principal"
        onScroll={() => flyout && setFlyout(null)}
        className={`nav-scroll flex flex-col gap-1 flex-1 min-h-0 overflow-y-auto overscroll-contain -mx-1 px-1 ${wide ? "lg:hidden" : ""}`}
      >
        {flatRail ? (
          [...topItems, ...groups.flatMap(group => group.items)].map(railItem)
        ) : (
          <>
            {topItems.map(railItem)}
            {topItems.length > 0 && railGroups.length > 0 && <div className="mx-3 my-1 shrink-0 border-t border-slate-800" aria-hidden />}
            {railGroups}
          </>
        )}
      </nav>
      {/* Lista do grupo, ao lado da coluna de ícones. "fixed" para não ser
          cortada pela rolagem da coluna. */}
      {flyout && flyoutGroup && (
        <div
          ref={flyoutRef}
          id={FLYOUT_ID}
          role="group"
          aria-label={flyoutGroup.label}
          className="fixed z-50 w-60 rounded-xl border border-slate-800 bg-[#0b0f19] p-1.5 text-white shadow-2xl shadow-black/50"
          style={{ top: flyout.top, left: flyout.left }}
        >
          <p className="px-2.5 pt-1 pb-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">{flyoutGroup.label}</p>
          <div className="flex flex-col gap-0.5">{flyoutGroup.items.map(item => labeledItem(item, true, () => setFlyout(null)))}</div>
        </div>
      )}
    </>
  );
}
