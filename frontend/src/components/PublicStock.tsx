import React, { useState, useEffect, useMemo } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { StockItem, Company } from "../types";
import { Search, Loader2 } from "lucide-react";
import { matchesTireSize } from "../utils";

interface ConsolidatedItem {
  sku: string;
  description: string;
  brand: string;
  model: string;
  size: string;
  priceCash: number;
  priceInstallment: number;
  docs: Record<string, StockItem>;
}

export default function PublicStock() {
  const [stock, setStock] = useState<StockItem[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    const unsubCompanies = onSnapshot(collection(db, "companies"), (snapshot) => {
      const list: Company[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        list.push({
          id: docSnap.id,
          name: data.name || "",
          description: data.description || "",
          createdAt: data.createdAt
        });
      });
      list.sort((a, b) => a.name.localeCompare(b.name));
      setCompanies(list);
    }, (error) => {
      console.error("Erro ao ler filiais na consulta pública:", error);
    });

    const unsubStock = onSnapshot(collection(db, "stock"), (snapshot) => {
      const itemsList: StockItem[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        itemsList.push({
          id: docSnap.id,
          sku: data.sku || "",
          brand: data.brand || "",
          model: data.model || "",
          size: data.size || "",
          quantity: data.quantity ?? 0,
          price: data.price ?? 0,
          priceCash: data.priceCash ?? data.price ?? 0,
          priceInstallment: data.priceInstallment ?? data.price ?? 0,
          notes: data.notes || "",
          description: data.description || "",
          imageUrl: data.imageUrl || "",
          userId: data.userId || "",
          userEmail: data.userEmail || "",
          companyId: data.companyId || "",
          companyName: data.companyName || "",
          createdAt: data.createdAt,
          updatedAt: data.updatedAt
        });
      });
      setStock(itemsList);
      setLoading(false);
    }, (error) => {
      console.error("Erro ao ler estoque na consulta pública:", error);
      setLoading(false);
    });

    return () => {
      unsubCompanies();
      unsubStock();
    };
  }, []);

  const consolidatedItems = useMemo(() => {
    const map = new Map<string, ConsolidatedItem>();

    stock.forEach(item => {
      const key = item.sku;
      if (!map.has(key)) {
        map.set(key, {
          sku: item.sku,
          brand: item.brand,
          model: item.model,
          size: item.size,
          description: `${item.size} ${item.brand} ${item.model}`.trim(),
          priceCash: item.priceCash || item.price || 0,
          priceInstallment: item.priceInstallment || item.price || 0,
          docs: {}
        });
      }

      const cons = map.get(key)!;
      let compId = item.companyId;
      if (!compId && item.companyName) {
        const found = companies.find(c => c.name.toLowerCase() === item.companyName!.toLowerCase());
        if (found) compId = found.id;
      }
      
      if (compId) {
        cons.docs[compId] = item;
      }
      
      if (item.priceCash && item.priceCash > cons.priceCash) cons.priceCash = item.priceCash;
      if (item.priceInstallment && item.priceInstallment > cons.priceInstallment) cons.priceInstallment = item.priceInstallment;
    });

    return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku));
  }, [stock, companies]);

  const filteredItems = useMemo(() => {
    if (!searchTerm) return consolidatedItems;
    const lower = searchTerm.toLowerCase();
    return consolidatedItems.filter(item =>
      item.sku.toLowerCase().includes(lower) ||
      item.description.toLowerCase().includes(lower) ||
      item.brand.toLowerCase().includes(lower) ||
      item.size.toLowerCase().includes(lower) ||
      matchesTireSize(item.size, lower)
    );
  }, [consolidatedItems, searchTerm]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={32} className="animate-spin text-gold-600" />
          <p className="text-slate-500 font-bold text-sm uppercase tracking-wider">Carregando Estoque Público...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header Público */}
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-black text-slate-900 uppercase tracking-tight">Consulta de Estoque</h1>
            <p className="text-sm font-semibold text-slate-500">Visualização em tempo real (Somente Leitura)</p>
          </div>
          
          <div className="flex items-center border border-slate-200 px-3 py-2 rounded-xl max-w-md w-full focus-within:ring-2 focus-within:ring-gold-500/20 focus-within:border-gold-500 transition-all bg-slate-50">
            <Search size={16} className="text-slate-400 mr-2" />
            <input 
              type="text" 
              placeholder="Pesquisar por SKU, modelo, marca ou medida..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full outline-none text-xs text-slate-800 bg-transparent font-semibold"
            />
          </div>
        </div>

        {/* Tabela de Estoque */}
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm text-slate-850">
            <thead className="bg-slate-50 text-slate-450 text-[10px] uppercase tracking-wider font-extrabold border-b border-slate-200">
              <tr>
                <th className="border-r border-slate-200 p-3 text-center" rowSpan={2}>CODIGO</th>
                <th className="border-r border-slate-200 p-3 text-center" rowSpan={2}>MEDIDA</th>
                <th className="border-r border-slate-200 p-3" rowSpan={2}>DESCRIÇÃO</th>
                <th className="border-r border-slate-200 p-3 text-center" colSpan={companies.length}>QUANTIDADE</th>
                <th className="border-r border-slate-200 p-3 text-center" rowSpan={2}>P/ A VISTA</th>
                <th className="p-3 text-center" rowSpan={2}>P/PRAZO</th>
              </tr>
              <tr className="border-t border-slate-200">
                {companies.map(comp => (
                  <th key={comp.id} className="border-r border-slate-200 p-2 text-center text-[9px] min-w-[90px]">{comp.name.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredItems.map((item) => (
                <tr key={item.sku} className="hover:bg-gold-50/5 text-slate-800 transition-colors">
                  <td className="border-r border-slate-200 p-3 text-center font-bold text-slate-900 whitespace-nowrap">{item.sku}</td>
                  <td className="border-r border-slate-200 p-3 text-center font-mono font-bold text-gold-700 whitespace-nowrap">{item.size}</td>
                  <td className="border-r border-slate-200 p-3 font-semibold text-slate-700 min-w-[200px]">
                    {item.brand} <span className="font-normal text-slate-600">{item.model}</span>
                  </td>
                  
                  {/* Quantidades por Filial */}
                  {companies.map(comp => {
                    const docItem = item.docs[comp.id];
                    const qty = docItem ? docItem.quantity : 0;
                    return (
                      <td key={comp.id} className="border-r border-slate-200 p-3 text-center">
                        {qty ? (
                          <span className={`inline-block px-2 py-0.5 rounded-lg border font-black text-xs ${qty > 5 ? "bg-gold-500/10 text-gold-700 border-gold-400/20" : "bg-amber-100/60 text-amber-800 border-amber-300/30"}`}>
                            {qty} un
                          </span>
                        ) : (
                          <span className="text-slate-300 font-bold">—</span>
                        )}
                      </td>
                    );
                  })}

                  <td className="border-r border-slate-200 p-3 text-center font-bold text-slate-900">
                    {item.priceCash > 0 ? `R$ ${item.priceCash.toFixed(2).replace(".", ",")}` : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="p-3 text-center font-bold text-slate-900">
                    {item.priceInstallment > 0 ? `R$ ${item.priceInstallment.toFixed(2).replace(".", ",")}` : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
              
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={6 + companies.length} className="p-8 text-center text-slate-400 font-semibold">
                    Nenhum pneu encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        
        <div className="text-center text-[10px] text-slate-400 font-semibold uppercase tracking-wider pb-10">
          Central de Estoque © Todos os direitos reservados.
        </div>
      </div>
    </div>
  );
}
