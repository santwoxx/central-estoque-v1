import React from "react";
import { Building2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Selo com o nome da loja, para as telas em que se escolhe um pneu de uma
// lista com várias lojas (Entradas e Saídas, Saída de Pneus).
//
// O nome NUNCA encolhe: "CENTRAL AUTOCAR" e "CENTRAL AUTOCENTER" cortados
// viram o mesmo "CENTRAL AUTOC…". Foi assim que o PNEU-8669, cadastrado nas
// duas lojas em 20/10, levou as vendas de 24 e 26/10 na loja errada: as duas
// linhas eram idênticas, a loja era um texto cinza no fim de uma linha que o
// navegador cortava. Quem encolhe é a marca/modelo ao lado do selo.
// ─────────────────────────────────────────────────────────────────
export default function StoreChip({ name, own }: { name: string; own: boolean }) {
  return (
    <span
      title={own ? `${name} — sua loja` : name}
      className={`inline-flex items-center gap-1 shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wider ${
        own ? "bg-gold-50 text-gold-800 border-gold-300" : "bg-slate-800 text-white border-slate-800"
      }`}
    >
      <Building2 size={9} className="stroke-[2.5px]" /> {name}
    </span>
  );
}
