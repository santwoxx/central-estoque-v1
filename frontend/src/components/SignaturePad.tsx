import { useEffect, useRef, useState } from "react";
import SignatureCanvas from "react-signature-canvas";
import { PenLine, X, Eraser, Check, User, Loader2, Truck } from "lucide-react";

interface SignaturePadProps {
  title: string;
  subtitle?: string;
  roleLabel: string;      // "Assinatura do Remetente" / "Assinatura do Recebedor"
  signerName: string;     // quem está assinando (usuário logado)
  confirmLabel?: string;
  nextStepHint?: string;  // o que acontece depois de confirmar
  onConfirm: (signatureDataUrl: string) => void | Promise<void>;
  onClose: () => void;
}

// Coleta UMA assinatura — a do responsável interno (remetente ou recebedor).
// A via do motorista tem fluxo próprio (link público ou foto do papel) e vive
// em DriverSignature.tsx: são momentos e pessoas diferentes, e juntar as duas
// numa tela só obrigava o motorista a estar do lado do computador.
export default function SignaturePad({
  title,
  subtitle,
  roleLabel,
  signerName,
  confirmLabel = "Confirmar assinatura",
  nextStepHint,
  onConfirm,
  onClose
}: SignaturePadProps) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const sigRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(360);

  useEffect(() => {
    const measure = () => {
      if (containerRef.current) setCanvasWidth(Math.max(containerRef.current.clientWidth, 260));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const handleClear = () => {
    sigRef.current?.clear();
    setError("");
  };

  const handleConfirm = async () => {
    if (!sigRef.current || sigRef.current.isEmpty()) {
      setError("Desenhe a assinatura no quadro antes de confirmar.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const canvasInstance = typeof sigRef.current.getTrimmedCanvas === "function"
        ? sigRef.current.getTrimmedCanvas()
        : sigRef.current.getCanvas();
      await onConfirm(canvasInstance.toDataURL("image/png"));
    } catch (err: any) {
      console.error("Erro ao capturar assinatura:", err);
      setError(err?.message || "Erro ao registrar a assinatura. Tente novamente.");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60] animate-fadeIn">
      <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <PenLine size={16} className="text-gold-600 shrink-0" /> {title}
            </h3>
            {subtitle && <p className="text-[11px] text-slate-500 font-semibold mt-1 leading-relaxed">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-semibold border-l-4 border-red-500">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
          <User size={18} className="text-slate-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-bold text-slate-700 uppercase tracking-wide">{roleLabel}</div>
            <div className="text-[11px] font-semibold text-slate-500 truncate">{signerName}</div>
          </div>
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
          Assine no quadro acima com o dedo (celular/tablet) ou o mouse.
        </p>

        {nextStepHint && (
          <div className="flex items-start gap-2 bg-gold-50/60 border border-gold-200/60 rounded-xl p-3">
            <Truck size={14} className="text-gold-700 shrink-0 mt-0.5" />
            <p className="text-[11px] font-bold text-gold-800 leading-snug">{nextStepHint}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={handleClear}
            disabled={submitting}
            className="px-3.5 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer flex items-center gap-1.5 disabled:opacity-40"
          >
            <Eraser size={13} /> Limpar
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {submitting ? "Registrando..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
