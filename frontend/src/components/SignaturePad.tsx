import React, { useEffect, useRef, useState } from "react";
import SignatureCanvas from "react-signature-canvas";
import { PenLine, X, Eraser, Check, User, Truck } from "lucide-react";

interface SignaturePadProps {
  mode: "delivery" | "receipt";
  subtitle?: string;
  onConfirm: (internalSignature: string, driverSignature: string, driverName: string) => void;
  onClose: () => void;
}

export default function SignaturePad({ mode, subtitle, onConfirm, onClose }: SignaturePadProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [internalSigUrl, setInternalSigUrl] = useState("");
  const [driverName, setDriverName] = useState("");
  const [error, setError] = useState("");

  const sigRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(360);

  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setCanvasWidth(Math.max(containerRef.current.clientWidth, 260));
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step]); // re-measure if step changes just in case

  const handleClear = () => {
    sigRef.current?.clear();
    setError("");
  };

  const handleNext = () => {
    if (!sigRef.current || sigRef.current.isEmpty()) {
      setError("Desenhe a assinatura no quadro antes de continuar.");
      return;
    }
    try {
      const canvasInstance = typeof sigRef.current.getTrimmedCanvas === "function"
        ? sigRef.current.getTrimmedCanvas() : sigRef.current.getCanvas();
      const dataUrl = canvasInstance.toDataURL("image/png");
      setInternalSigUrl(dataUrl);
      setStep(2);
      setError("");
      setTimeout(() => sigRef.current?.clear(), 50);
    } catch (err) {
      console.error("Erro ao capturar assinatura:", err);
      setError("Erro ao capturar a assinatura. Tente novamente.");
    }
  };

  const handleConfirmFinal = () => {
    if (!driverName.trim()) {
      setError("Informe o nome do motorista.");
      return;
    }
    if (!sigRef.current || sigRef.current.isEmpty()) {
      setError("O motorista deve desenhar a assinatura no quadro.");
      return;
    }
    try {
      const canvasInstance = typeof sigRef.current.getTrimmedCanvas === "function"
        ? sigRef.current.getTrimmedCanvas() : sigRef.current.getCanvas();
      const dataUrl = canvasInstance.toDataURL("image/png");
      onConfirm(internalSigUrl, dataUrl, driverName.trim());
    } catch (err) {
      console.error("Erro ao capturar assinatura do motorista:", err);
      setError("Erro ao capturar a assinatura. Tente novamente.");
    }
  };

  const isDelivery = mode === "delivery";

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60] animate-fadeIn">
      <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <PenLine size={16} className="text-gold-600 shrink-0" /> 
              {isDelivery ? "Assinaturas de Envio" : "Assinaturas de Recebimento"}
            </h3>
            {subtitle && <p className="text-[11px] text-slate-500 font-semibold mt-1 leading-relaxed">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-650 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {/* STEP INDICATOR */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className={`h-1.5 w-1/3 rounded-full transition-colors ${step >= 1 ? 'bg-gold-500' : 'bg-slate-200'}`} />
          <div className={`h-1.5 w-1/3 rounded-full transition-colors ${step >= 2 ? 'bg-gold-500' : 'bg-slate-200'}`} />
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-semibold border-l-4 border-red-500">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
            {step === 1 ? (
              <User size={18} className="text-slate-500" />
            ) : (
              <Truck size={18} className="text-slate-500" />
            )}
            <div className="text-xs font-bold text-slate-700 uppercase tracking-wide">
              Passo {step} de 2:{" "}
              {step === 1 
                ? (isDelivery ? "Assinatura do Remetente" : "Assinatura do Recebedor") 
                : "Assinatura do Motorista"}
            </div>
          </div>

          {step === 2 && (
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1.5">
                Nome do Motorista *
              </label>
              <input
                type="text"
                value={driverName}
                onChange={e => setDriverName(e.target.value)}
                placeholder="Ex: João da Silva"
                className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
              />
            </div>
          )}

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
          <p className="text-[10px] text-slate-400 font-semibold text-center mt-1">
            Assine no quadro acima com o dedo (celular/tablet) ou o mouse.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={handleClear}
            className="px-3.5 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer flex items-center gap-1.5"
          >
            <Eraser size={13} /> Limpar
          </button>
          
          <div className="flex gap-2">
            {step === 2 && (
              <button
                type="button"
                onClick={() => { setStep(1); setError(""); }}
                className="px-4 py-2 border border-slate-200 text-slate-500 rounded-xl text-xs font-extrabold hover:bg-slate-50 cursor-pointer"
              >
                Voltar
              </button>
            )}
            
            {step === 1 ? (
              <button
                type="button"
                onClick={handleNext}
                className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5"
              >
                Próximo Passo
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConfirmFinal}
                className="px-4 py-2 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Check size={13} /> Confirmar Assinaturas
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
