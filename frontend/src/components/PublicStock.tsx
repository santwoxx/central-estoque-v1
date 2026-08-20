import React, { useState, useEffect, useMemo } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { StockItem, Company } from "../types";
import { Search, Loader2, CircleDashed, Package, Store } from "lucide-react";
import { availableQuantity, matchesTireSize } from "../utils";

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
          reservedQuantity: data.reservedQuantity ?? 0,
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

    // Filtra apenas produtos que têm alguma quantidade > 0 em alguma filial
    // Como é um catálogo de vendas, talvez não faça sentido mostrar itens totalmente esgotados
    // Se quiser mostrar tudo, basta remover o filtro abaixo.
    // "Disponível" aqui é o saldo LIVRE: pneu reservado para uma transferência
    // aprovada já tem dono, e prometê-lo de novo no catálogo é venda que não fecha.
    const availableItems = Array.from(map.values()).filter(item => {
      return Object.values(item.docs).some(doc => availableQuantity(doc) > 0);
    });

    return availableItems.sort((a, b) => a.sku.localeCompare(b.sku));
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
          <p className="text-slate-500 font-bold text-sm uppercase tracking-wider">Carregando Catálogo...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans pb-16">
      
      {/* HEADER DE LOJA VIRTUAL */}
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 px-6 py-12 shadow-xl relative overflow-hidden">
        {/* Detalhe de fundo */}
        <div className="absolute top-0 right-0 -mt-16 -mr-16 opacity-10">
          <CircleDashed size={256} className="text-white animate-spin-slow" />
        </div>
        
        <div className="max-w-6xl mx-auto relative z-10 flex flex-col items-center text-center">
          <h1 className="text-3xl md:text-5xl font-black text-white uppercase tracking-tight mb-3">
            Catálogo de Pneus
          </h1>
          <p className="text-slate-300 font-medium text-sm md:text-base max-w-xl mb-8">
            Consulte nossa disponibilidade em tempo real e encontre a medida perfeita.
          </p>
          
          {/* BARRA DE PESQUISA GRANDE */}
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-lg p-2 flex items-center border border-transparent focus-within:border-gold-500 focus-within:ring-4 focus-within:ring-gold-500/20 transition-all">
            <Search size={24} className="text-slate-400 mx-3" />
            <input 
              type="text" 
              placeholder="Digite a medida, marca ou modelo..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full outline-none text-base md:text-lg text-slate-800 bg-transparent font-semibold py-2"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm("")} className="px-4 text-xs font-bold text-slate-400 hover:text-slate-700">
                LIMPAR
              </button>
            )}
          </div>
        </div>
      </div>

      {/* RESULTADOS / GRID DE PRODUTOS */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 mt-10">
        
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-700">
            {filteredItems.length} {filteredItems.length === 1 ? 'Produto Encontrado' : 'Produtos Encontrados'}
          </h2>
        </div>

        {filteredItems.length === 0 ? (
          <div className="bg-white rounded-3xl p-16 text-center shadow-sm border border-slate-200">
            <Package size={48} className="mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-bold text-slate-700 mb-2">Pneu não encontrado</h3>
            <p className="text-slate-500 font-medium">Não temos essa medida ou modelo disponível no momento.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            
            {filteredItems.map((item) => (
              <div key={item.sku} className="bg-white rounded-3xl overflow-hidden shadow-sm hover:shadow-xl border border-slate-200 transition-all duration-300 group flex flex-col h-full">
                
                {/* Imagem / Topo do Card */}
                <div className="bg-slate-50 h-32 flex items-center justify-center border-b border-slate-100 relative overflow-hidden">
                  <div className="absolute top-3 left-3 bg-white px-2 py-1 rounded-lg text-[10px] font-mono font-bold text-slate-400 border border-slate-200 shadow-sm">
                    {item.sku}
                  </div>
                  <CircleDashed size={64} className="text-slate-200 group-hover:text-gold-300 transition-colors duration-500" />
                </div>

                {/* Info do Produto */}
                <div className="p-5 flex-grow flex flex-col">
                  {/* Marca e Modelo */}
                  <div className="mb-1 text-xs font-black text-slate-400 uppercase tracking-widest truncate">
                    {item.brand}
                  </div>
                  {/* Tamanho Gigante */}
                  <h3 className="text-2xl font-black text-slate-900 tracking-tight leading-none mb-1">
                    {item.size}
                  </h3>
                  <div className="text-sm font-semibold text-slate-600 mb-5 truncate">
                    {item.model}
                  </div>

                  {/* Etiquetas de Estoque (Lojas) */}
                  <div className="space-y-2 mt-auto">
                    <div className="flex items-center text-[10px] font-black uppercase text-slate-400 tracking-wider mb-2">
                      <Store size={12} className="mr-1" /> Disponibilidade
                    </div>
                    {companies.map(comp => {
                      const qty = availableQuantity(item.docs[comp.id]);
                      if (qty === 0) return null; // Só exibe filiais que tem o pneu livre

                      return (
                        <div key={comp.id} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-xl border border-slate-100">
                          <span className="text-xs font-bold text-slate-600 truncate mr-2">{comp.name}</span>
                          <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-lg text-[10px] font-black whitespace-nowrap">
                            {qty} UN
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Rodapé: Preços */}
                {(item.priceCash > 0 || item.priceInstallment > 0) && (
                  <div className="bg-gradient-to-r from-gold-50/50 to-amber-50/50 p-5 border-t border-gold-100">
                    <div className="flex justify-between items-end">
                      {item.priceCash > 0 && (
                        <div>
                          <div className="text-[10px] font-bold uppercase text-gold-700 tracking-wider">À Vista</div>
                          <div className="text-lg font-black text-emerald-700 leading-none mt-1">
                            R$ {item.priceCash.toFixed(2).replace(".", ",")}
                          </div>
                        </div>
                      )}
                      
                      {item.priceInstallment > 0 && (
                        <div className="text-right">
                          <div className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">A Prazo</div>
                          <div className="text-base font-black text-slate-800 leading-none mt-1">
                            R$ {item.priceInstallment.toFixed(2).replace(".", ",")}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}

          </div>
        )}
      </div>

    </div>
  );
}
