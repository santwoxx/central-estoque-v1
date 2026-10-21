import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Compass, Download, Ellipsis, Share, Smartphone, SquarePlus, X } from "lucide-react";
import { hasInstallPrompt, onInstallPromptChange, runInstallPrompt } from "../installPrompt";

// ─────────────────────────────────────────────────────────────────
// Instalar o catálogo público como app
//
// iPhone/iPad: nenhum site consegue se instalar sozinho — o Safari só permite
// pelo menu Compartilhar → "Adicionar à Tela de Início". O que dá para fazer é
// ENSINAR, na hora certa: um botão no cabeçalho do catálogo e, na primeira
// visita, um aviso discreto no rodapé — os dois abrem o passo a passo. Nome,
// ícone e página inicial do app vêm de consulta.html e consulta.webmanifest.
//
// Android (Chrome, Edge, Samsung): o navegador oferece o pedido de instalação
// (guardado em installPrompt.ts); aí o botão instala direto, sem passo a passo.
//
// Aberto como app (pela Tela de Início), nada disso aparece.
// ─────────────────────────────────────────────────────────────────

const HINT_KEY = "catalogo_aviso_instalar_fechado_em";
const HINT_SNOOZE_DAYS = 21;

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// iPadOS se apresenta como Mac — o toque é o que o denuncia.
function appleDevice(): "iPhone" | "iPad" | null {
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone|iPod/i.test(ua)) return "iPhone";
  return null;
}

// Navegador embutido de outro app: lá não existe "Adicionar à Tela de Início".
// O do WhatsApp não se identifica — por isso o passo a passo sempre lembra dele.
function embeddedBrowser(): string | null {
  const ua = navigator.userAgent;
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook";
  return null;
}

// Chrome, Firefox e Edge do iPhone têm o Compartilhar no topo, ao lado do endereço.
function otherIOSBrowser(): boolean {
  return /CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);
}

function hintSnoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(HINT_KEY) || 0);
    return at > 0 && Date.now() - at < HINT_SNOOZE_DAYS * 86400000;
  } catch {
    return false;
  }
}

function snoozeHint(): void {
  try {
    localStorage.setItem(HINT_KEY, String(Date.now()));
  } catch {
    // Navegação privada: o aviso volta na próxima visita, e tudo bem.
  }
}

export default function InstallCatalog() {
  const [standalone] = useState(isStandalone);
  const [device] = useState(appleDevice);
  const [canPrompt, setCanPrompt] = useState(hasInstallPrompt);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);

  useEffect(() => onInstallPromptChange(() => setCanPrompt(hasInstallPrompt())), []);

  // Aviso da primeira visita, só no iPhone/iPad e depois de a página assentar:
  // surgir junto com o catálogo ainda carregando seria só ruído.
  useEffect(() => {
    if (standalone || !device || hintSnoozed()) return;
    const timer = window.setTimeout(() => setHintVisible(true), 2500);
    return () => window.clearTimeout(timer);
  }, [standalone, device]);

  if (standalone || (!device && !canPrompt)) return null;

  const closeHint = () => {
    snoozeHint();
    setHintVisible(false);
  };

  const install = async () => {
    if (device) {
      closeHint();
      setSheetOpen(true);
      return;
    }
    await runInstallPrompt();
  };

  const embedded = embeddedBrowser();

  return (
    <>
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white text-[11px] font-bold tracking-wide transition-colors cursor-pointer"
      >
        {device ? <Smartphone size={13} className="stroke-[2.5px]" /> : <Download size={13} className="stroke-[2.5px]" />}
        {device ? `Instalar no ${device}` : "Instalar app"}
      </button>

      {hintVisible && !sheetOpen && createPortal(
        <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-events-none">
          <div className="pointer-events-auto mx-auto max-w-md flex items-center gap-3 p-3 rounded-2xl bg-slate-900 text-white border border-white/10 shadow-2xl animate-fadeIn">
            <img src="/icons/icon-192.png" alt="" className="h-11 w-11 rounded-xl shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-black leading-tight">Instale o catálogo no {device}</p>
              <p className="text-[11px] text-slate-300 leading-snug">Abre como um app, direto da tela de início.</p>
            </div>
            <button
              type="button"
              onClick={install}
              className="shrink-0 px-3 py-2 rounded-xl bg-gold-500 hover:bg-gold-600 text-white text-[11px] font-black cursor-pointer"
            >
              Como instalar
            </button>
            <button type="button" onClick={closeHint} aria-label="Fechar aviso" className="shrink-0 p-1 text-slate-400 hover:text-white cursor-pointer">
              <X size={16} />
            </button>
          </div>
        </div>,
        document.body
      )}

      {sheetOpen && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-fadeIn"
          onClick={() => setSheetOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Como instalar o catálogo"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
          >
            <div className="flex items-start gap-3">
              <img src="/icons/icon-192.png" alt="" className="h-12 w-12 rounded-xl shrink-0" />
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-black text-slate-900 leading-tight">Instalar o Catálogo</h3>
                <p className="mt-0.5 text-xs font-semibold text-slate-500 leading-snug">
                  Fica na tela de início do seu {device}, com ícone próprio, e abre em tela cheia — sem App
                  Store e sem ocupar espaço.
                </p>
              </div>
              <button type="button" onClick={() => setSheetOpen(false)} aria-label="Fechar" className="p-1 -mr-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer">
                <X size={18} />
              </button>
            </div>

            {embedded && (
              <p className="mt-4 flex items-start gap-2 text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
                <Compass size={15} className="shrink-0 mt-px" />
                Você abriu o catálogo dentro do {embedded}, e lá não dá para instalar. Toque em ••• e escolha
                “Abrir no navegador” (Safari) — depois siga os passos abaixo.
              </p>
            )}

            <ol className="mt-4 space-y-3">
              <li className="flex items-start gap-3">
                <span className="shrink-0 h-9 w-9 rounded-xl bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center">
                  <Share size={18} className="stroke-[2.25px]" />
                </span>
                <div className="min-w-0 text-sm text-slate-700 leading-snug">
                  <p className="font-black text-slate-900">1. Toque em Compartilhar</p>
                  <p className="text-xs font-semibold text-slate-500">
                    {otherIOSBrowser() ? (
                      "Fica no topo, ao lado do endereço da página."
                    ) : (
                      <>
                        Na barra do Safari. Se não aparecer, toque antes em{" "}
                        <Ellipsis size={13} className="inline -mt-px" aria-label="três pontos" />.
                      </>
                    )}
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="shrink-0 h-9 w-9 rounded-xl bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center">
                  <SquarePlus size={18} className="stroke-[2.25px]" />
                </span>
                <div className="min-w-0 text-sm text-slate-700 leading-snug">
                  <p className="font-black text-slate-900">2. Toque em “Adicionar à Tela de Início”</p>
                  <p className="text-xs font-semibold text-slate-500">Se não estiver à vista, role a lista para baixo.</p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="shrink-0 h-9 w-9 rounded-xl bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center">
                  <Check size={18} className="stroke-[2.5px]" />
                </span>
                <div className="min-w-0 text-sm text-slate-700 leading-snug">
                  <p className="font-black text-slate-900">3. Toque em “Adicionar”</p>
                  <p className="text-xs font-semibold text-slate-500">
                    Se aparecer “Abrir como App Web”, deixe ligado. Pronto: o ícone Catálogo fica na tela de início.
                  </p>
                </div>
              </li>
            </ol>

            {!embedded && (
              <p className="mt-4 text-[11px] font-semibold text-slate-400 leading-snug">
                Abriu pelo WhatsApp e não achou o Compartilhar? Toque antes no ícone do Safari{" "}
                <Compass size={12} className="inline -mt-px" aria-label="bússola" /> para abrir a página no Safari.
              </p>
            )}

            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="mt-5 w-full py-3 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-black cursor-pointer transition-colors"
            >
              Entendi
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
