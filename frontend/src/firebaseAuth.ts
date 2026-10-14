import { getAuth } from "firebase/auth";
import { app } from "./firebase";

// Authentication separado de firebase.ts: só o sistema com login (App e tela
// de entrada) importa este arquivo. As páginas públicas leem o banco sem ele.
export const auth = getAuth(app);
