import { useEffect, useRef, useState } from "react";
import { doc, setDoc, onSnapshot, updateDoc, serverTimestamp, Timestamp, collection } from "firebase/firestore";
import SignatureCanvas from "react-signature-canvas";
import { db } from "../firebase";
import { TransferOrder, SignatureMethod, SignatureRequest, UserRole } from "../types";
import { formatDate } from "../utils";
import {
  X,
  Link2,
  Printer,
  Camera,
  Truck,
  Check,
  CheckCircle2,
  Loader2,
  Copy,
  RefreshCw,
  AlertTriangle,
  PenLine,
  Eraser,
  ArrowLeft,
  Clock
} from "lucide-react";

interface DriverSignatureProps {
  transfer: TransferOrder;
  stage: "DISPATCH" | "ARRIVAL";
  user: { uid: string; email: string; displayName: string; role: UserRole; companyId?: string; companyName?: string };
  onComplete: (signatureDataUrl: string, driverName: string, method: SignatureMethod) => Promise<void>;
  onClose: () => void;
}

// Validade do link enviado ao motorista. Curto de propósito: um link de
// assinatura que vive para sempre é um link que assina qualquer coisa depois.
const LINK_TTL_HOURS = 48;

// Teto do tamanho da foto já comprimida. O documento do Firestore inteiro tem
// limite de 1 MB e pode carregar duas fotos (retirada + entrega) além das
// assinaturas desenhadas, então cada foto precisa caber com folga.
const MAX_PHOTO_CHARS = 280000;

// Reduz e comprime a foto do papel assinado até caber no limite acima.
function compressPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo selecionado."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("O arquivo escolhido não é uma imagem válida."));
      img.onload = () => {
        const maxDim = 1200;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Não foi possível processar a imagem neste navegador."));

        // Fundo branco: foto de papel costuma vir com transparência zero, mas
        // JPEG não tem canal alfa e sairia com fundo preto sem isto.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        let quality = 0.72;
        let out = canvas.toDataURL("image/jpeg", quality);
        while (out.length > MAX_PHOTO_CHARS && quality > 0.3) {
          quality -= 0.1;
          out = canvas.toDataURL("image/jpeg", quality);
        }
        if (out.length > MAX_PHOTO_CHARS) {
          return reject(new Error("A foto ficou grande demais. Tente enfocar só o campo da assinatura."));
        }
        resolve(out);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Token do link: id aleatório e longo o bastante para não ser adivinhado.
function generateToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint32Array(32);
  crypto.getRandomValues(values);
  return Array.from(values, v => alphabet[v % alphabet.length]).join("");
}

type Panel = "CHOICE" | "LINK" | "PAPER" | "DRAW";

export default function DriverSignature({ transfer, stage, user, onComplete, onClose }: DriverSignatureProps) {
  const isDispatch = stage === "DISPATCH";

  // Na entrega, o motorista deve ser o mesmo que assinou a retirada.
  const expectedDriverName = transfer.dispatch?.driver?.signedByName || "";

  const [panel, setPanel] = useState<Panel>("CHOICE");
  const [driverName, setDriverName] = useState(expectedDriverName);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Link
  const [token, setToken] = useState("");
  const [request, setRequest] = useState<SignatureRequest | null>(null);
  const [copied, setCopied] = useState(false);

  // Foto do papel
  const [photoDataUrl, setPhotoDataUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Assinatura na tela
  const sigRef = useRef<any>(null);
  const drawBoxRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(320);

  const items = transfer.items || [];
  const totalUnits = items.reduce((acc, i) => acc + (Number(i.quantity) || 0), 0);
  const signatureUrl = token ? `${window.location.origin}/assinar?t=${token}` : "";

  useEffect(() => {
    const measure = () => {
      if (drawBoxRef.current) setCanvasWidth(Math.max(drawBoxRef.current.clientWidth - 4, 260));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [panel]);

  // Acompanha o pedido de assinatura em tempo real: assim que o motorista
  // assina no celular dele, o painel aqui muda sozinho.
  useEffect(() => {
    if (!token) return;
    const unsub = onSnapshot(doc(db, "signature_requests", token), snap => {
      if (snap.exists()) setRequest({ id: snap.id, ...(snap.data() as any) });
    }, err => console.error("Erro ao acompanhar assinatura:", err));
    return unsub;
  }, [token]);

  // ── Opção 1: link por WhatsApp ───────────────────────────────────
  const handleCreateLink = async () => {
    if (!driverName.trim()) {
      setError("Informe o nome do motorista.");
      return;
    }
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setError("Informe o WhatsApp do motorista com DDD.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const newToken = generateToken();
      const expiresAt = Timestamp.fromDate(new Date(Date.now() + LINK_TTL_HOURS * 60 * 60 * 1000));

      await setDoc(doc(collection(db, "signature_requests"), newToken), {
        transferId: transfer.id,
        stage,
        sourceCompanyName: transfer.sourceCompanyName || "",
        destinationCompanyName: transfer.destinationCompanyName || "",
        items: items.map(i => ({
          sku: i.sku || "",
          brand: i.brand || "",
          model: i.model || "",
          size: i.size || "",
          quantity: Number(i.quantity) || 0
        })),
        totalUnits,
        driverName: driverName.trim(),
        signedDriverName: "",
        requestedByName: user.displayName,
        status: "PENDENTE",
        signatureDataUrl: "",
        createdAt: serverTimestamp(),
        expiresAt
      });

      setToken(newToken);

      // Número já com código do país é usado como veio; senão assume Brasil.
      const target = digits.length > 11 ? digits : `55${digits}`;
      const url = `${window.location.origin}/assinar?t=${newToken}`;
      const message =
        `*Central Stoque — ${isDispatch ? "Retirada" : "Entrega"} de mercadoria*\n\n` +
        `Olá ${driverName.trim()}, confirme a ${isDispatch ? "retirada" : "entrega"} de ` +
        `${totalUnits} pneu(s) de ${transfer.sourceCompanyName} para ${transfer.destinationCompanyName}.\n\n` +
        `Assine no link abaixo (validade de ${LINK_TTL_HOURS}h):\n${url}`;

      window.open(`https://wa.me/${target}?text=${encodeURIComponent(message)}`, "_blank");
    } catch (err: any) {
      console.error("Erro ao gerar link de assinatura:", err);
      setError(err?.message || "Não foi possível gerar o link de assinatura.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(signatureUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Não foi possível copiar. Selecione o link manualmente.");
    }
  };

  const handleCancelLink = async () => {
    if (!token) return;
    try {
      await updateDoc(doc(db, "signature_requests", token), {
        status: "CANCELADO",
        cancelledAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Erro ao cancelar link:", err);
    }
    setToken("");
    setRequest(null);
  };

  // ── Opção 2: papel impresso + foto ───────────────────────────────
  const handlePrintPaper = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const rows = items.map(i => `
      <tr>
        <td class="mono">${i.sku || "—"}</td>
        <td>${i.brand || ""} ${i.model || ""}</td>
        <td class="mono">${i.size || "—"}</td>
        <td class="num">${i.quantity} un</td>
      </tr>
    `).join("");

    printWindow.document.write(`
      <html>
        <head>
          <title>Assinatura do Motorista - Central Stoque</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1e293b; max-width: 620px; margin: auto; padding: 28px; }
            .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; }
            .title { font-weight: bold; font-size: 17px; text-transform: uppercase; }
            .sub { color: #64748b; font-size: 11px; margin-top: 4px; }
            .row { display: flex; justify-content: space-between; margin: 5px 0; gap: 12px; }
            .label { color: #64748b; font-weight: bold; }
            table { width: 100%; border-collapse: collapse; margin: 12px 0; }
            th { text-align: left; font-size: 10px; text-transform: uppercase; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; padding: 6px 5px; }
            td { padding: 6px 5px; border: 1px solid #e2e8f0; font-size: 11px; }
            .mono { font-family: monospace; }
            .num { text-align: right; font-weight: bold; }
            .total { text-align: right; font-weight: bold; font-size: 13px; margin-bottom: 18px; }
            .declaration { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; font-size: 11px; line-height: 1.6; background: #f8fafc; }
            .sign-area { margin-top: 34px; }
            .sign-line { border-bottom: 1.5px solid #0f172a; height: 90px; }
            .sign-label { text-align: center; font-size: 10px; text-transform: uppercase; color: #475569; margin-top: 6px; font-weight: bold; letter-spacing: .5px; }
            .fields { display: flex; gap: 18px; margin-top: 22px; font-size: 11px; }
            .field { flex: 1; }
            .field-line { border-bottom: 1px solid #94a3b8; height: 20px; }
            .note { margin-top: 26px; padding: 10px; border: 1px dashed #94a3b8; border-radius: 8px; font-size: 10px; color: #475569; text-align: center; }
            .btn-print { display: block; width: 220px; padding: 10px; background: #0f172a; color: #fff; border: none; font-weight: bold; text-align: center; cursor: pointer; margin: 22px auto 0; text-transform: uppercase; border-radius: 6px; }
            @media print { .btn-print { display: none; } body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">Comprovante de ${isDispatch ? "Retirada" : "Entrega"} — Motorista</div>
            <div class="sub">Central Stoque • Pedido ${transfer.id}</div>
          </div>

          <div class="row"><span class="label">Origem:</span><span>${transfer.sourceCompanyName || "—"}</span></div>
          <div class="row"><span class="label">Destino:</span><span>${transfer.destinationCompanyName || "—"}</span></div>
          <div class="row"><span class="label">Solicitado por:</span><span>${transfer.requestedByName || "—"}</span></div>
          <div class="row"><span class="label">Emitido em:</span><span>${formatDate(new Date())}</span></div>

          <table>
            <thead><tr><th>SKU</th><th>Pneu</th><th>Medida</th><th style="text-align:right">Qtde</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="4">Nenhum item</td></tr>`}</tbody>
          </table>
          <div class="total">Total: ${totalUnits} un</div>

          <div class="declaration">
            Declaro, para os devidos fins, que ${isDispatch ? "RETIREI" : "ENTREGUEI"} os itens relacionados acima,
            conferidos em quantidade e descrição, assumindo a responsabilidade pelo transporte
            ${isDispatch ? "até a empresa de destino" : "e pela entrega ao destinatário"}.
          </div>

          <div class="sign-area">
            <div class="sign-line"></div>
            <div class="sign-label">Assinatura do Motorista</div>
          </div>

          <div class="fields">
            <div class="field">
              <div class="field-line"></div>
              <div class="sign-label">Nome completo</div>
            </div>
            <div class="field">
              <div class="field-line"></div>
              <div class="sign-label">CPF / CNH</div>
            </div>
            <div class="field">
              <div class="field-line"></div>
              <div class="sign-label">Placa do veículo</div>
            </div>
          </div>

          <div class="note">
            Depois de assinado, fotografe este papel e anexe no sistema para concluir a operação.
          </div>

          <button class="btn-print" onclick="window.print()">Imprimir</button>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = await compressPhoto(file);
      setPhotoDataUrl(dataUrl);
    } catch (err: any) {
      setError(err?.message || "Não foi possível processar a foto.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ── Conclusão (comum às três opções) ─────────────────────────────
  const finish = async (signatureDataUrl: string, name: string, method: SignatureMethod) => {
    setBusy(true);
    setError("");
    try {
      await onComplete(signatureDataUrl, name, method);
      if (token) {
        // Marca o link como aplicado para ele não ser reaproveitado.
        updateDoc(doc(db, "signature_requests", token), {
          status: "APLICADO",
          appliedAt: serverTimestamp()
        }).catch(err => console.error("Erro ao marcar link como aplicado:", err));
      }
    } catch (err: any) {
      setError(err?.message || "Erro ao concluir a operação.");
      setBusy(false);
    }
  };

  const handleFinishFromLink = () => {
    if (!request?.signatureDataUrl) return;
    finish(request.signatureDataUrl, request.signedDriverName || driverName, "LINK");
  };

  const handleFinishFromPhoto = () => {
    if (!photoDataUrl) {
      setError("Anexe a foto do papel assinado.");
      return;
    }
    if (!driverName.trim()) {
      setError("Informe o nome do motorista.");
      return;
    }
    finish(photoDataUrl, driverName.trim(), "FOTO");
  };

  const handleFinishFromDraw = () => {
    if (!driverName.trim()) {
      setError("Informe o nome do motorista.");
      return;
    }
    if (!sigRef.current || sigRef.current.isEmpty()) {
      setError("O motorista deve assinar no quadro.");
      return;
    }
    const canvasInstance = typeof sigRef.current.getTrimmedCanvas === "function"
      ? sigRef.current.getTrimmedCanvas()
      : sigRef.current.getCanvas();
    finish(canvasInstance.toDataURL("image/png"), driverName.trim(), "DESENHO");
  };

  const driverMismatch =
    !isDispatch && expectedDriverName && driverName.trim() &&
    driverName.trim().toLowerCase() !== expectedDriverName.toLowerCase();

  const inputClass =
    "w-full px-3 py-2.5 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold";

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60] overflow-y-auto animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-lg w-full border border-slate-200 shadow-2xl my-8 flex flex-col max-h-[92vh]">

        {/* Cabeçalho */}
        <div className="flex items-center justify-between border-b border-slate-100 p-5 shrink-0">
          <div className="min-w-0 flex items-center gap-2.5">
            {panel !== "CHOICE" && (
              <button
                type="button"
                onClick={() => { setPanel("CHOICE"); setError(""); }}
                disabled={busy}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                title="Voltar"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div className="min-w-0">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Truck size={16} className="text-gold-600 shrink-0" /> Assinatura do Motorista
              </h3>
              <p className="text-[11px] text-slate-500 font-semibold mt-0.5 truncate">
                {isDispatch
                  ? `Retirada em ${transfer.sourceCompanyName}`
                  : `Entrega em ${transfer.destinationCompanyName}`} • {totalUnits} un
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* Assinatura interna já registrada */}
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
            <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
            <p className="text-[11px] font-bold text-emerald-800 leading-snug">
              {isDispatch ? "Assinatura do remetente registrada." : "Assinatura do recebedor registrada."}{" "}
              Falta apenas a via do motorista para concluir.
            </p>
          </div>

          {!isDispatch && expectedDriverName && (
            <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl p-3">
              <Truck size={15} className="text-slate-500 shrink-0 mt-0.5" />
              <p className="text-[11px] font-bold text-slate-600 leading-snug">
                Motorista que retirou a carga:{" "}
                <span className="text-slate-900 font-black">{expectedDriverName}</span>
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-bold border-l-4 border-red-500 flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {/* ── Escolha do método ── */}
          {panel === "CHOICE" && (
            <div className="space-y-3">
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                Como o motorista vai assinar?
              </p>

              <button
                type="button"
                onClick={() => { setPanel("LINK"); setError(""); }}
                className="w-full group flex items-center gap-4 p-4 rounded-2xl border border-slate-200 bg-white hover:border-gold-500 hover:bg-gold-50/30 transition-all text-left cursor-pointer"
              >
                <div className="h-12 w-12 rounded-2xl bg-gold-600 text-white flex items-center justify-center shadow-md shadow-gold-600/20 group-hover:scale-105 transition-transform shrink-0">
                  <Link2 size={22} />
                </div>
                <div className="min-w-0">
                  <span className="block text-xs font-black text-slate-900 uppercase tracking-wide">
                    Enviar link por WhatsApp
                  </span>
                  <span className="block text-[11px] text-slate-500 font-semibold mt-0.5 leading-snug">
                    O motorista assina no celular dele. Você acompanha a confirmação aqui, ao vivo.
                  </span>
                </div>
              </button>

              <button
                type="button"
                onClick={() => { setPanel("PAPER"); setError(""); }}
                className="w-full group flex items-center gap-4 p-4 rounded-2xl border border-slate-200 bg-white hover:border-slate-900 hover:bg-slate-50 transition-all text-left cursor-pointer"
              >
                <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform shrink-0">
                  <Printer size={22} />
                </div>
                <div className="min-w-0">
                  <span className="block text-xs font-black text-slate-900 uppercase tracking-wide">
                    Imprimir papel para assinar
                  </span>
                  <span className="block text-[11px] text-slate-500 font-semibold mt-0.5 leading-snug">
                    Imprime o comprovante, o motorista assina à caneta e você anexa a foto.
                  </span>
                </div>
              </button>

              <button
                type="button"
                onClick={() => { setPanel("DRAW"); setError(""); }}
                className="w-full text-center text-[11px] font-bold text-slate-400 hover:text-slate-700 underline pt-1 cursor-pointer"
              >
                O motorista está aqui — assinar direto nesta tela
              </button>
            </div>
          )}

          {/* ── Opção 1: link ── */}
          {panel === "LINK" && !token && (
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Nome do motorista *
                </label>
                <input
                  type="text"
                  value={driverName}
                  onChange={e => setDriverName(e.target.value)}
                  placeholder="Ex: João da Silva"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  WhatsApp do motorista *
                </label>
                <input
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="DDD + número (ex: 73 99999-9999)"
                  className={inputClass}
                />
                <p className="text-[10px] text-slate-400 font-semibold mt-1.5">
                  O link vale por {LINK_TTL_HOURS}h e só pode ser assinado uma vez.
                </p>
              </div>

              {driverMismatch && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-xl text-[11px] font-bold flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  Este nome é diferente do motorista que retirou a carga ({expectedDriverName}).
                  Confirme se houve troca de motorista no caminho.
                </div>
              )}

              <button
                type="button"
                onClick={handleCreateLink}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer disabled:opacity-50"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
                {busy ? "Gerando..." : "Gerar e enviar no WhatsApp"}
              </button>
            </div>
          )}

          {/* ── Opção 1: aguardando / assinado ── */}
          {panel === "LINK" && token && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 bg-slate-50">
                <input
                  readOnly
                  value={signatureUrl}
                  onFocus={e => e.target.select()}
                  className="flex-1 bg-transparent text-[11px] font-mono text-slate-600 outline-none min-w-0"
                />
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="p-1.5 text-slate-500 hover:text-gold-700 hover:bg-white rounded-lg transition-colors cursor-pointer shrink-0"
                  title="Copiar link"
                >
                  {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                </button>
              </div>

              {request?.status === "ASSINADO" ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                    <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                    <p className="text-[11px] font-bold text-emerald-800 leading-snug">
                      <span className="font-black">{request.signedDriverName}</span> assinou
                      {request.signedAt ? ` em ${formatDate(request.signedAt)}` : ""}.
                    </p>
                  </div>

                  <div className="border border-slate-200 rounded-xl p-3 bg-white">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-2">Assinatura recebida</p>
                    <img
                      src={request.signatureDataUrl}
                      alt="Assinatura do motorista"
                      className="max-h-24 mx-auto object-contain"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleFinishFromLink}
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} className="stroke-[3]" />}
                    {busy ? "Concluindo..." : isDispatch ? "Confirmar e liberar envio" : "Confirmar recebimento"}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4">
                    <Loader2 size={18} className="text-amber-600 animate-spin shrink-0" />
                    <div>
                      <p className="text-xs font-black text-amber-900">Aguardando o motorista assinar</p>
                      <p className="text-[10px] font-bold text-amber-700 mt-0.5 flex items-center gap-1">
                        <Clock size={10} /> Esta tela atualiza sozinha quando ele confirmar.
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleCancelLink}
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer"
                  >
                    <RefreshCw size={13} /> Cancelar link e escolher outro método
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Opção 2: papel + foto ── */}
          {panel === "PAPER" && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handlePrintPaper}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer"
              >
                <Printer size={15} /> Imprimir comprovante para assinatura
              </button>

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Nome do motorista *
                </label>
                <input
                  type="text"
                  value={driverName}
                  onChange={e => setDriverName(e.target.value)}
                  placeholder="Ex: João da Silva"
                  className={inputClass}
                />
              </div>

              {driverMismatch && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-xl text-[11px] font-bold flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  Este nome é diferente do motorista que retirou a carga ({expectedDriverName}).
                </div>
              )}

              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Foto do papel assinado *
                </label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoSelected}
                  className="hidden"
                />

                {photoDataUrl ? (
                  <div className="border border-slate-200 rounded-xl p-3 bg-white space-y-2">
                    <img src={photoDataUrl} alt="Assinatura fotografada" className="max-h-52 w-full object-contain rounded-lg" />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full text-[11px] font-black text-gold-700 hover:underline cursor-pointer uppercase tracking-wider"
                    >
                      Trocar foto
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                    className="w-full flex flex-col items-center justify-center gap-2 p-6 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/60 hover:bg-slate-50 hover:border-gold-500 transition-all cursor-pointer disabled:opacity-50"
                  >
                    {busy
                      ? <Loader2 size={26} className="animate-spin text-slate-400" />
                      : <Camera size={26} className="text-slate-400" />}
                    <span className="text-xs font-black text-slate-600 uppercase tracking-wide">
                      {busy ? "Processando..." : "Tirar foto ou escolher arquivo"}
                    </span>
                    <span className="text-[10px] text-slate-400 font-semibold text-center">
                      Enquadre o campo da assinatura. A imagem é reduzida automaticamente.
                    </span>
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={handleFinishFromPhoto}
                disabled={busy || !photoDataUrl}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer disabled:opacity-40"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} className="stroke-[3]" />}
                {busy ? "Concluindo..." : isDispatch ? "Confirmar e liberar envio" : "Confirmar recebimento"}
              </button>
            </div>
          )}

          {/* ── Alternativa: assinar na própria tela ── */}
          {panel === "DRAW" && (
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                  Nome do motorista *
                </label>
                <input
                  type="text"
                  value={driverName}
                  onChange={e => setDriverName(e.target.value)}
                  placeholder="Ex: João da Silva"
                  className={inputClass}
                />
              </div>

              {driverMismatch && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-xl text-[11px] font-bold flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  Este nome é diferente do motorista que retirou a carga ({expectedDriverName}).
                </div>
              )}

              <div
                ref={drawBoxRef}
                className="border-2 border-dashed border-slate-300 rounded-2xl overflow-hidden bg-slate-50/60 touch-none flex justify-center"
              >
                <SignatureCanvas
                  ref={sigRef}
                  penColor="#0f172a"
                  canvasProps={{ width: canvasWidth, height: 190, className: "touch-none" }}
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => sigRef.current?.clear()}
                  className="px-4 py-3 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer flex items-center gap-1.5"
                >
                  <Eraser size={14} /> Limpar
                </button>
                <button
                  type="button"
                  onClick={handleFinishFromDraw}
                  disabled={busy}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer disabled:opacity-50"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <PenLine size={15} />}
                  {busy ? "Concluindo..." : isDispatch ? "Confirmar e liberar envio" : "Confirmar recebimento"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
