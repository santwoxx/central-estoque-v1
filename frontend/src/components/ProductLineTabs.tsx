import React, { useState } from "react";
import { Car, LayoutGrid, Tractor, Truck, Wrench } from "lucide-react";
import { isProductLine, PRODUCT_LINES, type LineFilter } from "../utils/productLine";

// ─────────────────────────────────────────────────────────────────
// Abas de linha: Todos | Passeio | Carga | Agrícola e Industrial | Acessórios
//
// A mesma barra em todas as telas de estoque, cada aba com quantos produtos
// tem DENTRO do que a tela já está mostrando (busca, loja). Aba de linha vazia
// não aparece; loja que só tem uma linha não vê barra nenhuma — ela não
// separaria nada.
// ─────────────────────────────────────────────────────────────────

const ICONS: Record<LineFilter, React.ComponentType<{ size?: number; className?: string }>> = {
  ALL: LayoutGrid,
  PASSEIO: Car,
  CARGA: Truck,
  AGRO: Tractor,
  ACESSORIO: Wrench
};

// A aba escolhida fica guardada no aparelho, uma por tela: quem trabalha com
// caminhão abre o sistema e já cai na aba Carga.
export function usePersistentLineFilter(screen: string): [LineFilter, (value: LineFilter) => void] {
  const key = `cs.linha.${screen}`;
  const [value, setValue] = useState<LineFilter>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === "ALL" || isProductLine(saved) ? (saved as LineFilter) : "ALL";
    } catch {
      return "ALL";
    }
  });
  const update = (next: LineFilter) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Sem armazenamento no navegador: vale só enquanto a tela está aberta.
    }
  };
  return [value, update];
}

interface ProductLineTabsProps {
  counts: Record<LineFilter, number>;
  value: LineFilter;
  onChange: (value: LineFilter) => void;
  theme?: "light" | "dark";
  size?: "md" | "sm";
  className?: string;
}

export default function ProductLineTabs({
  counts,
  value,
  onChange,
  theme = "light",
  size = "md",
  className = ""
}: ProductLineTabsProps) {
  const lines = PRODUCT_LINES.filter(line => counts[line.id] > 0 || line.id === value);
  if (lines.length < 2 && value === "ALL") return null;

  const dark = theme === "dark";
  const tabs: { id: LineFilter; label: string; hint: string }[] = [
    { id: "ALL", label: "Todos", hint: "Todas as linhas" },
    ...lines
  ];

  return (
    <div
      role="tablist"
      aria-label="Linha de produto"
      className={`no-scrollbar flex max-w-full items-stretch gap-1 overflow-x-auto rounded-xl border p-1 ${
        dark ? "border-white/15 bg-white/10" : "border-slate-200 bg-slate-100"
      } ${className}`}
    >
      {tabs.map(tab => {
        const Icon = ICONS[tab.id];
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.hint}
            onClick={() => onChange(tab.id)}
            className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border font-black uppercase tracking-wider transition-all ${
              size === "sm" ? "px-2.5 py-1.5 text-[10px]" : "px-3 py-2 text-[11px]"
            } ${
              active
                ? dark
                  ? "border-gold-500 bg-gold-500 text-slate-900 shadow-sm"
                  : "border-slate-200 bg-white text-slate-900 shadow-sm"
                : dark
                ? "border-transparent text-slate-200 hover:bg-white/10"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <Icon size={size === "sm" ? 12 : 14} className={active && !dark ? "text-gold-600" : ""} />
            {tab.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[9px] leading-none ${
                active
                  ? dark
                    ? "bg-slate-900/15 text-slate-900"
                    : "bg-gold-500 text-white"
                  : dark
                  ? "bg-white/15 text-slate-100"
                  : "bg-slate-200 text-slate-600"
              }`}
            >
              {counts[tab.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
