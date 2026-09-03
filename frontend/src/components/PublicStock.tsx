import React, { useState, useEffect, useMemo } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { StockItem, Company, Suggestion, CLIENTE_COMPANY_ID } from "../types";
import { Search, Loader2, CircleDashed, Package, Store, ShoppingBag, Send, X, Lock, Lightbulb, Check, Archive } from "lucide-react";
import { availableQuantity, formatDate, mapStockDoc, mapSuggestionDoc, matchesTireSize, reservedQuantityOf, suggestionTime } from "../utils";

interface ConsolidatedItem {
  sku: string;
  description: string;
  brand: string;
  model: string;
  size: string;
  docs: Record<string, StockItem>;

  // O MESMO pneu custa valores diferentes em cada filial, e o preço mora no
  // documento de estoque de cada uma — não na ficha. Por isso aqui não existe
  // "o preço do pneu": existe o da loja mais barata, para o "a partir de" do
  // rodapé, e um aviso de que as outras cobram diferente.
  cheapestDoc: StockItem | null;
  priceVaries: boolean;
}

// Leitura tolerante de preço: documentos antigos só têm o campo legado `price`,
// e um pneu sem preço a prazo próprio é vendido pelo valor à vista.
function cashPriceOf(doc?: StockItem | null): number {
  return doc ? doc.priceCash || doc.price || 0 : 0;
}

function installmentPriceOf(doc?: StockItem | null): number {
  return doc ? doc.priceInstallment || cashPriceOf(doc) : 0;
}

function formatPrice(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

interface PublicStockProps {
  // Ausente na rota pública (consulta sem login): sem usuário, a tela é só
  // catálogo. Com um vendedor logado, cada loja ganha o botão de reservar.
  user?: { uid: string; displayName: string; role: string; companyId?: string; companyName?: string };
  onCreateTransfer?: (data: any) => Promise<void>;
  // Recado de compra para o dono da loja: o pneu que o cliente pediu e o
  // catálogo não tem. Ausente na rota pública, pela mesma razão do de cima.
  onCreateSuggestion?: (data: {
    companyId: string;
    companyName: string;
    size: string;
    brand?: string;
    model?: string;
    quantity: number;
    customerName?: string;
    customerContact?: string;
    note?: string;
  }) => Promise<void>;
}

export default function PublicStock({ user, onCreateTransfer, onCreateSuggestion }: PublicStockProps = {}) {
  const [stock, setStock] = useState<StockItem[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  
  const [reserveTarget, setReserveTarget] = useState<{ item: ConsolidatedItem, companyId: string, companyName: string, sourceStockItemId: string, maxQty: number, own: boolean } | null>(null);
  const [reserveQty, setReserveQty] = useState(1);
  const [reserveCustomer, setReserveCustomer] = useState("");
  const [reserveNote, setReserveNote] = useState("");
  const [reserveLoading, setReserveLoading] = useState(false);
  const [reserveError, setReserveError] = useState("");
  const [reserveDone, setReserveDone] = useState("");

  // ── Sugestão de compra ────────────────────────────────────────────
  // O cliente pediu, o catálogo não tinha, e o vendedor é a única pessoa que
  // ouviu. Sem isto a informação morre no balcão: o dono da loja compra pelo
  // que vendeu, nunca pelo que deixou de vender.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestCompanyId, setSuggestCompanyId] = useState("");
  const [suggestSize, setSuggestSize] = useState("");
  const [suggestBrand, setSuggestBrand] = useState("");
  const [suggestModel, setSuggestModel] = useState("");
  const [suggestQty, setSuggestQty] = useState(4);
  const [suggestCustomer, setSuggestCustomer] = useState("");
  const [suggestContact, setSuggestContact] = useState("");
  const [suggestNote, setSuggestNote] = useState("");
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState("");
  const [suggestDone, setSuggestDone] = useState("");

  // O que ESTE vendedor já mandou, com o desfecho que o dono deu. Carregado só
  // enquanto o painel está aberto — é a diferença entre uma leitura por clique
  // e um listener aceso a sessão inteira numa tela que quase nunca é aberta.
  const [mySuggestions, setMySuggestions] = useState<Suggestion[]>([]);
  const [mySuggestionsLoading, setMySuggestionsLoading] = useState(false);

  // Quem pode separar um pneu para um cliente. O vendedor é o caso normal; o
  // admin entra junto porque ele também enxerga esta aba (e as regras do
  // Firestore o autorizam a criar o pedido).
  const canReserve = !!onCreateTransfer && (user?.role === "vendedor" || user?.role === "admin");

  // Quem manda sugestão. O vendedor é o caso que motiva a tela; o admin entra
  // junto porque enxerga esta aba e também atende cliente no balcão.
  const canSuggest = !!onCreateSuggestion && (user?.role === "vendedor" || user?.role === "admin");

  // ── Pneu reservado: quem vê ──────────────────────────────────────
  // Para QUEM ESTÁ LOGADO, um pneu preso por uma reserva continua na tela, com
  // o selo de reservado: é isso que faz "o vendedor reservou" ser visível para
  // todo mundo, e é o que evita a pergunta "cadê o pneu que estava aqui?".
  // Na rota pública (cliente final, sem login) ele some, como antes: anunciar
  // ao consumidor um pneu que já tem dono é oferecer o que não dá para vender.
  const showReserved = !!user;

  // A loja do vendedor. Vazio quando a credencial foi criada com "Todas as
  // Empresas" — aí não existe loja "da casa" e todo pedido é uma solicitação.
  const ownCompanyId = user?.companyId || "";
  const isOwnStore = (companyId: string) => !!ownCompanyId && companyId === ownCompanyId;

  // ── Loja em foco ──────────────────────────────────────────────────
  // Qual filial o vendedor quer ver primeiro. Começa na loja dele: é lá que ele
  // vende no dia a dia, e é o único lugar onde o pedido não depende de outra
  // filial. Vazio = nenhuma em foco, tudo em ordem alfabética.
  const [focusCompanyId, setFocusCompanyId] = useState<string>(ownCompanyId);

  // "Só esta loja": esconde as outras filiais em vez de apenas rebaixá-las.
  // Nasce desligado de propósito — parte do trabalho do vendedor é achar, em
  // OUTRA filial, o pneu que a dele não tem, para abrir a solicitação. Ligado,
  // a tela vira o estoque de uma empresa só.
  const [onlyFocusStore, setOnlyFocusStore] = useState(false);

  // A loja em foco pode sumir da lista (renomeada, apagada). Sem isto a tela
  // ficaria ordenada por uma empresa que não existe mais, sem explicação.
  useEffect(() => {
    if (focusCompanyId && companies.length > 0 && !companies.some(c => c.id === focusCompanyId)) {
      setFocusCompanyId("");
    }
    if (!focusCompanyId && onlyFocusStore) setOnlyFocusStore(false);
  }, [companies, focusCompanyId, onlyFocusStore]);

  // A loja em foco encabeça a disponibilidade dentro de cada ficha.
  const orderedCompanies = useMemo(() => {
    if (!focusCompanyId) return companies;
    return [...companies].sort((a, b) => {
      const rank = (id: string) => (id === focusCompanyId ? 0 : 1);
      return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
    });
  }, [companies, focusCompanyId]);

  const openReserveModal = (target: { item: ConsolidatedItem, companyId: string, companyName: string, sourceStockItemId: string, maxQty: number, own: boolean }) => {
    setReserveTarget(target);
    setReserveQty(1);
    setReserveCustomer("");
    setReserveNote("");
    setReserveError("");
  };

  const submitReserve = async () => {
    if (!onCreateTransfer || !reserveTarget) return;
    const qty = Number(reserveQty);
    if (!Number.isInteger(qty) || qty < 1) {
      setReserveError("Informe uma quantidade de pelo menos 1 un.");
      return;
    }
    if (qty > reserveTarget.maxQty) {
      setReserveError(`${reserveTarget.companyName} tem só ${reserveTarget.maxQty} un livres deste pneu.`);
      return;
    }
    if (!reserveCustomer.trim()) {
      setReserveError("Informe o nome do cliente — é ele que aparece no pedido da loja.");
      return;
    }

    setReserveLoading(true);
    setReserveError("");
    try {
      await onCreateTransfer({
        items: [{
          sourceStockItemId: reserveTarget.sourceStockItemId,
          sku: reserveTarget.item.sku,
          brand: reserveTarget.item.brand,
          model: reserveTarget.item.model,
          size: reserveTarget.item.size,
          quantity: qty
        }],
        sourceCompanyId: reserveTarget.companyId,
        sourceCompanyName: reserveTarget.companyName,
        destinationCompanyId: CLIENTE_COMPANY_ID,
        destinationCompanyName: "Cliente final",
        customerName: reserveCustomer.trim(),
        reason: reserveNote.trim(),
        scheduledFor: null,
        requestKind: "SOLICITACAO"
      });
      setReserveDone(
        reserveTarget.own
          ? `Pneu RESERVADO em ${reserveTarget.companyName}. Ele já saiu do saldo disponível e ` +
            `aparece como reservado para todas as lojas. Falta só o dono da loja confirmar — ` +
            `é a confirmação que dá a baixa e fecha a venda.`
          : `Pneu RESERVADO em ${reserveTarget.companyName} e já bloqueado para outras vendas. ` +
            `Como ele é de outra filial, o pedido vira uma TRANSFERÊNCIA e depende de dois avais: ` +
            `o do dono daquela loja e o do administrador.`
      );
      setReserveTarget(null);
    } catch (err: any) {
      setReserveError(err?.message || "Erro ao enviar a reserva.");
    } finally {
      setReserveLoading(false);
    }
  };

  // Abre o painel já preenchido com o que o vendedor acabou de digitar na
  // busca: a sugestão nasce exatamente do termo que não devolveu nada, e
  // redigitar "205/55 R16" é o passo em que a pessoa desiste de registrar.
  const openSuggestModal = () => {
    setSuggestCompanyId(ownCompanyId || "ALL");
    setSuggestSize(searchTerm.trim());
    setSuggestBrand("");
    setSuggestModel("");
    setSuggestQty(4);
    setSuggestCustomer("");
    setSuggestContact("");
    setSuggestNote("");
    setSuggestError("");
    setSuggestOpen(true);
  };

  const submitSuggestion = async () => {
    if (!onCreateSuggestion) return;
    const size = suggestSize.trim();
    if (!size) {
      setSuggestError("Informe a medida do pneu que o cliente procurou.");
      return;
    }
    if (!suggestCompanyId) {
      setSuggestError("Escolha a loja que deve receber esta sugestão.");
      return;
    }
    const qty = Number(suggestQty);
    if (!Number.isInteger(qty) || qty < 1) {
      setSuggestError("Informe quantas unidades o cliente queria (pelo menos 1).");
      return;
    }

    setSuggestLoading(true);
    setSuggestError("");
    try {
      const isAll = suggestCompanyId === "ALL";
      const company = companies.find(c => c.id === suggestCompanyId);
      const companyName = isAll ? "Todas as Lojas" : (company?.name || user?.companyName || "");

      await onCreateSuggestion({
        companyId: suggestCompanyId,
        companyName,
        size,
        brand: suggestBrand,
        model: suggestModel,
        quantity: qty,
        customerName: suggestCustomer,
        customerContact: suggestContact,
        note: suggestNote
      });
      setSuggestOpen(false);
      setSuggestDone(
        isAll
          ? `Sugestão enviada para TODAS as lojas. Ela aparece na aba Sugestões de todos os donos de empresa e administradores.`
          : `Sugestão enviada para ${company?.name || "a loja"}. Ela aparece na aba Sugestões do dono da loja, com a medida, o cliente e o seu nome. Nenhum pneu foi reservado — isto é um recado de compra.`
      );
    } catch (err: any) {
      setSuggestError(err?.message || "Erro ao enviar a sugestão.");
    } finally {
      setSuggestLoading(false);
    }
  };

  // Listener das PRÓPRIAS sugestões, ligado só com o painel aberto. Uma
  // igualdade em requestedByUid — mesma forma que as regras do Firestore
  // autorizam para quem escreveu, e sem índice composto.
  useEffect(() => {
    if (!suggestOpen || !user?.uid) {
      setMySuggestions([]);
      return;
    }
    setMySuggestionsLoading(true);
    const unsub = onSnapshot(
      query(collection(db, "suggestions"), where("requestedByUid", "==", user.uid)),
      (snapshot) => {
        const list: Suggestion[] = [];
        snapshot.forEach(docSnap => list.push(mapSuggestionDoc(docSnap.id, docSnap.data())));
        list.sort((a, b) => suggestionTime(b) - suggestionTime(a));
        setMySuggestions(list);
        setMySuggestionsLoading(false);
      },
      (error) => {
        console.error("Erro ao ler as sugestões do vendedor:", error);
        setMySuggestionsLoading(false);
      }
    );
    return unsub;
  }, [suggestOpen, user?.uid]);

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
        itemsList.push(mapStockDoc(docSnap.id, data));
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
          cheapestDoc: null,
          priceVaries: false,
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
      
    });

    // "Disponível" aqui é o saldo LIVRE: pneu reservado já tem dono, e prometê-lo
    // de novo no catálogo é venda que não fecha. Por isso o cliente final (sem
    // login) não o vê. Quem está logado vê — com o selo de reservado —, porque
    // para a equipe a informação útil é justamente que o pneu existe e está
    // separado, não que ele sumiu.
    const availableItems = Array.from(map.values()).filter(item => {
      return Object.values(item.docs).some(
        doc => availableQuantity(doc) > 0 || (showReserved && reservedQuantityOf(doc) > 0)
      );
    });

    // O "a partir de" do rodapé sai da loja mais barata ENTRE AS QUE APARECEM —
    // ou seja, só as que têm o pneu livre. Anunciar o preço de uma filial que
    // está sem estoque é oferecer o que não dá para vender.
    //
    // ANTES daqui saía o MAIOR preço entre todas as filiais, exibido como se
    // fosse o preço do pneu: quem comprava na loja mais barata via o valor da
    // mais cara.
    return availableItems
      .map(item => {
        const inStock = Object.values(item.docs).filter(doc => availableQuantity(doc) > 0);
        const cheapestDoc = inStock.reduce<StockItem | null>(
          (best, doc) => (!best || cashPriceOf(doc) < cashPriceOf(best) ? doc : best),
          null
        );
        const priceVaries = inStock.length > 1 && inStock.some(
          doc =>
            cashPriceOf(doc) !== cashPriceOf(cheapestDoc) ||
            installmentPriceOf(doc) !== installmentPriceOf(cheapestDoc)
        );
        return { ...item, cheapestDoc, priceVaries };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }, [stock, companies, showReserved]);

  const filteredItems = useMemo(() => {
    const lower = searchTerm.toLowerCase();
    const matched = !searchTerm
      ? consolidatedItems
      : consolidatedItems.filter(item =>
          item.sku.toLowerCase().includes(lower) ||
          item.description.toLowerCase().includes(lower) ||
          item.brand.toLowerCase().includes(lower) ||
          item.size.toLowerCase().includes(lower) ||
          matchesTireSize(item.size, lower)
        );

    if (!focusCompanyId) return matched;

    // Modo exclusivo: some com o que a loja em foco não tem. Para quem está
    // logado, "tem" inclui o que está reservado — some só o que ela realmente
    // não possui, senão a reserva desapareceria justo da tela da própria loja.
    if (onlyFocusStore) {
      return matched.filter(item => {
        const doc = item.docs[focusCompanyId];
        if (!doc) return false;
        return availableQuantity(doc) > 0 || (showReserved && reservedQuantityOf(doc) > 0);
      });
    }

    // Com uma loja em foco, o que ELA tem livre sobe para o começo da lista.
    // São centenas de produtos e a maioria só existe numa filial: sem isto o
    // vendedor rola o catálogo inteiro atrás do que consegue vender hoje.
    // Nada é escondido — as outras filiais continuam logo abaixo.
    const hasFree = (item: ConsolidatedItem) => {
      const doc = item.docs[focusCompanyId];
      if (doc && availableQuantity(doc) > 0) return 0;
      // Reservado fica no meio: interessa mais que o pneu de outra filial (é da
      // casa, dá para checar com quem reservou), e menos que o que está livre.
      if (doc && showReserved && reservedQuantityOf(doc) > 0) return 1;
      return 2;
    };
    return [...matched].sort((a, b) => hasFree(a) - hasFree(b) || a.sku.localeCompare(b.sku));
  }, [consolidatedItems, searchTerm, focusCompanyId, onlyFocusStore, showReserved]);

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
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 px-6 py-8 md:py-10 shadow-xl relative overflow-hidden">
        {/* Detalhe de fundo */}
        <div className="absolute top-0 right-0 -mt-16 -mr-16 opacity-10">
          <CircleDashed size={256} className="text-white animate-spin-slow" />
        </div>
        
        <div className="max-w-6xl mx-auto relative z-10 flex flex-col items-center text-center">
          <h1 className="text-2xl md:text-4xl font-black text-white uppercase tracking-tight mb-2">
            Catálogo de Pneus
          </h1>
          <p className="text-slate-300 font-medium text-xs md:text-sm max-w-xl mb-6">
            Consulte nossa disponibilidade em tempo real e encontre a medida perfeita.
          </p>
          
          {/* BARRA DE PESQUISA GRANDE */}
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-lg p-1.5 flex items-center border border-transparent focus-within:border-gold-500 focus-within:ring-4 focus-within:ring-gold-500/20 transition-all">
            <Search size={20} className="text-slate-400 mx-2.5" />
            <input 
              type="text" 
              placeholder="Digite a medida, marca ou modelo..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full outline-none text-sm md:text-base text-slate-800 bg-transparent font-semibold py-1.5"
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
      <div className="max-w-7xl mx-auto px-4 md:px-6 mt-6">
        
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-600">
            {filteredItems.length} {filteredItems.length === 1 ? 'Produto Encontrado' : 'Produtos Encontrados'}
          </h2>
          {/* Sempre visível, não só quando a busca zera: metade dos pedidos que
              o estoque não atende aparece no meio de uma lista cheia ("tem essa
              medida, mas na marca X"). */}
          {canSuggest && (
            <button
              type="button"
              onClick={openSuggestModal}
              title="Registrar um pneu que o cliente procurou e a loja não tem"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-gold-300 bg-gold-50 text-gold-800 hover:bg-gold-100 text-[11px] font-black uppercase tracking-wider transition-all cursor-pointer"
            >
              <Lightbulb size={13} /> Sugerir compra
            </button>
          )}
        </div>

        {/* ── Loja em foco ────────────────────────────────────────────────
            Só para quem está logado: no catálogo público (rota /consulta) o
            cliente não escolhe filial, ele procura o pneu.

            Isto ORDENA, não esconde: a loja escolhida sobe para o topo de cada
            ficha e os pneus que ela tem livres vêm primeiro na lista. As outras
            filiais continuam logo abaixo, porque o vendedor também precisa
            enxergá-las para solicitar o que a dele não tem. */}
        {user && companies.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5 bg-white border border-slate-200 rounded-2xl px-3 py-2.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1 flex items-center gap-1">
              <Store size={12} className="text-gold-600" /> Ver primeiro
            </span>

            {companies.map(comp => {
              const active = focusCompanyId === comp.id;
              const own = isOwnStore(comp.id);
              return (
                <button
                  key={comp.id}
                  type="button"
                  onClick={() => setFocusCompanyId(active ? "" : comp.id)}
                  title={active
                    ? "Clique de novo para voltar à ordem alfabética"
                    : `Mostrar primeiro os pneus de ${comp.name}`}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer flex items-center gap-1 ${
                    active
                      ? "bg-gold-600 text-white border-gold-600 shadow-sm"
                      : own
                      ? "bg-gold-50 text-gold-800 border-gold-200 hover:bg-gold-100"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  {comp.name}
                  {own && (
                    <span className={`text-[8px] font-bold normal-case tracking-normal ${active ? "text-white/75" : "text-gold-600"}`}>
                      sua loja
                    </span>
                  )}
                </button>
              );
            })}

            {focusCompanyId && (
              <>
                <span className="mx-0.5 h-4 w-px bg-slate-200" aria-hidden />
                <button
                  type="button"
                  onClick={() => setOnlyFocusStore(v => !v)}
                  title={onlyFocusStore
                    ? "Voltar a mostrar as outras filiais (logo abaixo desta)"
                    : "Esconder as outras filiais e ver só o estoque desta loja"}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer ${
                    onlyFocusStore
                      ? "bg-slate-900 text-gold-400 border-slate-900 shadow-sm"
                      : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  {onlyFocusStore ? "✓ Só esta loja" : "Só esta loja"}
                </button>
                <button
                  type="button"
                  onClick={() => { setFocusCompanyId(""); setOnlyFocusStore(false); }}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-slate-400 hover:text-slate-700 hover:bg-slate-50 border border-transparent transition-all cursor-pointer"
                >
                  Limpar
                </button>
              </>
            )}
          </div>
        )}

        {filteredItems.length === 0 ? (
          <div className="bg-white rounded-3xl p-16 text-center shadow-sm border border-slate-200">
            <Package size={48} className="mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-bold text-slate-700 mb-2">Pneu não encontrado</h3>
            <p className="text-slate-500 font-medium">Não temos essa medida ou modelo disponível no momento.</p>
            {/* É exatamente aqui que a venda é perdida — e o único instante em
                que o vendedor ainda tem o cliente na frente dele para anotar a
                medida e o telefone. */}
            {canSuggest && (
              <div className="mt-6 max-w-md mx-auto bg-gold-50 border border-gold-200 rounded-2xl p-4">
                <p className="text-xs font-bold text-gold-800 mb-3">
                  O cliente está procurando este pneu? Avise o dono da loja — a medida entra na
                  lista de compras dele.
                </p>
                <button
                  type="button"
                  onClick={openSuggestModal}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gold-600 text-white font-black text-xs uppercase tracking-wider hover:bg-gold-700 transition-all cursor-pointer"
                >
                  <Lightbulb size={14} /> Sugerir compra deste pneu
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            
            {filteredItems.map((item) => {
              // Quanto deste pneu está reservado, somando todas as filiais. Serve
              // para o cartão INTEIRO mudar de cor: numa grade de dezenas de
              // cartões, ninguém lê linha por linha — a borda âmbar é o que
              // entrega "tem reserva aqui" antes de a pessoa abrir o cartão.
              const itemReserved = showReserved
                ? Object.values(item.docs).reduce<number>((acc, doc) => acc + reservedQuantityOf(doc), 0)
                : 0;

              return (
              // Cartão compacto: sem foto (o estoque não tem imagem de pneu, e o
              // placeholder só ocupava 128px de altura em cada cartão). A hierarquia
              // é a que o vendedor usa para achar o pneu: medida > marca > modelo.
              <div
                key={item.sku}
                className={`rounded-2xl border shadow-xs hover:shadow-md transition-all flex flex-col ${
                  itemReserved > 0
                    ? "bg-amber-50/40 border-amber-300 hover:border-amber-400"
                    : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                {/* Cabeçalho: SKU, a medida em destaque e o nome do pneu.
                    A MARCA desceu para junto do modelo. Ela estava sozinha numa
                    linha no topo, disputando atenção com a medida e sobrando
                    espaço à direita — e "SMART CHASER" e "SC1" são as duas
                    metades do MESMO nome: separadas, ninguém lia como um nome só.
                    Juntas ("SMART CHASER SC1") a ficha volta a ter uma hierarquia
                    de três degraus: código > medida > nome. */}
                <div className="px-4 pt-3.5 pb-3">
                  {/* O SKU agora ocupa a linha inteira e o selo de reserva cabe ao
                      lado dele — antes um escondia o outro, porque a marca comia
                      metade da largura. */}
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span
                      title={item.sku}
                      className="min-w-0 truncate font-mono text-[9px] text-slate-400 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5"
                    >
                      {item.sku}
                    </span>
                    {itemReserved > 0 && (
                      <span
                        title={`${itemReserved} un deste pneu estão reservadas para clientes.`}
                        className="shrink-0 inline-flex items-center gap-0.5 bg-amber-500 text-white border border-amber-600 rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider shadow-sm"
                      >
                        <Lock size={9} className="stroke-[3px]" /> {itemReserved} reservado{itemReserved > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>

                  <h3 className="text-xl font-black text-slate-900 tracking-tight leading-none">
                    {item.size}
                  </h3>

                  {/* Marca + modelo numa linha só. Quebra em duas linhas em vez de
                      truncar: num cartão de ~200px, "SMART CHASER SC1" cortado em
                      "SMART CHAS…" esconde justamente o que identifica o pneu. */}
                  <div
                    className="mt-1 text-[11px] leading-snug break-words"
                    title={`${item.brand} ${item.model}`.trim()}
                  >
                    <span className="font-black uppercase tracking-wide text-slate-600">{item.brand}</span>
                    {item.model && item.model.trim().toLowerCase() !== item.brand.trim().toLowerCase() && (
                      <span className="font-semibold text-slate-500"> {item.model}</span>
                    )}
                  </div>
                </div>

                {/* Disponibilidade por loja */}
                <div className="px-4 pb-3 flex-grow">
                  <div className="flex items-center text-[9px] font-black uppercase text-slate-400 tracking-wider mb-1.5">
                    <Store size={11} className="mr-1" /> Disponibilidade
                  </div>

                  <div className="space-y-1">
                    {orderedCompanies.map(comp => {
                      // No modo exclusivo a ficha mostra só a loja em foco: deixar
                      // as outras aqui seria dizer "só esta loja" e listar as demais.
                      if (onlyFocusStore && comp.id !== focusCompanyId) return null;

                      const stockDoc = item.docs[comp.id];
                      const qty = stockDoc ? availableQuantity(stockDoc) : 0;
                      const reserved = showReserved ? reservedQuantityOf(stockDoc) : 0;
                      // Sem saldo livre E sem reserva não há o que mostrar. Com
                      // reserva a linha fica: o pneu existe, está separado para
                      // um cliente, e quem vê precisa saber disso.
                      if (qty === 0 && reserved === 0) return null;
                      const fullyReserved = qty === 0 && reserved > 0;
                      // Reservado manda na cor da linha: o âmbar vence o destaque
                      // dourado da própria loja de propósito. "Este pneu tem dono"
                      // é a informação que muda a conversa com o cliente — "esta é
                      // a sua filial" o vendedor já sabe.

                      // Pneu da própria loja: uma confirmação do dono da casa e
                      // vira venda. Pneu de outra filial: vira transferência e
                      // depende de dois avais. Nos dois casos o pneu é bloqueado
                      // na hora — o que muda é quem decide o destino dele.
                      const own = isOwnStore(comp.id);

                      // O preço é DESTA filial. Duas lojas com o mesmo pneu
                      // cobram valores diferentes, e é esse número que vale para
                      // quem for comprar aqui.
                      const cash = cashPriceOf(stockDoc);
                      const installment = installmentPriceOf(stockDoc);

                      return (
                        <div
                          key={comp.id}
                          className={`flex flex-col gap-1 pl-2 pr-1.5 py-1.5 rounded-lg border-l-4 border ${
                            reserved > 0
                              ? "bg-amber-100/80 border-amber-300 border-l-amber-500"
                              : own
                              ? "bg-gold-50/70 border-gold-200 border-l-gold-400"
                              : "bg-slate-50 border-slate-100 border-l-slate-200"
                          }`}
                        >
                          {/* O nome da loja ocupa a linha inteira, com a
                              quantidade ao lado. ANTES ele dividia a linha com a
                              quantidade E o botao: numa ficha de ~200px sobravam
                              uns 50px, e "CENTRAL AUTOCENTER" virava "Central …".
                              Sem `truncate` ele quebra em duas linhas em vez de
                              esconder o que identifica o dono do pneu. */}
                          <div className="flex items-start gap-1.5">
                            <span
                              title={own ? `${comp.name} — sua loja` : comp.name}
                              className={`flex-1 min-w-0 break-words leading-tight text-[11px] font-black uppercase tracking-wide ${
                                own ? "text-gold-800" : "text-slate-700"
                              }`}
                            >
                              {comp.name}
                            </span>

                            <div className="shrink-0 flex items-center gap-1">
                              {qty > 0 && (
                                <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 px-1.5 py-0.5 rounded text-[10px] font-black whitespace-nowrap">
                                  {qty} un
                                </span>
                              )}
                              {reserved > 0 && (
                                <span
                                  title={`${reserved} un reservadas para clientes — presas no estoque até a loja confirmar ou recusar a reserva.`}
                                  className="inline-flex items-center gap-0.5 bg-amber-500 text-white border border-amber-600 px-1.5 py-0.5 rounded text-[10px] font-black whitespace-nowrap shadow-sm"
                                >
                                  <Lock size={9} className="stroke-[3px]" /> {reserved} reserv.
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Preco desta loja e a acao, dividindo a segunda
                              linha — que e larga porque o nome saiu dela. */}
                          <div className="flex items-center justify-between gap-1.5">
                            {cash > 0 ? (
                              <span className="min-w-0 truncate text-[10px] font-bold text-emerald-700">
                                {formatPrice(cash)}
                                {installment > 0 && installment !== cash && (
                                  <span className="font-semibold text-slate-400">
                                    {" "}· {formatPrice(installment)} a prazo
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-300">Sem preço</span>
                            )}

                            {fullyReserved && (
                              <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 border border-amber-400 text-[9px] font-black uppercase tracking-wider">
                                Todo reservado
                              </span>
                            )}

                            {canReserve && qty > 0 && (
                              <button
                                type="button"
                                onClick={() => openReserveModal({
                                  item,
                                  companyId: comp.id,
                                  companyName: comp.name,
                                  sourceStockItemId: stockDoc.id,
                                  maxQty: qty,
                                  own
                                })}
                                title={
                                  own
                                    ? `Reservar este pneu para um cliente — ele fica preso na hora, e o dono de ${comp.name} confirma a baixa`
                                    : `Reservar este pneu de ${comp.name} — ele fica preso na hora, e vira transferência com o aval daquela loja e do administrador`
                                }
                                className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] font-black transition-colors cursor-pointer ${
                                  own
                                    ? "bg-gold-600 text-white hover:bg-gold-700"
                                    : "bg-white text-slate-600 border border-slate-300 hover:bg-slate-100 hover:text-slate-900"
                                }`}
                              >
                                {own ? <ShoppingBag size={11} /> : <Send size={11} />}
                                {own ? "Reservar" : "Solicitar"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Rodapé: o menor preço entre as lojas que têm o pneu.
                    Com filiais cobrando valores diferentes ele vira "a partir
                    de" — o preço exato de cada uma está na linha dela acima. */}
                {cashPriceOf(item.cheapestDoc) > 0 && (
                  <div className="flex items-end justify-between gap-2 px-4 py-2.5 border-t border-gold-100 bg-gradient-to-r from-gold-50/60 to-amber-50/40 rounded-b-2xl">
                    <div className="min-w-0">
                      <div className="text-[9px] font-bold uppercase text-gold-700 tracking-wider leading-none">
                        {item.priceVaries ? "À vista a partir de" : "À Vista"}
                      </div>
                      <div className="text-base font-black text-emerald-700 leading-none mt-1 truncate">
                        {formatPrice(cashPriceOf(item.cheapestDoc))}
                      </div>
                    </div>

                    {installmentPriceOf(item.cheapestDoc) > 0 && (
                      <div className="text-right min-w-0">
                        <div className="text-[9px] font-bold uppercase text-slate-500 tracking-wider leading-none">
                          {item.priceVaries ? "A prazo a partir de" : "A Prazo"}
                        </div>
                        <div className="text-sm font-black text-slate-800 leading-none mt-1 truncate">
                          {formatPrice(installmentPriceOf(item.cheapestDoc))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              );
            })}

          </div>
        )}
      </div>

      {/* ============ RESERVA PARA CLIENTE ============ */}
      {/* O pedido nasce SOLICITADO e JÁ SEGURA o pneu: a mesma gravação que cria
          a reserva soma reservedQuantity no estoque. O que falta depois disso não
          é o bloqueio, é a decisão — e ela é diferente nos dois casos, por isso os
          dois avisos abaixo. */}
      {reserveTarget && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h3 className="text-lg font-black text-slate-900 flex items-center gap-2">
                {reserveTarget.own ? (
                  <><ShoppingBag size={18} className="text-gold-600" /> Reservar para cliente</>
                ) : (
                  <><Send size={18} className="text-slate-500" /> Solicitar a outra loja</>
                )}
              </h3>
              <button
                type="button"
                onClick={() => setReserveTarget(null)}
                className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mb-4 space-y-1 text-sm text-slate-600 bg-slate-50 border border-slate-100 rounded-2xl p-3">
              <p className="font-bold text-slate-900">
                {reserveTarget.item.brand} {reserveTarget.item.model}{" "}
                <span className="font-mono text-slate-500">({reserveTarget.item.size})</span>
              </p>
              <p className="text-xs">
                <strong>Loja:</strong> {reserveTarget.companyName}{" "}
                {reserveTarget.own ? (
                  <span className="text-gold-700 font-bold">(sua loja)</span>
                ) : (
                  <span className="text-slate-500 font-bold">(outra filial)</span>
                )}
              </p>
              <p className="text-xs"><strong>Livre agora:</strong> {reserveTarget.maxQty} un</p>
              {/* O preço é o DESTA loja — a mesma que o pedido vai para. É aqui
                  que a filial é escolhida, então é aqui que o número importa. */}
              {cashPriceOf(reserveTarget.item.docs[reserveTarget.companyId]) > 0 && (
                <p className="text-xs">
                  <strong>Preço em {reserveTarget.companyName}:</strong>{" "}
                  <span className="font-black text-emerald-700">
                    {formatPrice(cashPriceOf(reserveTarget.item.docs[reserveTarget.companyId]))}
                  </span>
                  <span className="text-slate-400"> à vista</span>
                  {installmentPriceOf(reserveTarget.item.docs[reserveTarget.companyId]) !==
                    cashPriceOf(reserveTarget.item.docs[reserveTarget.companyId]) && (
                    <>
                      {" · "}
                      <span className="font-black text-slate-700">
                        {formatPrice(installmentPriceOf(reserveTarget.item.docs[reserveTarget.companyId]))}
                      </span>
                      <span className="text-slate-400"> a prazo</span>
                    </>
                  )}
                </p>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Quantidade</label>
                <input
                  type="number"
                  min={1}
                  max={reserveTarget.maxQty}
                  value={reserveQty}
                  onChange={(e) => { setReserveQty(parseInt(e.target.value) || 0); setReserveError(""); }}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Nome do cliente</label>
                <input
                  type="text"
                  value={reserveCustomer}
                  onChange={(e) => { setReserveCustomer(e.target.value); setReserveError(""); }}
                  placeholder="Ex: João da Silva"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                  Observação <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                </label>
                <input
                  type="text"
                  value={reserveNote}
                  onChange={(e) => setReserveNote(e.target.value)}
                  placeholder="Ex: troca marcada para sexta de manhã"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                />
              </div>
            </div>

            {reserveTarget.own ? (
              <p className="mt-4 text-[11px] bg-gold-50 border border-gold-200 text-gold-800 rounded-xl p-2.5">
                O pneu fica <strong>reservado na hora</strong> e marcado como tal para todas as lojas —
                ninguém mais consegue vendê-lo. A <strong>baixa no estoque</strong> só acontece quando o
                dono de {reserveTarget.companyName} confirmar a reserva.
              </p>
            ) : (
              <p className="mt-4 text-[11px] bg-blue-50 border border-blue-200 text-blue-900 rounded-xl p-2.5">
                Este pneu é de <strong>outra filial</strong>. Ele também fica{" "}
                <strong>reservado na hora</strong>, mas como precisa vir para cá o pedido entra como{" "}
                <strong>transferência</strong>: depende do aval do dono de {reserveTarget.companyName}{" "}
                <em>e</em> do administrador. Qualquer um dos dois pode recusar.
              </p>
            )}

            {reserveError && (
              <p className="mt-3 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                {reserveError}
              </p>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setReserveTarget(null)}
                disabled={reserveLoading}
                className="px-4 py-2 border border-slate-200 rounded-xl text-slate-500 font-bold hover:bg-slate-50 cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitReserve}
                disabled={reserveLoading}
                className="px-4 py-2 bg-gold-600 text-white rounded-xl font-bold hover:bg-gold-700 disabled:opacity-50 cursor-pointer inline-flex items-center gap-2"
              >
                {reserveLoading && <Loader2 size={14} className="animate-spin" />}
                {reserveLoading
                  ? "Enviando..."
                  : reserveTarget.own
                  ? "Confirmar reserva"
                  : "Enviar solicitação"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ SUGESTÃO DE COMPRA ============ */}
      {/* Não reserva, não trava saldo, não cria transferência: grava um recado
          endereçado ao dono de uma loja. O pneu nem existe no estoque — é
          justamente essa a informação. */}
      {suggestOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-lg font-black text-slate-900 flex items-center gap-2">
                  <Lightbulb size={18} className="text-gold-600" /> Sugerir compra
                </h3>
                <p className="text-[11px] text-slate-500 font-semibold mt-0.5">
                  O pneu que o cliente pediu e a loja não tem.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSuggestOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              {/* A loja é o endereço do recado. Já vem na do vendedor; ele só
                  escolhe quando a credencial dele não tem loja fixa. */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Loja que recebe</label>
                <select
                  value={suggestCompanyId}
                  onChange={(e) => { setSuggestCompanyId(e.target.value); setSuggestError(""); }}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400 text-sm font-semibold text-slate-800 bg-white cursor-pointer"
                >
                  <option value="">Selecione a loja...</option>
                  <option value="ALL">Todas as Lojas (Geral)</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}{isOwnStore(c.id) ? " (sua loja)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                  Medida <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={suggestSize}
                  onChange={(e) => { setSuggestSize(e.target.value); setSuggestError(""); }}
                  placeholder="Ex: 205/55 R16"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400 font-mono font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                    Marca <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                  </label>
                  <input
                    type="text"
                    value={suggestBrand}
                    onChange={(e) => setSuggestBrand(e.target.value)}
                    placeholder="Ex: Pirelli"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                    Modelo <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                  </label>
                  <input
                    type="text"
                    value={suggestModel}
                    onChange={(e) => setSuggestModel(e.target.value)}
                    placeholder="Ex: Cinturato P7"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Quantidade que o cliente queria</label>
                <div className="flex items-center gap-2">
                  {[1, 2, 4].map(n => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => { setSuggestQty(n); setSuggestError(""); }}
                      className={`px-3.5 py-2 rounded-xl text-xs font-black border transition-all cursor-pointer ${
                        suggestQty === n
                          ? "bg-slate-900 text-gold-400 border-slate-900"
                          : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      {n} un
                    </button>
                  ))}
                  <input
                    type="number"
                    min={1}
                    value={suggestQty}
                    onChange={(e) => { setSuggestQty(parseInt(e.target.value) || 0); setSuggestError(""); }}
                    className="w-20 px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400 text-sm font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                    Cliente <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                  </label>
                  <input
                    type="text"
                    value={suggestCustomer}
                    onChange={(e) => setSuggestCustomer(e.target.value)}
                    placeholder="Ex: João da Silva"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                    Contato <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                  </label>
                  <input
                    type="text"
                    value={suggestContact}
                    onChange={(e) => setSuggestContact(e.target.value)}
                    placeholder="Ex: (75) 99999-0000"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                  Observação <span className="text-slate-400 normal-case font-semibold">(opcional)</span>
                </label>
                <textarea
                  value={suggestNote}
                  onChange={(e) => setSuggestNote(e.target.value)}
                  rows={2}
                  placeholder="Ex: cliente leva os 4 se tiver até sexta; aceita outra marca na mesma medida"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-400 resize-none"
                />
              </div>
            </div>

            <p className="mt-4 text-[11px] bg-slate-50 border border-slate-200 text-slate-600 rounded-xl p-2.5">
              Isto <strong>não reserva pneu nenhum</strong> — é um recado de compra. Ele aparece na aba{" "}
              <strong>Sugestões</strong> do dono da loja com o seu nome, e você acompanha o desfecho aqui embaixo.
            </p>

            {suggestError && (
              <p className="mt-3 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-2.5">
                {suggestError}
              </p>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setSuggestOpen(false)}
                disabled={suggestLoading}
                className="px-4 py-2 border border-slate-200 rounded-xl text-slate-500 font-bold hover:bg-slate-50 cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitSuggestion}
                disabled={suggestLoading}
                className="px-4 py-2 bg-gold-600 text-white rounded-xl font-bold hover:bg-gold-700 disabled:opacity-50 cursor-pointer inline-flex items-center gap-2"
              >
                {suggestLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {suggestLoading ? "Enviando..." : "Enviar sugestão"}
              </button>
            </div>

            {/* ── O que eu já mandei ────────────────────────────────
                Fecha o ciclo para o vendedor: sem isto ele não sabe se o dono
                leu, e o cliente que ligar de volta ouve "vou verificar". */}
            <div className="mt-6 pt-5 border-t border-slate-100">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
                Minhas sugestões enviadas
              </h4>
              {mySuggestionsLoading ? (
                <div className="flex items-center gap-2 text-xs text-slate-400 font-semibold">
                  <Loader2 size={13} className="animate-spin" /> Carregando...
                </div>
              ) : mySuggestions.length === 0 ? (
                <p className="text-xs text-slate-400 font-semibold">
                  Você ainda não enviou nenhuma sugestão.
                </p>
              ) : (
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {mySuggestions.slice(0, 20).map(sug => (
                    <div
                      key={sug.id}
                      className="border border-slate-200 rounded-xl px-3 py-2 flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-black text-slate-800 font-mono truncate">
                          {sug.size}
                          <span className="font-sans font-bold text-slate-500 ml-1.5">
                            {sug.quantity} un
                          </span>
                        </p>
                        <p className="text-[10px] text-slate-400 font-semibold truncate">
                          {sug.companyName} · {formatDate(sug.createdAt)}
                        </p>
                        {sug.resolutionNote && (
                          <p className="text-[11px] text-emerald-800 font-bold mt-1">“{sug.resolutionNote}”</p>
                        )}
                      </div>
                      <span
                        className={`shrink-0 px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border inline-flex items-center gap-1 ${
                          sug.status === "ATENDIDA"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : sug.status === "ARQUIVADA"
                            ? "bg-slate-100 text-slate-500 border-slate-200"
                            : "bg-gold-50 text-gold-800 border-gold-200"
                        }`}
                      >
                        {sug.status === "ATENDIDA" ? (
                          <><Check size={9} /> Atendida</>
                        ) : sug.status === "ARQUIVADA" ? (
                          <><Archive size={9} /> Arquivada</>
                        ) : (
                          "Em aberto"
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirmação da sugestão enviada */}
      {suggestDone && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl text-center max-h-[90vh] overflow-y-auto">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-gold-50 border border-gold-200 flex items-center justify-center">
              <Lightbulb size={22} className="text-gold-600" />
            </div>
            <h3 className="text-base font-black text-slate-900 mb-2">Sugestão enviada</h3>
            <p className="text-sm text-slate-600">{suggestDone}</p>
            <button
              type="button"
              onClick={() => setSuggestDone("")}
              className="mt-5 w-full px-4 py-2 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 cursor-pointer"
            >
              Entendi
            </button>
          </div>
        </div>
      )}

      {/* Confirmação da reserva enviada */}
      {reserveDone && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl text-center max-h-[90vh] overflow-y-auto">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center">
              <ShoppingBag size={22} className="text-emerald-600" />
            </div>
            <h3 className="text-base font-black text-slate-900 mb-2">Pedido enviado</h3>
            <p className="text-sm text-slate-600">{reserveDone}</p>
            <button
              type="button"
              onClick={() => setReserveDone("")}
              className="mt-5 w-full px-4 py-2 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 cursor-pointer"
            >
              Entendi
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
