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
// poderia assinar a chegada). Ele nasce SOLICITADO, a loja de ORIGEM aprova
// (reservando o saldo) e a propria loja de origem o encerra em "Concluir Venda",
// que da a baixa definitiva no estoque.
// ─────────────────────────────────────────────────────────────────
export const CLIENTE_COMPANY_ID = "CLIENTE";

export function isCustomerReservation(
  t: { destinationCompanyId?: string } | null | undefined
): boolean {
  return t?.destinationCompanyId === CLIENTE_COMPANY_ID;
}

// Reserva de estoque presa por um pedido de transferencia.
//
// Enquanto `active` for true, a quantidade de cada item esta somada em
// `reservedQuantity` no documento de estoque da ORIGEM, e portanto indisponivel
// para venda/baixa. A reserva e liberada em exatamente tres momentos: o despacho
// (o pneu sai de verdade), o cancelamento e a liberacao manual pela origem.
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

  // Quem deu o aval na solicitacao (fluxo SOLICITACAO -> PENDENTE/AGENDADO)
  approvedByUid?: string;
  approvedByName?: string;
  approvedAt?: any;

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
  | "STOCK_OUT";

export interface AppNotification {
  id: string; // stable, e.g. `transfer:{id}:{status}` — dedupes re-fires of the same event
  type: NotificationType;
  title: string;
  message: string;
  createdAt: number; // epoch millis
  read: boolean;
  refId?: string; // transferId or stockItemId, for click-through context
  targetTab?: "transfers" | "unified" | "inventory";
}
