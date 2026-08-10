import { Component, ErrorInfo, ReactNode } from "react";
import { RefreshCw, AlertTriangle } from "lucide-react";

// Matches the various "the chunk this tab referenced no longer exists on the
// server" errors thrown by dynamic import() across browsers. This is the #1
// cause of a blank white screen in a Vite SPA: a tab left open across a new
// deploy still holds the OLD index bundle, which points at OLD hashed chunk
// filenames (Vite/Rollup renames chunks per build) — the moment the user
// navigates to a lazy tab that changed, that fetch 404s. A plain reload fixes
// it instantly (fetches the new index.html + correct chunk URLs).
const CHUNK_LOAD_ERROR_PATTERN =
  /fetch dynamically imported module|importing a module script failed|loading chunk|chunkloaderror/i;

const RELOAD_GUARD_KEY = "central_stoque_auto_reload_ts";
const RELOAD_GUARD_WINDOW_MS = 15000; // never auto-reload more than once per 15s (avoids a loop if the server is genuinely down)

const SUPPORT_WHATSAPP = "5573991422872";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** "full" replaces the whole viewport; "panel" renders a smaller inline card so the surrounding shell (sidebar/header) stays usable. */
  variant?: "full" | "panel";
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // This project has no @types/react installed, so `Component`'s generic props/state
  // typing doesn't flow through automatically — redeclared explicitly (erased at
  // compile time, React's real base class already sets `this.props` at runtime).
  declare props: ErrorBoundaryProps;
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);

    if (CHUNK_LOAD_ERROR_PATTERN.test(error.message)) {
      const lastReload = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      if (Date.now() - lastReload > RELOAD_GUARD_WINDOW_MS) {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
        window.location.reload();
      }
    }
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isPanel = this.props.variant === "panel";
    const reportUrl = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(
      `Central Stoque - Encontrei um erro na tela:\n${error.message || "erro desconhecido"}`
    )}`;

    return (
      <div
        className={
          isPanel
            ? "flex flex-col items-center justify-center gap-3 py-16 px-6 text-center bg-white rounded-2xl border border-slate-200/70 shadow-sm animate-fadeIn"
            : "min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-[#eff6ff] animate-fadeIn"
        }
      >
        <div className="h-12 w-12 rounded-2xl bg-red-50 text-red-600 border border-red-100 flex items-center justify-center">
          <AlertTriangle size={22} className="stroke-[1.8]" />
        </div>
        <div className="space-y-1 max-w-sm">
          <h2 className="text-sm font-black text-slate-900">
            {isPanel ? "Não foi possível carregar esta seção" : "Algo deu errado"}
          </h2>
          <p className="text-xs text-slate-500 font-semibold leading-relaxed">
            {isPanel
              ? "Pode ser uma atualização recente do sistema. Recarregue a página para continuar."
              : "Ocorreu um erro inesperado. Recarregue a página — se o problema continuar, fale com o suporte."}
          </p>
        </div>
        <button
          type="button"
          onClick={this.handleReload}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-gold-600 to-amber-550 text-white rounded-xl text-xs font-extrabold shadow-md hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer"
        >
          <RefreshCw size={13} className="stroke-[2.5px]" /> Recarregar Página
        </button>
        {!isPanel && (
          <a
            href={reportUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] font-bold text-slate-400 hover:text-slate-600 underline cursor-pointer"
          >
            Reportar este problema via WhatsApp
          </a>
        )}
      </div>
    );
  }
}
