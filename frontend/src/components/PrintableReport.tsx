import React, { forwardRef } from "react";
import { StockItem, Company } from "../types";

interface PrintableReportProps {
  items: any[];
  companies: Company[];
  companyName?: string;
}

const PrintableReport = forwardRef<HTMLDivElement, PrintableReportProps>(({ items, companies, companyName }, ref) => {
  const today = new Date();
  const dateStr = today.toLocaleDateString('pt-BR');
  const timeStr = today.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div ref={ref} className="hidden print:block print-report bg-white text-black p-4 w-full text-xs font-mono">
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 10mm;
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
        }
      `}</style>

      {/* Header */}
      <div className="border border-black p-2 mb-1 flex items-center justify-between">
        <div className="w-1/4">
          <div className="font-bold italic text-lg tracking-wider">CENTRAL AUTO CAR</div>
        </div>
        <div className="w-3/4 text-center">
          <div className="font-bold uppercase">{companyName || "CENTRAL AUTO CAR LTDA"}</div>
          <div>END: AV MANOEL SOUZA CHAVES, 2528 - JACANA</div>
          <div>FONE: 7399999999 EMAIL: CENTRALAUTOCAR.BAHIA@GMAIL.COM</div>
        </div>
      </div>

      {/* Subheader */}
      <div className="border border-black p-1 mb-2 text-center">
        <div className="font-bold text-sm tracking-widest">LISTAGEM DE PRODUTOS</div>
        <div className="text-[10px] uppercase">| SITUAÇÃO: ATIVOS | FILTRO: TODOS | ORDENADO: CÓDIGO |</div>
      </div>

      {/* Table */}
      <table className="w-full border-collapse text-[10px] uppercase">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="pb-1">CÓDIGO</th>
            <th className="pb-1">CÓD.BARRA</th>
            <th className="pb-1">DESCRIÇÃO</th>
            <th className="pb-1">GRUPO</th>
            <th className="pb-1 text-center">UND</th>
            {companies.map(c => <th key={c.id} className="pb-1 text-center">QTD {c.name.substring(0,3)}</th>)}
            <th className="pb-1 text-center">PREÇO</th>
            <th className="pb-1 text-center w-24">QUANT. CONF.</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            return (
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
                <td className="py-1 text-center">{item.priceCash.toFixed(2).replace('.', ',')}</td>
                <td className="py-1">
                  <div className="border-b border-black h-4 w-full mt-1"></div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Footer */}
      <div className="mt-4 flex justify-between text-[9px]">
        <div>Relatório emitido em {dateStr} - {timeStr}</div>
        <div>Pág.1</div>
      </div>
    </div>
  );
});

PrintableReport.displayName = "PrintableReport";
export default PrintableReport;
