import React from "react";
import { productLineOf } from "../utils/productLine";
import {
  DOT_OLD_MONTHS,
  DOT_WARN_MONTHS,
  dotAgeLabel,
  dotAgeMonths,
  dotLabel,
  isHeavyTruckTire,
  positionLabel,
  TRUCK_POSITIONS,
  tireSpecOf,
  type TruckPosition
} from "../utils/tireSpec";
import type { StockItem } from "../types";

// ─────────────────────────────────────────────────────────────────
// Selos da ficha do pneu (posição, lonas, câmara, DOT) e o filtro de posição
// da aba Carga. Ver utils/tireSpec.ts para de onde vem cada informação.
// ─────────────────────────────────────────────────────────────────

const POSITION_STYLE: Record<TruckPosition, string> = {
  DIRECIONAL: "bg-sky-100 text-sky-800 border-sky-200",
  TRACAO: "bg-orange-100 text-orange-800 border-orange-200",
  LIVRE: "bg-slate-100 text-slate-700 border-slate-300",
  MISTO: "bg-violet-100 text-violet-800 border-violet-200"
};

const chip = "inline-flex items-center gap-0.5 whitespace-nowrap rounded border px-1.5 py-[1px] text-[9px] font-black uppercase tracking-wider leading-tight";

// Selos de um produto. Posição, lonas e câmara só nos pneus da linha Carga
// (em pneu de carro não dizem nada); o DOT em qualquer pneu.
export function TireSpecBadges({
  item,
  showDot = true,
  className = ""
}: {
  item: StockItem;
  showDot?: boolean;
  className?: string;
}) {
  const line = productLineOf(item);
  if (line === "ACESSORIO") return null;
  const spec = tireSpecOf(item);
  const isCarga = line === "CARGA";
  const badges: React.ReactNode[] = [];

  // Posição só em pneu de caminhão/ônibus (ou quando o dono marcou na ficha):
  // em pneu de van ela não existe, e uma palavra solta da descrição viraria selo.
  if (isCarga && spec.position && (spec.positionFromForm || isHeavyTruckTire(item))) {
    const p = TRUCK_POSITIONS.find(x => x.id === spec.position)!;
    badges.push(
      <span
        key="pos"
        className={`${chip} ${POSITION_STYLE[spec.position]}`}
        title={`${p.label} — ${p.hint}${spec.positionFromForm ? "" : " (lido da descrição)"}`}
      >
        {p.label}
      </span>
    );
  }
  if (isCarga && spec.ply) {
    badges.push(
      <span key="ply" className={`${chip} border-slate-200 bg-white text-slate-600`} title={`${spec.ply} lonas${spec.loadIndex ? ` · índice de carga ${spec.loadIndex}` : ""}`}>
        {spec.ply}PR{spec.loadIndex ? ` · ${spec.loadIndex}` : ""}
      </span>
    );
  } else if (isCarga && spec.loadIndex) {
    badges.push(
      <span key="idx" className={`${chip} border-slate-200 bg-white text-slate-600`} title="Índice de carga e velocidade">
        {spec.loadIndex}
      </span>
    );
  }
  // Só "com câmara" vira selo: é o que pede câmara e protetor junto na venda.
  if (isCarga && spec.tube === "COM_CAMARA") {
    badges.push(
      <span key="tube" className={`${chip} border-amber-300 bg-amber-50 text-amber-800`} title="Pneu com câmara: vende com câmara de ar e protetor">
        C/ câmara
      </span>
    );
  }
  if (showDot && spec.dots.length) {
    const shown = spec.dots.slice(0, 2);
    shown.forEach(code => {
      const months = dotAgeMonths(code);
      const tone =
        months >= DOT_OLD_MONTHS
          ? "border-red-300 bg-red-50 text-red-700"
          : months >= DOT_WARN_MONTHS
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800";
      badges.push(
        <span
          key={`dot-${code}`}
          className={`${chip} ${tone}`}
          title={`DOT ${code}: fabricado em ${dotLabel(code)}, ${dotAgeLabel(code)}${
            months >= DOT_OLD_MONTHS ? " — pneu antigo" : ""
          }${spec.dotsFromNotes ? " (lido das anotações)" : ""}`}
        >
          DOT {code}
        </span>
      );
    });
    if (spec.dots.length > shown.length) {
      badges.push(
        <span key="dot-more" className={`${chip} border-slate-200 bg-white text-slate-500`} title={`DOTs: ${spec.dots.join(", ")}`}>
          +{spec.dots.length - shown.length}
        </span>
      );
    }
  }

  if (!badges.length) return null;
  return <div className={`flex flex-wrap items-center gap-1 ${className}`}>{badges}</div>;
}

// ── Filtro de posição (aba Carga) ─────────────────────────────────
// "NONE" = pneu de caminhão/ônibus SEM posição (falta completar a ficha);
// "NA" = pneu em que posição não se aplica (van tipo C) — só aparece em
// "Todas as posições".
export type PositionFilter = "ALL" | TruckPosition | "NONE";
export type PositionKey = TruckPosition | "NONE" | "NA";

export function positionOf(item: StockItem): PositionKey {
  const spec = tireSpecOf(item);
  if (spec.positionFromForm && spec.position) return spec.position;
  if (!isHeavyTruckTire(item)) return "NA";
  return spec.position || "NONE";
}

export function countByPosition<T>(list: T[], positionOfItem: (item: T) => PositionKey): Record<PositionFilter, number> {
  const counts: Record<PositionFilter | "NA", number> = { ALL: list.length, DIRECIONAL: 0, TRACAO: 0, LIVRE: 0, MISTO: 0, NONE: 0, NA: 0 };
  for (const item of list) counts[positionOfItem(item)] += 1;
  return counts;
}

export function TruckPositionFilter({
  counts,
  value,
  onChange,
  theme = "light",
  className = ""
}: {
  counts: Record<PositionFilter, number>;
  value: PositionFilter;
  onChange: (value: PositionFilter) => void;
  theme?: "light" | "dark";
  className?: string;
}) {
  const options: { id: PositionFilter; label: string; title: string }[] = [
    { id: "ALL", label: "Todas as posições", title: "Todos os pneus de carga" },
    ...TRUCK_POSITIONS.filter(p => counts[p.id] > 0 || value === p.id).map(p => ({ id: p.id as PositionFilter, label: p.label, title: p.hint })),
    // "Sem posição" é a lista de trabalho do dono: o que falta completar na ficha.
    ...(counts.NONE > 0 || value === "NONE"
      ? [{ id: "NONE" as PositionFilter, label: "Sem posição", title: "Pneus de carga sem posição informada — complete na ficha do produto" }]
      : [])
  ];
  if (options.length <= 2 && value === "ALL") return null;
  const dark = theme === "dark";

  return (
    <div className={`no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto ${className}`} role="group" aria-label="Posição do pneu de carga">
      {options.map(option => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            title={option.title}
            aria-pressed={active}
            className={`shrink-0 cursor-pointer whitespace-nowrap rounded-lg border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition-all ${
              active
                ? dark
                  ? "border-white bg-white text-slate-900"
                  : "border-slate-900 bg-slate-900 text-white"
                : dark
                ? "border-white/20 text-slate-200 hover:bg-white/10"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {option.label} <span className="opacity-60">{counts[option.id]}</span>
          </button>
        );
      })}
    </div>
  );
}

export { positionLabel };
