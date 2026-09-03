import React, { useState } from "react";
import { BookOpen, BarChart2, Layers, Camera, FileUp, Smartphone, ShieldAlert, Award, ArrowDownUp, Lightbulb } from "lucide-react";

export default function HowToUse() {
  const [activeSection, setActiveSection] = useState<string>("intro");

  const sections = [
    { id: "intro", title: "Introdução", icon: Award },
    { id: "suggestions", title: "Sugestões de Compra", icon: Lightbulb },
    { id: "stock-flow", title: "Entradas e Saídas", icon: ArrowDownUp },
    { id: "dashboard", title: "Painel & Indicadores", icon: BarChart2 },
    { id: "unified", title: "Estoque Unificado", icon: Layers },
    { id: "barcode", title: "Leitor de Código", icon: Camera },
    { id: "import", title: "Importação Inteligente", icon: FileUp },
    { id: "offline", title: "Funcionamento Offline", icon: Smartphone }
  ];

  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 animate-fadeIn font-sans text-slate-800 space-y-6">
      
      {/* Header Area */}
      <div className="border-b border-slate-100 pb-5">
        <h3 className="text-lg font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
          <BookOpen className="text-gold-600" size={20} /> Central de Ajuda - Como Usar o Sistema
        </h3>
        <p className="text-xs text-slate-450 mt-1 font-bold">
          Confira o guia rápido abaixo para dominar todos os recursos e operar o estoque com eficiência máxima.
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        
        {/* Navigation Sidebar/Tabs */}
        <div className="w-full md:w-56 shrink-0 flex flex-col gap-1">
          {sections.map(sec => {
            const Icon = sec.icon;
            const isActive = activeSection === sec.id;
            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => setActiveSection(sec.id)}
                className={`w-full px-4 py-2.5 rounded-xl text-left text-xs font-bold transition-all flex items-center gap-2.5 border cursor-pointer ${
                  isActive 
                    ? "bg-slate-900 text-gold-400 border-gold-500/20 shadow-xs font-black" 
                    : "text-slate-500 border-transparent hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <Icon size={14} className={isActive ? "text-gold-400" : "text-slate-400"} />
                {sec.title}
              </button>
            );
          })}
        </div>

        {/* Content Panel */}
        <div className="flex-1 min-w-0 bg-slate-50/40 border border-slate-100 rounded-3xl p-5 md:p-6">
          
          {activeSection === "intro" && (
            <div className="space-y-4 animate-scaleUp">
              <h4 className="text-base font-black text-slate-900">Bem-vindo à Central de Ajuda!</h4>
              <p className="text-xs text-slate-600 leading-relaxed">
                A **Central Stoque v2.0** é uma plataforma integrada de gestão de pneus e autopeças projetada para controle multi-empresas, auditoria de movimentações e importação automatizada.
              </p>
              <div className="p-3 bg-gold-500/10 border border-gold-400/20 rounded-2xl text-xs leading-relaxed text-gold-800">
                <strong>💡 Dica Rápida:</strong> A navegação principal fica na barra lateral esquerda (computadores) ou no menu inferior (celulares). Clique nas abas ao lado para aprender sobre as ferramentas específicas.
              </div>
              <p className="text-xs text-slate-500 italic">
                Selecione um tópico na barra lateral para começar o tour.
              </p>
            </div>
          )}

          {activeSection === "suggestions" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">💡 Sugestões de Compra (Pneus em Falta)</h4>
              <p>
                A demanda que o estoque não atendeu agora vira oportunidade de venda registrada. O vendedor é quem ouve o cliente no balcão e encaminha o pedido diretamente para o **Dono da Loja** e para o **Administrador**.
              </p>

              <div className="p-3 bg-white border border-slate-200 rounded-2xl space-y-2">
                <strong className="text-slate-900 block">Como o Vendedor registra:</strong>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>No catálogo, se a busca não encontrar o pneu (ou se faltar a marca procurada), clique em <strong className="text-gold-700">"Sugerir compra"</strong>.</li>
                  <li>Informe a <strong>Medida</strong> do pneu (obrigatória), a quantidade desejada, marca/modelo se houver preferência.</li>
                  <li>Adicione os dados do <strong>Cliente</strong> (nome e telefone/WhatsApp) para poder avisá-lo assim que o pneu chegar.</li>
                  <li>No campo <strong>Observação</strong>, insira detalhes importantes (ex: prazos, aceitação de outra marca, urgência).</li>
                  <li>Acompanhe o status na aba <strong className="text-slate-900">Minhas Sugestões</strong> (Em aberto, Atendida ou Arquivada).</li>
                </ol>
              </div>

              <div className="p-3 bg-white border border-slate-200 rounded-2xl space-y-2">
                <strong className="text-slate-900 block">Como o Dono da Loja e Admin gerenciam:</strong>
                <ul className="list-disc pl-5 space-y-1.5">
                  <li>Abra a nova aba <strong className="text-slate-900">Sugestões</strong> no menu lateral ou inferior.</li>
                  <li>Veja os <strong>Indicadores de Demanda</strong> e o ranking das <strong>Medidas mais procuradas</strong>.</li>
                  <li>Clique em <strong>Marcar atendida</strong> ao providenciar o pedido de compra, com opção de deixar recado para o vendedor.</li>
                  <li>Use o botão <strong>Exportar CSV</strong> para gerar relatórios de compras e cotações com distribuidores.</li>
                </ul>
              </div>
            </div>
          )}

          {activeSection === "stock-flow" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">🔄 Entradas e Saídas</h4>
              <p>
                É a tela do dia a dia do balcão. Dois botões, duas operações: <strong className="text-emerald-700">Entrada de Pneus</strong> soma
                unidades ao estoque, <strong className="text-red-700">Saída de Pneus</strong> dá baixa. Nos dois casos a operação inteira fica
                gravada no histórico, com quem fez, quando, quanto e por quê.
              </p>

              <div className="p-3 bg-white border border-slate-200 rounded-2xl space-y-2">
                <strong className="text-slate-900 block">Como registrar uma movimentação</strong>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>Clique em <strong>Entrada de Pneus</strong> ou <strong>Saída de Pneus</strong>.</li>
                  <li>Pesquise o pneu por SKU, marca, modelo ou medida — a busca de medida ignora barra e "R", então <span className="font-mono">17565r14</span>, <span className="font-mono">175/65 R14</span> e <span className="font-mono">1756514</span> encontram a mesma coisa.</li>
                  <li>Clique no pneu para adicionar 1 unidade, ou use os botões <strong>+1 / +2 / +4</strong> para jogo completo.</li>
                  <li>Ajuste as quantidades no painel da direita, informe o motivo e (se quiser) nota fiscal, fornecedor/cliente e placa.</li>
                  <li>Confirme. O saldo é atualizado na hora e você pode imprimir o comprovante.</li>
                </ol>
              </div>

              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-slate-900">Saída nunca fica negativa:</strong> o sistema confere o saldo real no servidor no
                  momento de gravar. Se outra pessoa vender o mesmo pneu enquanto você monta a lista, a operação é recusada com aviso —
                  em vez de zerar o estoque errado.
                </li>
                <li>
                  <strong className="text-slate-900">Tudo de uma vez:</strong> vários pneus na mesma operação são gravados juntos.
                  Ou entra tudo, ou não entra nada — não existe operação pela metade.
                </li>
                <li>
                  <strong className="text-slate-900">Histórico agrupado:</strong> a lista embaixo mostra cada operação como uma linha só.
                  Clique para abrir e ver item por item, com o saldo que ficou depois de cada um. Dá para filtrar por tipo, período
                  e busca livre, e exportar em CSV.
                </li>
                <li>
                  <strong className="text-slate-900">Estorno (Admin Master):</strong> errou a operação? O administrador estorna e o
                  sistema devolve o saldo, gravando o estorno como um novo registro. O lançamento original nunca é apagado —
                  auditoria não se apaga, se compensa.
                </li>
                <li>
                  <strong className="text-slate-900">Atalhos:</strong> <span className="font-mono">Alt+E</span> abre entrada,
                  <span className="font-mono"> Alt+S</span> abre saída, <span className="font-mono">Enter</span> na busca adiciona o
                  pneu encontrado (funciona com leitor de código de barras) e <span className="font-mono">Esc</span> fecha.
                </li>
              </ul>

              <div className="p-3 bg-gold-500/10 border border-gold-400/20 rounded-2xl text-xs leading-relaxed text-gold-800">
                <strong>💡 Importante:</strong> esta tela movimenta pneus que já existem no cadastro. Se o produto ainda não existe,
                cadastre primeiro em <strong>Cadastros e Ajustes</strong> (ou traga pela <strong>Importação</strong>) e depois volte aqui
                para dar entrada.
              </div>
            </div>
          )}

          {activeSection === "dashboard" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">📊 Painel de Indicadores</h4>
              <p>
                O painel de indicadores é a sua tela inicial e reúne estatísticas de todo o estoque cadastrado na sua filial (ou filiais, caso você seja Admin Master).
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-slate-900">Fluxo de Inventário:</strong> Gráfico de linhas exibindo a quantidade física total de pneus que deram Entrada e Saída ao longo do período selecionado (7, 15 ou 30 dias).
                </li>
                <li>
                  <strong className="text-slate-900">Mix de Estoque (Marca):</strong> Gráfico de rosca interativo que exibe a porcentagem do seu estoque representada por cada marca. Passe o mouse ou toque nas fatias para detalhar a quantidade.
                </li>
                <li>
                  <strong className="text-slate-900">Sugestão de Reposição Preditiva:</strong> O sistema analisa a média diária de vendas (saídas do tipo Venda) nos últimos 30 dias de cada SKU e prevê quantos dias o estoque restante irá durar. Se o estoque projetado cobrir menos de 15 dias, ele sugere a compra ideal para restabelecer a segurança de 45 dias.
                </li>
              </ul>
            </div>
          )}

          {activeSection === "unified" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">Layers / Planilha Unificada</h4>
              <p>
                A aba **Estoque Unificado** exibe uma visão central em forma de planilha de todas as filiais cadastradas.
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-slate-900">Edição Rápida de Estoque:</strong> Clique em qualquer valor de quantidade (célula de filial) ou preço para abrir o campo de edição rápida inline. Pressione <kbd className="font-mono bg-slate-100 px-1 border border-slate-200 rounded">Enter</kbd> ou clique fora do campo para salvar a alteração instantaneamente no banco de dados.
                </li>
                <li>
                  <strong className="text-slate-900">Edição Cadastral (SKU, Marca, Medida):</strong> Você também pode clicar nos campos de texto como Código (SKU), Medida, Marca e Modelo. Ao alterar o cadastro de um produto, o sistema atualiza em tempo real as informações correspondentes em todas as filiais de forma unificada.
                </li>
                <li>
                  <strong className="text-slate-900">Exportação em Planilha:</strong> O botão "Exportar CSV" gera um arquivo Excel instantaneamente com todas as colunas visíveis da busca atual.
                </li>
              </ul>
            </div>
          )}

          {activeSection === "barcode" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">📷 Escaneamento de Códigos de Barras</h4>
              <p>
                Para agilizar a busca de pneus cadastrados sem digitar o código manualmente, você pode utilizar o scanner de câmera:
              </p>
              <ol className="list-decimal pl-5 space-y-2">
                <li>
                  Clique no ícone de <strong className="text-slate-900">Câmera</strong> localizado na barra de pesquisa superior (campo PROCURAR ID/SKU).
                </li>
                <li>
                  Conceda permissão de acesso à câmera no seu navegador ou celular caso seja solicitado.
                </li>
                <li>
                  Aponte o quadrado central do visor da câmera para o código de barras impresso na etiqueta do pneu.
                </li>
                <li>
                  O sistema emitirá um <strong className="text-slate-900">Bip Sonoro</strong> quando decodificado e fechará o scanner preenchendo o SKU na pesquisa instantaneamente.
                </li>
              </ol>
            </div>
          )}

          {activeSection === "import" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">FileUp / Importador Inteligente</h4>
              <p>
                Você pode carregar centenas de itens no estoque em segundos usando o Importador Automatizado:
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-slate-900">Entrada por NF-e (XML/HTML):</strong> Importe arquivos XML de notas fiscais de compra ou copie o conteúdo HTML da nota. O sistema mapeia os produtos e as quantidades correspondentes de forma transparente.
                </li>
                <li>
                  <strong className="text-slate-900">Importação por Texto Livre:</strong> Se você recebeu uma lista de pneus digitada no WhatsApp ou e-mail, basta colá-la na caixa de texto. O parser com Inteligência Artificial irá normalizar a medida (ex: convertendo `205 55 16` ou `205-55-16` para `205/55R16`), identificar a quantidade, a marca e a cotação de preços, gerando a lista de produtos formatada para você revisar antes de salvar.
                </li>
              </ul>
            </div>
          )}

          {activeSection === "offline" && (
            <div className="space-y-4 animate-scaleUp text-xs text-slate-650 leading-relaxed">
              <h4 className="text-base font-black text-slate-900">📱 Funcionamento Offline e Cache</h4>
              <p>
                O sistema é construído sobre uma arquitetura **Offline First**, pensada especificamente para locais com sinal de rede ruim como oficinas ou galpões.
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  Você pode abrir a plataforma e realizar lançamentos de entrada ou dar baixa de pneus mesmo **sem internet**.
                </li>
                <li>
                  As transações realizadas offline ficam salvas no cache seguro do navegador.
                </li>
                <li>
                  Assim que o dispositivo recuperar a conexão, o sistema sincronizará todas as baixas e entradas de estoque com a nuvem em segundo plano automaticamente, registrando os logs de auditoria.
                </li>
              </ul>
              <div className="p-3 bg-red-500/10 border border-red-400/20 rounded-2xl flex gap-2 items-start text-red-800">
                <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                <p>
                  <strong>Atenção:</strong> Evite limpar o cache/dados do seu navegador (como histórico de navegação) se você possuir movimentações salvas offline que ainda não foram sincronizadas com a internet.
                </p>
              </div>
            </div>
          )}

        </div>

      </div>

    </div>
  );
}
