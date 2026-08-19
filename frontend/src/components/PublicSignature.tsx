import { useEffect, useRef, useState } from "react";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import SignatureCanvas from "react-signature-canvas";
import { db } from "../firebase";
import { SignatureRequest } from "../types";
import { toMillis } from "../utils";
import {
  Truck,
  PenLine,
  Eraser,
  Check,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Warehouse,
  ArrowRight
} from "lucide-react";

// Página pública que o motorista abre pelo link recebido no WhatsApp.
// Roda SEM login: o token vem na URL (?t=) e é o id do documento em
// signature_requests. As regras do Firestore liberam `get` por token, mas
// bloqueiam `list` — quem não tem o link não descobre pedido nenhum.
export default function PublicSignature() {
  const [request, setRequest] = useState<SignatureRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [driverName, setDriverName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const sigRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(320);

  const token = new URLSearchParams(window.location.search).get("t") || "";

  useEffect(() => {
    const measure = () => {
      if (containerRef.current) setCanvasWidth(Math.max(containerRef.current.clientWidth - 4, 260));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [request, done]);

  useEffect(() => {
    const load = async () => {
      if (!token) {
        setLoadError("Link inválido: o endereço não contém o código da assinatura.");
        setLoading(false);
        return;
      }
      try {
        const snap = await getDoc(doc(db, "signature_requests", token));
        if (!snap.exists()) {
          setLoadError("Este link de assinatura não existe ou já foi removido.");
          setLoading(false);
          return;
        }
        const data = snap.data() as any;
        const loaded: SignatureRequest = { id: snap.id, ...data };
        setRequest(loaded);
        setDriverName(data.signedDriverName || data.driverName || "");
        if (data.status === "ASSINADO" || data.status === "APLICADO") setDone(true);
      } catch (err) {
        console.error("Erro ao carregar pedido de assinatura:", err);
        setLoadError("Não foi possível carregar este link. Verifique sua conexão e tente de novo.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  const isExpired = request ? toMillis(request.expiresAt) > 0 && toMillis(request.expiresAt) < Date.now() : false;
  const isCancelled = request?.status === "CANCELADO";

  const handleClear = () => {
    sigRef.current?.clear();
    setError("");
  };

  const handleConfirm = async () => {
    if (!request) return;
    if (!driverName.trim()) {
      setError("Informe seu nome completo antes de assinar.");
      return;
    }
    if (!sigRef.current || sigRef.current.isEmpty()) {
      setError("Assine no quadro acima para confirmar.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const canvasInstance = typeof sigRef.current.getTrimmedCanvas === "function"
        ? sigRef.current.getTrimmedCanvas()
        : sigRef.current.getCanvas();
      const dataUrl = canvasInstance.toDataURL("image/png");

      await updateDoc(doc(db, "signature_requests", request.id), {
        status: "ASSINADO",
        signatureDataUrl: dataUrl,
        signedDriverName: driverName.trim(),
        signedAt: serverTimestamp()
      });
      setDone(true);
    } catch (err: any) {
      console.error("Erro ao gravar assinatura:", err);
      setError(
        err?.code === "permission-denied"
          ? "Este link já foi assinado ou expirou. Peça um novo link à loja."
          : "Não foi possível registrar a assinatura. Tente novamente."
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── Telas de estado ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex flex-col items-center justify-center gap-4 font-sans">
        <div className="relative flex items-center justify-center">
          <div className="h-12 w-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <Warehouse className="h-5 w-5 text-blue-400 absolute" />
        </div>
        <p className="text-white font-extrabold text-sm tracking-tight">Central Stoque</p>
        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Carregando assinatura...</span>
      </div>
    );
  }

  const blockedMessage = loadError
    || (isCancelled ? "Este link foi cancelado pela loja. Peça um novo." : "")
    || (isExpired && !done ? "Este link expirou. Peça um novo link à loja." : "");

  if (blockedMessage) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-5 font-sans">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-7 max-w-sm w-full text-center space-y-3">
          <div className="h-14 w-14 mx-auto rounded-2xl bg-amber-50 text-amber-600 border border-amber-200 flex items-center justify-center">
            <AlertTriangle size={28} />
          </div>
          <h1 className="text-base font-black text-slate-900 uppercase tracking-wide">Link indisponível</h1>
          <p className="text-xs text-slate-500 font-semibold leading-relaxed">{blockedMessage}</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-5 font-sans">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-7 max-w-sm w-full text-center space-y-3">
          <div className="h-16 w-16 mx-auto rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-200 flex items-center justify-center">
            <CheckCircle2 size={34} className="stroke-[2]" />
          </div>
          <h1 className="text-base font-black text-slate-900 uppercase tracking-wide">Assinatura registrada!</h1>
          <p className="text-xs text-slate-500 font-semibold leading-relaxed">
            Obrigado, <span className="font-black text-slate-800">{driverName || request?.driverName}</span>.
            A loja já recebeu sua assinatura e vai concluir a operação no sistema.
          </p>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider pt-2 border-t border-slate-100">
            Você já pode fechar esta página
          </p>
        </div>
      </div>
    );
  }

  const isDispatch = request?.stage === "DISPATCH";

  return (
    <div className="min-h-screen bg-slate-50 font-sans py-6 px-4">
      <div className="max-w-md mx-auto space-y-4">

        {/* Cabeçalho */}
        <div className="bg-[#0b0f19] rounded-3xl p-5 text-white">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-gold-600 via-gold-500 to-amber-200 text-[#0f172a] flex items-center justify-center border border-gold-300/30 shrink-0">
              <Warehouse className="h-5 w-5 stroke-[2.2]" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-black uppercase tracking-tight leading-none">Central Stoque</h1>
              <p className="text-[10px] font-bold text-slate-400 mt-1">
                {isDispatch ? "Retirada de mercadoria" : "Entrega de mercadoria"}
              </p>
            </div>
          </div>
        </div>

        {/* O que está sendo assinado */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-center gap-2 text-xs font-black text-slate-900 uppercase tracking-wider">
            <Truck size={16} className="text-gold-600" />
            {isDispatch ? "Confirmação de retirada" : "Confirmação de entrega"}
          </div>

          <div className="flex items-center gap-2 text-[11px] font-bold text-slate-600 bg-slate-50 rounded-xl p-3 border border-slate-100">
            <span className="truncate">{request?.sourceCompanyName || "—"}</span>
            <ArrowRight size={13} className="text-gold-600 shrink-0" />
            <span className="truncate">{request?.destinationCompanyName || "—"}</span>
          </div>

          <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {(request?.items || []).map((item, idx) => (
              <div key={`${item.sku}-${idx}`} className="p-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-black text-slate-900 uppercase truncate">
                    {item.brand} {item.model}
                  </div>
                  <div className="text-[10px] text-slate-500 font-bold font-mono">{item.sku} • {item.size}</div>
                </div>
                <span className="text-xs font-black text-slate-800 font-mono shrink-0">{item.quantity} un</span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-slate-900 text-white">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Total</span>
            <span className="text-sm font-black font-mono">{request?.totalUnits || 0} pneus</span>
          </div>

          <p className="text-[10px] text-slate-400 font-semibold leading-relaxed">
            Ao assinar, você confirma que {isDispatch ? "retirou" : "entregou"} os itens listados acima.
            Solicitado por {request?.requestedByName || "—"}.
          </p>
        </div>

        {/* Assinatura */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-center gap-2 text-xs font-black text-slate-900 uppercase tracking-wider">
            <PenLine size={16} className="text-gold-600" /> Sua assinatura
          </div>

          {error && (
            <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-bold border-l-4 border-red-500">
              {error}
            </div>
          )}

          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
              Seu nome completo *
            </label>
            <input
              type="text"
              value={driverName}
              onChange={e => setDriverName(e.target.value)}
              placeholder="Nome do motorista"
              className="w-full px-3 py-2.5 text-sm text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
            />
          </div>

          <div
            ref={containerRef}
            className="border-2 border-dashed border-slate-300 rounded-2xl overflow-hidden bg-slate-50/60 touch-none flex justify-center"
          >
            <SignatureCanvas
              ref={sigRef}
              penColor="#0f172a"
              canvasProps={{ width: canvasWidth, height: 200, className: "touch-none" }}
            />
          </div>
          <p className="text-[10px] text-slate-400 font-semibold text-center">
            Assine acima com o dedo.
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClear}
              disabled={submitting}
              className="px-4 py-3 border border-slate-200 text-slate-500 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-50 cursor-pointer flex items-center gap-1.5 disabled:opacity-40"
            >
              <Eraser size={14} /> Limpar
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} className="stroke-[3]" />}
              {submitting ? "Enviando..." : "Confirmar assinatura"}
            </button>
          </div>
        </div>

        <p className="text-center text-[10px] text-slate-400 font-bold pb-4">
          Central Stoque — documento assinado digitalmente
        </p>
      </div>
    </div>
  );
}
