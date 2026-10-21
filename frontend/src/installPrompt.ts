// ─────────────────────────────────────────────────────────────────
// Pedido de instalação do navegador (Android: Chrome, Edge, Samsung)
//
// O navegador oferece o pedido UMA vez, cedo (`beforeinstallprompt`), e ele só
// pode ser disparado depois de um toque da pessoa. Fica guardado aqui, num
// módulo que a entrada (main.tsx) já carrega, porque a tela do catálogo chega
// depois e perderia o evento.
//
// O iPhone não tem esse evento: lá a instalação é pelo menu Compartilhar do
// Safari, e o catálogo ensina o caminho (ver components/InstallCatalog.tsx).
// ─────────────────────────────────────────────────────────────────
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", event => {
    // Sem isto o Chrome mostra a própria faixa de instalação, e o botão do
    // catálogo não teria o que disparar.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function hasInstallPrompt(): boolean {
  return deferred !== null;
}

export function onInstallPromptChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Abre o pedido do navegador. O evento vale uma vez só: usado, é descartado.
export async function runInstallPrompt(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  notify();
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome === "accepted";
}
