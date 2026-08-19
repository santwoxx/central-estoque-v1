import { forwardRef } from "react";
import { Company } from "../types";

// Metadados resolvidos pelo configurador de relatório (ver UnifiedStock).
// Tudo aqui é texto já pronto: este componente não decide filtro nenhum, só
// desenha o que foi escolhido — antes, a linha de situação era escrita fixa no
// código ("FILTRO: TODOS | ORDENADO: CÓDIGO") e mentia sobre o conteúdo.
export interface PrintableReportMeta {
  title: string;
  companyLine: string;      // empresa (ou empresas) que o relatório cobre
  addressLine?: string;     // descrição/endereço da empresa, quando houver uma só
  scopeLine: string;        // "SALDO: ... | PERÍODO: ... | ORDENADO: ..."
  searchLine?: string;      // termo de busca aplicado, se houver
  generatedBy: string;
  showPrices: boolean;
  showCheckColumn: boolean;
}

interface PrintableReportProps {
  items: any[];
  companies: Company[];
  meta: PrintableReportMeta;
}

const LETTERHEAD = {
  brand: "CENTRAL AUTO CAR",
  address: "END: AV MANOEL SOUZA CHAVES, 2528 - JACANA",
  contact: "FONE: 7399999999 EMAIL: CENTRALAUTOCAR.BAHIA@GMAIL.COM"
};

const PrintableReport = forwardRef<HTMLDivElement, PrintableReportProps>(({ items, companies, meta }, ref) => {
  const today = new Date();
  const dateStr = today.toLocaleDateString("pt-BR");
  const timeStr = today.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Totais por empresa e total geral — conferência de inventário sem somar na mão.
  const totalsByCompany: Record<string, number> = {};
  companies.forEach(c => { totalsByCompany[c.id] = 0; });
  let grandTotal = 0;

  items.forEach(item => {
    companies.forEach(c => {
      const qty = item.docs && item.docs[c.id] ? Number(item.docs[c.id].quantity) || 0 : 0;
      totalsByCompany[c.id] += qty;
      grandTotal += qty;
    });
  });

  // Quantas colunas ficam à esquerda das colunas de empresa (para o colspan do rodapé).
  const leadingColumns = 5;

  return (
    <div ref={ref} className="fixed -left-[10000px] top-0 print:static print-report bg-white text-black p-4 w-[1000px] print:w-full text-xs font-mono">
      <style>{`
        @media print {
          @page {
            size: A4 landscape;
            margin: 8mm;
          }
          body * {
            visibility: hidden;
          }
          .print-report, .print-report * {
            visibility: visible;
          }
          .print-report {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: white !important;
          }
          /* Repete o cabeçalho da tabela em toda folha e evita cortar linha ao meio */
          .print-report thead { display: table-header-group; }
          .print-report tfoot { display: table-footer-group; }
          .print-report tr { page-break-inside: avoid; }
        }
      `}</style>

      {/* Cabeçalho */}
      <div className="border border-black p-2 mb-1 flex items-center justify-between">
        <div className="w-1/4">
          <div className="font-bold italic text-lg tracking-wider">{LETTERHEAD.brand}</div>
        </div>
        <div className="w-3/4 text-center">
          <div className="font-bold uppercase">{meta.companyLine}</div>
          {meta.addressLine
            ? <div className="uppercase">{meta.addressLine}</div>
            : <div>{LETTERHEAD.address}</div>}
          <div>{LETTERHEAD.contact}</div>
        </div>
      </div>

      {/* Subcabeçalho: agora descreve o filtro real aplicado */}
      <div className="border border-black p-1 mb-2 text-center">
        <div className="font-bold text-sm tracking-widest uppercase">{meta.title}</div>
        <div className="text-[10px] uppercase">| {meta.scopeLine} |</div>
        {meta.searchLine && (
          <div className="text-[10px] uppercase">| BUSCA: {meta.searchLine} |</div>
        )}
      </div>

      {/* Tabela */}
      <table className="w-full border-collapse text-[10px] uppercase">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="pb-1">CÓDIGO</th>
            <th className="pb-1">CÓD.BARRA</th>
            <th className="pb-1">DESCRIÇÃO</th>
            <th className="pb-1">GRUPO</th>
            <th className="pb-1 text-center">UND</th>
            {companies.map(c => (
              <th key={c.id} className="pb-1 text-center">QTD {c.name.substring(0, 6)}</th>
            ))}
            {meta.showPrices && <th className="pb-1 text-center">PREÇO</th>}
            {meta.showCheckColumn && <th className="pb-1 text-center w-24">QUANT. CONF.</th>}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={leadingColumns + companies.length + (meta.showPrices ? 1 : 0) + (meta.showCheckColumn ? 1 : 0)} className="py-3 text-center">
                Nenhum produto atende aos filtros selecionados.
              </td>
            </tr>
          ) : (
            items.map(item => (
              <tr key={item.sku} className="border-b border-dotted border-gray-300">
                <td className="py-1 pr-1 font-bold">{item.sku}</td>
                <td className="py-1 pr-1">SEM GTIN</td>
                <td className="py-1 pr-1">{item.description}</td>
                <td className="py-1 pr-1">PNEUS</td>
                <td className="py-1 text-center">UN</td>
                {companies.map(comp => {
                  const qty = item.docs && item.docs[comp.id] ? item.docs[comp.id].quantity : 0;
                  return <td key={comp.id} className="py-1 text-center">{qty}</td>;
                })}
                {meta.showPrices && (
                  <td className="py-1 text-center">{(Number(item.priceCash) || 0).toFixed(2).replace(".", ",")}</td>
                )}
                {meta.showCheckColumn && (
                  <td className="py-1">
                    <div className="border-b border-black h-4 w-full mt-1"></div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
        {items.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-black font-bold">
              <td className="py-1" colSpan={leadingColumns}>
                TOTAL — {items.length} {items.length === 1 ? "PRODUTO" : "PRODUTOS"}
              </td>
              {companies.map(c => (
                <td key={c.id} className="py-1 text-center">{totalsByCompany[c.id]}</td>
              ))}
              {meta.showPrices && <td className="py-1 text-center">—</td>}
              {meta.showCheckColumn && <td className="py-1 text-center">{grandTotal} UN</td>}
            </tr>
          </tfoot>
        )}
      </table>

      {/* Rodapé */}
      <div className="mt-4 flex justify-between text-[9px]">
        <div>Relatório emitido em {dateStr} - {timeStr} por {meta.generatedBy}</div>
        <div>Total geral: {grandTotal} un</div>
      </div>
    </div>
  );
});

PrintableReport.displayName = "PrintableReport";
export default PrintableReport;
