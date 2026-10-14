import { useEffect, useState } from "react";
import { localISODate } from "../utils";

// "Hoje" ("AAAA-MM-DD") para as telas que mostram promoção. Reavalia a cada
// minuto: a promoção que vence à meia-noite some da tela do vendedor que
// deixou o catálogo aberto, sem ninguém recarregar a página. O estado só muda
// quando a DATA muda, então o relógio não re-renderiza nada no resto do dia.
export function useToday(): string {
  const [today, setToday] = useState(() => localISODate());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localISODate();
      setToday(prev => (prev === next ? prev : next));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}
