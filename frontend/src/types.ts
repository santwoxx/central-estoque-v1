export type UserRole = "user" | "vendedor" | "alimentador" | "admin";

export interface Company {
  id: string;
  name: string;
  description?: string;
  createdAt?: any;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt?: any;
  companyId?: string;
  companyName?: string;
}

export interface UserCredential {
  id: string;
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
  associatedEmail: string;
  companyId?: string;
  companyName?: string;
  createdAt: any;
}

export interface StockItem {
  id: string; // Document ID
  sku: string; // Custom Product ID / SKU
  brand: string;
  model: string;
  size: string;
  quantity: number;
  // Quantidade presa por reservas de transferencia (pedidos aprovados que ainda
  // nao sairam fisicamente). Nunca sai daqui por venda/baixa: o saldo LIVRE do
  // pneu e `quantity - reservedQuantity` (ver `availableQuantity` em utils.ts).
  // Ausente nos documentos antigos — sempre leia com `?? 0`.
  reservedQuantity?: number;
  price: number; // Legacy or base price
  priceCash?: number;
  priceInstallment?: number;
  // Quanto a loja PAGOU no pneu — nao e preco de venda e nunca aparece no
  // catalogo publico nem para o vendedor. Quem preenche e quem responde pela
  // loja (o alimentador dono da empresa, ou o admin), na tela de Cadastros e
  // Ajustes: e o numero que transforma "capital imobilizado" e margem em conta
  // de verdade, em vez de repetir o preco de venda.
  // Ausente em todo o estoque cadastrado antes deste campo — sempre leia com
  // `?? 0` e trate 0 como "custo nao informado", nunca como custo zero.
  costPrice?: number;
  notes: string;
  description?: string; // Product description
  imageUrl?: string; // Product image url
  userId: string;
  userEmail: string;
  companyId?: string;
  companyName?: string;
  createdAt: any;
  updatedAt: any;
}

export interface MovementLog {
  id: string;
  sku: string;
  brand: string;
  model: string;
  size: string;
  type: "ENTRADA" | "SAIDA" | "IMPORTACAO" | "AJUSTE" | "TRANSFERENCIA_SAIDA" | "TRANSFERENCIA_ENTRADA";
  quantity: number; // positive or negative
  balanceAfter: number;
  userId: string;
  userEmail: string;
  companyId?: string;
  companyName?: string;
  timestamp: any;
  reason: string;
  transferId?: string; // Cross-reference to the transfers/{id} doc that generated this entry

  // ── Campos gravados pelo módulo de Entrada e Saída (StockFlow) ──
  // Todos os itens de uma mesma operação compartilham o mesmo operationId,
  // o que permite reagrupar a operação inteira no histórico (e estorná-la).
  stockItemId?: string;   // id do documento em stock/{id} que foi movimentado
  operationId?: string;
  operationReason?: string; // Motivo escolhido (Compra, Venda, Garantia, Perda...)
  docNumber?: string;       // Nota fiscal / OS / pedido
  partyName?: string;       // Fornecedor (entrada) ou cliente (saída)
  partyDoc?: string;        // CPF/CNPJ do fornecedor/cliente
  vehiclePlate?: string;    // Placa do veículo (saída)
  observation?: string;     // Observação livre da operação
  unitPrice?: number;       // Custo/preço unitário praticado na operação
  totalAmount?: number;     // unitPrice * quantidade do item
  reversalOf?: string;      // operationId estornado por este registro

  // Registro recriado depois dos fatos pela regularização de transferências
  // (o pneu já tinha sido movimentado; só a linha do histórico faltava). O
  // saldo gravado é o do momento da regularização, não o da assinatura.
  rebuilt?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Módulo de Entrada e Saída de Pneus (StockFlow)
// ─────────────────────────────────────────────────────────────────
export type StockFlowType = "ENTRADA" | "SAIDA";

export interface StockFlowItemInput {
  stockItemId: string;
  quantity: number;  // sempre positivo — o sinal é definido pelo tipo da operação
  unitPrice?: number;
}

export interface StockFlowPayload {
  type: StockFlowType;
  items: StockFlowItemInput[];
  reason: string;          // motivo/categoria da operação
  docNumber?: string;
  partyName?: string;
  partyDoc?: string;
  vehiclePlate?: string;
  observation?: string;
}

export interface StockFlowResultItem {
  sku: string;
  brand: string;
  model: string;
  size: string;
  quantity: number;       // quantidade movimentada (positiva)
  balanceBefore: number;
  balanceAfter: number;
  unitPrice: number;
  totalAmount: number;
  companyName: string;
}

// Retorno da gravação — alimenta a tela de sucesso e o comprovante impresso.
export interface StockFlowResult {
  operationId: string;
  type: StockFlowType;
  // true quando a operacao virou um PEDIDO e nada saiu do estoque ainda. Toda
  // saida nasce assim: a tela tem que mostrar "aguardando aprovacao" em vez de
  // imprimir um comprovante de baixa que ainda nao aconteceu.
  pendingApproval?: boolean;
  items: StockFlowResultItem[];
  totalUnits: number;
  totalAmount: number;
  reason: string;
  docNumber: string;
  partyName: string;
  partyDoc: string;
  vehiclePlate: string;
  observation: string;
  companyName: string;
  userName: string;
  date: string;
}

// Resultado da regularização do histórico: recria em `movements` as linhas de
// transferência que faltam, sem tocar em saldo (o estoque já foi movimentado
// quando o pedido foi assinado).
export interface TransferSyncResult {
  scanned: number;     // pedidos verificados no servidor
  alreadyOk: number;   // pedidos que já tinham o registro completo
  repaired: number;    // pedidos que ganharam registros de volta
  created: number;     // linhas de movimento recriadas
  blocked: number;     // pedidos de outra empresa (sem permissão para gravar)
}

// ─────────────────────────────────────────────────────────────────
// Inter-company Stock Transfer (dual signature + scheduling)
// ─────────────────────────────────────────────────────────────────
// SOLICITADO/RECUSADO pertencem ao fluxo de PEDIDO (pull): a empresa que PRECISA
// dos pneus abre a solicitacao e a empresa que os TEM decide. Os demais status
// pertencem ao fluxo de ENVIO (push), em que a origem ja despacha por conta propria.
export type TransferStatus =
  | "SOLICITADO"
  | "RECUSADO"
  | "AGENDADO"
  | "PENDENTE"
  | "EM_TRANSITO"
  | "CONCLUIDO"
  | "CANCELADO";

// Como o pedido nasceu:
//  ENVIO       — a ORIGEM decidiu mandar (fluxo historico, ja vira PENDENTE/AGENDADO).
//  SOLICITACAO — o DESTINO pediu; nasce SOLICITADO e depende do aval da origem.
export type TransferRequestKind = "ENVIO" | "SOLICITACAO";

// ─────────────────────────────────────────────────────────────────
// Reserva de cliente
//
// Destino sentinela usado quando um VENDEDOR separa um pneu do estoque de uma
// loja para um cliente final — e nao para outra filial. Nao existe documento em
// `companies` com este id, e nenhum usuario pertence a ele: por isso um pedido
// com este destino NUNCA entra no fluxo de assinatura/recebimento (ninguem
// poderia assinar a chegada). Ele nasce SOLICITADO e JA PRENDE O PNEU: a mesma
// transacao que grava o pedido soma `reservedQuantity` no documento de estoque,
// entao o pneu aparece como reservado para todo mundo desde o primeiro segundo.
// O que a confirmacao faz nao e prender — e dar a BAIXA.
//
// EXCECAO — vendedor de outra filial:
// se quem abriu a reserva pertence a uma loja DIFERENTE da dona do pneu
// (`requestedByCompanyId != sourceCompanyId`), o pneu esta numa loja e o cliente
// esta em outra: encerrar a venda na origem nao entregaria nada a ninguem. Nesse
// caso, depois dos DOIS avais (dono da origem + administrador), o destino troca
// de 'CLIENTE' para a loja do vendedor e o pedido deixa de ser reserva de
// cliente para virar uma transferencia comum — quatro assinaturas, saldo
// reservado na origem ate o despacho. O `customerName` permanece no documento
// como registro de para quem o pneu esta indo, e e ele que a tela usa para
// continuar mostrando "reserva de cliente" depois da conversao (ver
// `isReservationOrder` abaixo).
//
// `isCustomerReservation` continua respondendo pelo ESTADO ATUAL do pedido:
// depois da conversao ela e falsa, que e exatamente o que libera as assinaturas.
// ─────────────────────────────────────────────────────────────────
export const CLIENTE_COMPANY_ID = "CLIENTE";

export function isCustomerReservation(
  t: { destinationCompanyId?: string } | null | undefined
): boolean {
  return t?.destinationCompanyId === CLIENTE_COMPANY_ID;
}

// ─────────────────────────────────────────────────────────────────
// Reserva de cliente: os DOIS caminhos
//
// O que separa um caso do outro e uma unica pergunta: o pneu ja esta na loja
// onde o vendedor atende?
//
//  • MESMA LOJA (`requestedByCompanyId` == `sourceCompanyId`, ou vendedor sem
//    loja vinculada) — o pneu esta na prateleira do lado. Ele e PRESO no
//    instante do pedido (reserva ativa + `reservedQuantity` somado no estoque),
//    fica marcado como reservado para todo mundo, e UMA confirmacao — do dono
//    da loja ou do administrador — da a BAIXA definitiva e registra a venda.
//
//  • OUTRA LOJA (`requestedByCompanyId` != `sourceCompanyId`) — o pneu esta numa
//    filial e o cliente esta em outra, entao a reserva so serve se o pneu
//    viajar. Ele tambem e preso no instante do pedido, mas o pedido depende de
//    DUAS confirmacoes obrigatorias: a do DONO da loja que tem o pneu e a do
//    ADMINISTRADOR. Quando as duas existem, o destino deixa de ser o balcao e
//    passa a ser a loja do vendedor: dali em diante e uma transferencia comum,
//    com as quatro assinaturas, e a baixa acontece no despacho.
// ─────────────────────────────────────────────────────────────────

// Uma reserva cujo pneu pertence a OUTRA loja — a que exige dupla aprovacao.
// Responde pelo pedido AINDA EM ANALISE: depois de convertido o destino ja nao
// e mais 'CLIENTE' e a resposta vira falsa (use `isReservationOrder` para
// reconhecer o pedido em qualquer fase da vida dele).
export function isCrossStoreReservation(
  t: { destinationCompanyId?: string; sourceCompanyId?: string; requestedByCompanyId?: string } | null | undefined
): boolean {
  return (
    isCustomerReservation(t) &&
    !!t?.requestedByCompanyId &&
    t.requestedByCompanyId !== t.sourceCompanyId
  );
}

// Reserva de cliente em QUALQUER fase — inclusive depois de virar transferencia.
// O `customerName` e o que denuncia a origem do pedido: transferencia comum
// nenhuma carrega nome de cliente.
export function isReservationOrder(
  t: { destinationCompanyId?: string; customerName?: string } | null | undefined
): boolean {
  return isCustomerReservation(t) || !!(t?.customerName || "").trim();
}

// Quais avais uma reserva ainda precisa para sair do lugar.
export function reservationApprovalState(t: TransferOrder | null | undefined): {
  needsDual: boolean;
  hasSource: boolean;
  hasAdmin: boolean;
  complete: boolean;
} {
  const needsDual = isCrossStoreReservation(t);
  const hasSource = !!t?.sourceApprovedByUid;
  const hasAdmin = !!t?.adminApprovedByUid;
  return {
    needsDual,
    hasSource,
    hasAdmin,
    complete: needsDual ? hasSource && hasAdmin : hasSource || hasAdmin
  };
}

// Reserva de estoque presa por um pedido de transferencia.
//
// Enquanto `active` for true, a quantidade de cada item esta somada em
// `reservedQuantity` no documento de estoque da ORIGEM, e portanto indisponivel
// para venda/baixa.
//
// Ela NASCE em tres pontos, sempre na mesma transacao que grava o pedido:
//   • na CRIACAO de um ENVIO aberto pela propria loja de origem — o pneu ja sai
//     do saldo vendavel no instante em que o pedido existe, sem assinatura nenhuma;
//   • na CRIACAO de uma RESERVA DE CLIENTE por um vendedor — de qualquer loja,
//     inclusive de outra filial. E o que faz "o vendedor reservou" ser visivel
//     para todos na hora, sem depender de ninguem confirmar nada;
//   • na APROVACAO de uma SOLICITACAO entre filiais aberta pelo DESTINO, que nao
//     escreve no estoque alheio na hora de pedir.
//
// E e liberada no despacho (o pneu sai de verdade), no cancelamento, na
// liberacao manual pela origem e na exclusao do pedido por um administrador.
export interface TransferReservation {
  active: boolean;
  reservedByUid: string;
  reservedByName: string;
  reservedAt: any;
  releasedAt?: any;
  releasedReason?: string;
}

export interface SignatureRecord {
  signedByUid: string;
  signedByEmail: string;
  signedByName: string;
  signedAt: any; // serverTimestamp()
  signatureDataUrl: string; // PNG base64 drawn via react-signature-canvas
  // Como a assinatura foi coletada. Fica no comprovante impresso: uma via
  // assinada em papel e fotografada tem valor diferente de uma assinada na tela.
  method?: SignatureMethod;
}

export type SignatureMethod = "DESENHO" | "LINK" | "FOTO";

// ─────────────────────────────────────────────────────────────────
// Assinatura do motorista por link publico
//
// O motorista nao tem login. Quem opera gera um destes documentos, manda o
// link por WhatsApp, e o motorista assina numa pagina publica. O token e o
// proprio id do documento — aleatorio e longo. O documento carrega uma copia
// do que o motorista precisa ver, para a colecao `transfers` continuar
// fechada para quem nao esta autenticado.
// ─────────────────────────────────────────────────────────────────
export type SignatureRequestStatus = "PENDENTE" | "ASSINADO" | "APLICADO" | "CANCELADO";

export interface SignatureRequestItem {
  sku: string;
  brand: string;
  model: string;
  size: string;
  quantity: number;
}

export interface SignatureRequest {
  id: string; // = token
  transferId: string;
  stage: "DISPATCH" | "ARRIVAL"; // retirada na origem ou entrega no destino
  sourceCompanyName: string;
  destinationCompanyName: string;
  items: SignatureRequestItem[];
  totalUnits: number;
  driverName: string;         // informado por quem gerou o link
  signedDriverName: string;   // confirmado pelo proprio motorista
  requestedByName: string;
  status: SignatureRequestStatus;
  signatureDataUrl: string;
  createdAt: any;
  expiresAt: any;
  signedAt?: any;
  appliedAt?: any;
  cancelledAt?: any;
}

export interface TransferOrderItem {
  sourceStockItemId: string;
  destinationStockItemId?: string | null; // resolved only when receipt is signed
  sku: string;
  brand: string;
  model: string;
  size: string;
  quantity: number; // immutable after creation
}

export interface TransferOrder {
  id: string;

  // Companies involved
  sourceCompanyId: string;
  sourceCompanyName: string;
  destinationCompanyId: string;
  destinationCompanyName: string;
  
  items: TransferOrderItem[];

  reason: string;
  status: TransferStatus;
  scheduledFor: any | null; // Timestamp, or null for immediate transfers

  // Ausente nos pedidos criados antes do fluxo de solicitacao: trate como "ENVIO".
  requestKind?: TransferRequestKind;

  // Reserva de estoque na origem. null/ausente = nada preso.
  reservation?: TransferReservation | null;

  // Quem deu o aval na solicitacao (fluxo SOLICITACAO -> PENDENTE/AGENDADO).
  // Numa reserva de dupla aprovacao, e quem deu o SEGUNDO aval — o que
  // efetivamente destravou o pedido.
  approvedByUid?: string;
  approvedByName?: string;
  approvedAt?: any;

  // ── Avais de uma reserva aberta por VENDEDOR ──────────────────────
  // Guardados separados porque a reserva de pneu de OUTRA loja exige os DOIS
  // (ver isCrossStoreReservation): o dono da loja que tem o pneu confirma que
  // abre mao dele, e o administrador confirma a transferencia entre filiais.
  // Enquanto faltar um, o pedido fica em SOLICITADO com o pneu preso.
  sourceApprovedByUid?: string;   // dono (alimentador) da loja de ORIGEM
  sourceApprovedByName?: string;
  sourceApprovedAt?: any;
  adminApprovedByUid?: string;    // administrador do sistema
  adminApprovedByName?: string;
  adminApprovedAt?: any;

  // Reserva de cliente (destino CLIENTE_COMPANY_ID): nome do cliente informado
  // pelo vendedor. Vira o `partyName` do movimento de saida quando a venda fecha.
  customerName?: string;

  // Loja a que o vendedor esta vinculado no momento do pedido. Guardado no
  // documento porque a loja que recebe a solicitacao precisa saber se quem pediu
  // e da casa ou de outra filial — e o perfil do vendedor pode mudar depois.
  // Vazio quando o vendedor nao tem empresa vinculada ("Todas as Empresas").
  requestedByCompanyId?: string;
  requestedByCompanyName?: string;

  // Quem fechou a venda de uma reserva de cliente (a loja de origem).
  saleCompletedByUid?: string;
  saleCompletedByName?: string;
  saleCompletedAt?: any;

  // Quem recusou a solicitacao
  rejectedByUid?: string;
  rejectedByName?: string;
  rejectedAt?: any;
  rejectReason?: string;

  // Who requested it
  requestedByUid: string;
  requestedByEmail: string;
  requestedByName: string;
  requestedAt: any;

  // Legacy dual signatures (for backwards compatibility)
  delivery?: SignatureRecord | null; // Signed by someone from the source company
  receipt?: SignatureRecord | null; // Signed by someone from the destination company

  // New 4-signature process
  // A via do motorista chega DEPOIS da via interna (por link publico ou foto do
  // papel assinado), entao ela e opcional enquanto a coleta esta em andamento.
  dispatch?: {
    sender: SignatureRecord;
    driver?: SignatureRecord | null;
  } | null;

  arrival?: {
    receiver: SignatureRecord;
    driver?: SignatureRecord | null;
  } | null;

  // Cancellation / admin reversal
  cancelledByUid?: string;
  cancelledByName?: string;
  cancelledAt?: any;
  cancelReason?: string;

  createdAt: any;
  updatedAt: any;
}

// ─────────────────────────────────────────────────────────────────
// Notification Center (bell icon): in-app events derived from
// real-time transfer/stock changes, persisted per-user in localStorage.
// ─────────────────────────────────────────────────────────────────
export type NotificationType =
  | "TRANSFER_ACTION_REQUIRED"
  | "TRANSFER_UPDATE"
  | "TRANSFER_COMPLETED"
  | "TRANSFER_CANCELLED"
  | "STOCK_LOW"
  | "STOCK_OUT"
  // Fila de baixa. Sem estes dois, a fila so aparecia para quem ja estava com o
  // sistema aberto e olhava para o menu — e cada pedido parado e um pneu preso
  // que a loja nao pode vender.
  | "EXIT_PENDING"      // chegou um pedido que VOCE pode decidir
  | "EXIT_DECIDED";     // o SEU pedido foi aprovado ou recusado

export interface AppNotification {
  id: string; // stable, e.g. `transfer:{id}:{status}` — dedupes re-fires of the same event
  type: NotificationType;
  title: string;
  message: string;
  createdAt: number; // epoch millis
  read: boolean;
  refId?: string; // transferId or stockItemId, for click-through context
  targetTab?: "transfers" | "reservations" | "unified" | "inventory" | "exit-approvals";
}

// ─────────────────────────────────────────────────────────────────
// Sugestões de compra (o que o cliente procurou e a loja não tinha)
//
// O vendedor é a única pessoa que ouve o pedido que o estoque não
// atendeu — e essa informação morria no balcão. Aqui ela vira um
// documento endereçado ao DONO DA LOJA (`companyId`), que é quem
// decide o que comprar. Não mexe em estoque nem em saldo: é um
// recado com fila e desfecho, não uma reserva.
// ─────────────────────────────────────────────────────────────────
export type SuggestionStatus = "ABERTA" | "ATENDIDA" | "ARQUIVADA";

export interface Suggestion {
  id: string;

  // Loja que RECEBE o recado. É o dono dela que vê a aba Sugestões —
  // normalmente a loja do vendedor, mas ele pode endereçar a outra
  // filial (ou ser um vendedor sem loja fixa, e aí precisa escolher).
  companyId: string;
  companyName: string;

  // O pneu procurado. Só a medida é obrigatória: é o que o cliente
  // sempre sabe dizer, e o mínimo para o dono cotar com o fornecedor.
  size: string;
  brand?: string;
  model?: string;
  quantity: number;

  // O cliente, para a loja conseguir retornar quando o pneu chegar.
  customerName?: string;
  customerContact?: string;
  note?: string;

  // Quem mandou
  requestedByUid: string;
  requestedByName: string;
  requestedByEmail?: string;
  requestedByRole?: UserRole;
  requestedByCompanyId?: string;   // a loja de origem do vendedor
  requestedByCompanyName?: string;
  createdAt: any;

  // Desfecho, dado pelo dono da loja
  status: SuggestionStatus;
  resolvedAt?: any;
  resolvedByUid?: string;
  resolvedByName?: string;
  resolutionNote?: string;
}

// ─────────────────────────────────────────────────────────────────
// Pedido de baixa (fila de aprovação)
//
// NENHUMA saída reduz estoque direto. Quem opera o balcão abre um PEDIDO; o
// pneu é PRESO no mesmo instante (`reservedQuantity`), e a baixa só acontece
// num segundo passo, deliberado, feito pelo dono da loja ou por um administrador.
//
// QUEM ABRE PEDIDO DE BAIXA: o dono da loja e o administrador. O VENDEDOR NÃO —
// ele não dá baixa em nada, ele RESERVA (ver TransferOrder com destino
// CLIENTE_COMPANY_ID, mais acima). A baixa da reserva dele é fechada pelo dono,
// e é lá que mora a conferência de duas pessoas no fluxo do vendedor.
//
// Por que prender o pneu já no pedido, antes de qualquer aprovação: entre o
// pedido e a decisão podem passar horas, e nesse intervalo o mesmo pneu não
// pode ser prometido duas vezes. É a mesma mecânica da reserva de cliente —
// e é ela que as regras do Firestore usam como PROVA de que a baixa passou
// pela fila: uma saída só pode descontar `quantity` na mesma escrita em que
// desconta `reservedQuantity`. Baixa direta, sem pedido, o banco recusa.
// ─────────────────────────────────────────────────────────────────
export type StockExitStatus = "PENDENTE" | "APROVADO" | "RECUSADO" | "CANCELADO";

// De onde o pedido nasceu. Muda só o texto que aparece na fila e no histórico —
// o efeito no estoque é o mesmo em todos.
export type StockExitOrigin =
  | "BALCAO"        // venda/saída pelo módulo de Entrada e Saída ou pelo caixa
  | "RAPIDA"        // botão −1 na listagem do celular
  | "CONTAGEM"      // edição do cadastro ou célula da planilha que reduziu o saldo
  | "EXCLUSAO";     // zerar um produto para poder excluí-lo

export interface StockExitItem {
  stockItemId: string;
  sku: string;
  brand: string;
  model: string;
  size: string;
  quantity: number;      // sempre positiva
  unitPrice: number;
  // Saldo do documento no instante do PEDIDO. Não é usado para gravar nada —
  // a baixa relê o saldo na aprovação. Serve para quem aprova enxergar se o
  // estoque mudou desde que o pedido foi aberto.
  balanceAtRequest: number;
}

export interface StockExitRequest {
  id: string;

  companyId: string;
  companyName: string;

  origin: StockExitOrigin;
  items: StockExitItem[];
  totalUnits: number;
  totalAmount: number;

  // Mesmos campos da operação de saída, para o movimento sair completo quando
  // a baixa for aplicada.
  reason: string;
  docNumber: string;
  partyName: string;
  partyDoc: string;
  vehiclePlate: string;
  observation: string;

  status: StockExitStatus;

  requestedByUid: string;
  requestedByEmail: string;
  requestedByName: string;
  requestedByRole: UserRole;
  requestedAt: any;

  // Quem decidiu. Nunca é a mesma pessoa que pediu — conferido no cliente e
  // repetido nas regras do Firestore.
  reviewedByUid?: string;
  reviewedByName?: string;
  reviewedAt?: any;
  reviewNote?: string;

  // `operationId` gerado quando a baixa foi de fato aplicada. É o que amarra
  // este pedido às linhas gravadas em `movements` e o que permite estorná-lo.
  operationId?: string;

  createdAt: any;
  updatedAt: any;
}

// O que as telas mandam para abrir um pedido.
export interface StockExitPayload {
  origin: StockExitOrigin;
  items: { stockItemId: string; quantity: number; unitPrice?: number }[];
  reason: string;
  docNumber?: string;
  partyName?: string;
  partyDoc?: string;
  vehiclePlate?: string;
  observation?: string;
}

// Retorno da abertura do pedido — alimenta a tela de "pedido enviado".
export interface StockExitResult {
  id: string;
  totalUnits: number;
  totalAmount: number;
  companyName: string;
  items: StockExitItem[];
  reason: string;
  requestedByName: string;
  date: string;
}

// Quem pode decidir sobre um pedido: o DONO da loja a que o pedido pertence, ou
// um administrador (qualquer loja).
//
// ── Por que o dono confirma o PRÓPRIO pedido ──────────────────────
// A primeira versão exigia que quem aprova fosse outra pessoa. Na prática isso
// travou a operação: o dono é quem mais atende, e na maioria das lojas ele é o
// único com acesso ao sistema — cada venda dele ficava parada esperando o
// administrador, inclusive no fim de semana.
//
// O dono responde pelo estoque da loja dele. Não existe "segunda pessoa" acima
// dele dentro da própria loja, então exigir uma era inventar um degrau que a
// operação não tem. O que a fila continua garantindo para ele é real: a baixa é
// um passo deliberado e separado, o pneu fica preso entre o pedido e a
// confirmação (ninguém vende o mesmo pneu duas vezes), e o histórico grava quem
// pediu e quem aprovou — quando são a mesma pessoa, isso aparece.
//
// A conferência por outra pessoa continua existindo onde ela de fato protege:
// um pedido aberto por alguém que NÃO é o dono daquela loja só sai com o aval
// do dono ou do administrador.
//
// Esta função é a definição única da regra; as regras do Firestore repetem a
// mesma condição do lado do servidor.
export function canReviewStockExit(
  exit: { companyId?: string; requestedByUid?: string; status?: StockExitStatus } | null | undefined,
  user: { uid: string; role: UserRole; companyId?: string } | null | undefined
): boolean {
  if (!exit || !user) return false;
  if (exit.status !== "PENDENTE") return false;
  if (user.role === "admin") return true;
  return (
    (user.role === "alimentador" || user.role === "user") &&
    !!user.companyId &&
    exit.companyId === user.companyId
  );
}

// ─────────────────────────────────────────────────────────────────
// Resultado da restauração de backup
//
// A restauração é uma operação de emergência, feita sob estresse — depois de
// alguém apagar algo por engano. Devolver um "pronto!" mudo é o pior momento
// possível para esconder o que aconteceu: quem restaura precisa ver, ANTES de
// confirmar e DEPOIS de aplicar, quantos itens foram criados, quantos
// atualizados e quantos ficaram de fora.
// ─────────────────────────────────────────────────────────────────
export interface RestorePreviewItem {
  sku: string;
  companyName: string;
  currentQuantity: number | null;  // null = não existe no estoque hoje
  backupQuantity: number;
  action: "CRIAR" | "ATUALIZAR" | "IGNORAR";
  note?: string;
}

export interface RestoreResult {
  created: number;
  updated: number;
  skipped: number;
  items: RestorePreviewItem[];
}
