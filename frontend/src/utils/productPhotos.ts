import { deleteDoc, doc, getDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import type { ProductPhoto, ProductPhotosDoc, StockItem } from "../types";

// ─────────────────────────────────────────────────────────────────
// Fotos dos pneus
//
// O dono da loja fotografa o pneu (câmera do celular ou galeria) e a foto fica
// presa ao DOCUMENTO de estoque daquela loja.
//
// ONDE AS FOTOS MORAM
// Fora do documento de estoque, de propósito. A coleção `stock` inteira é
// baixada por toda sessão do sistema e por todo visitante da consulta pública
// (App.tsx e PublicStock): com as fotos dentro dela, abrir o catálogo baixaria
// as fotos de todos os pneus de todas as lojas. Por isso:
//   • `stock_photos/{id do pneu}` guarda as fotos em tamanho de tela (até 4,
//     ~150 KB cada) e só desce quando alguém abre aquele pneu — uma leitura;
//   • o documento de estoque guarda só `photoCount` e `photoThumb`, a capa em
//     miniatura (~4 KB) que as listas mostram.
// As duas escritas vão na MESMA transação: a lista nunca anuncia uma foto que
// não existe nem esconde uma que existe.
//
// POR QUE BASE64 NO FIRESTORE E NÃO O STORAGE
// O Storage do Firebase exige o plano pago (Blaze) e este projeto roda no
// gratuito (ver firebase.ts). A foto vai comprimida dentro do Firestore — o
// mesmo caminho que a foto do papel assinado pelo motorista já usa
// (DriverSignature).
//
// QUEM PODE
// O administrador, em qualquer loja; o dono (alimentador), só nos pneus da
// própria loja; vendedor e consulta pública só veem. As regras do Firestore
// (`match /stock_photos`) repetem a mesma divisão no servidor.
// ─────────────────────────────────────────────────────────────────

export const PHOTOS_COLLECTION = "stock_photos";
export const MAX_PHOTOS_PER_PRODUCT = 4;

// Foto em tamanho de tela. 1024 px no lado maior mostra a banda e o flanco do
// pneu (medida, DOT) e quase sempre cabe em ~150 KB. Foto que não cabe é
// reduzida de novo antes de desistir.
const PHOTO_SIZES = [1024, 800, 640];
const PHOTO_MAX_CHARS = 200_000;
// 4 fotos × 200 mil caracteres = 800 mil. O documento do Firestore tem teto
// de 1 MiB, e o resto é folga para os outros campos.
const DOC_MAX_CHARS = 900_000;

// Miniatura da capa: quadrada, recortada no centro. 96 px cobre a célula da
// tabela e o cartão do celular sem pesar a coleção `stock` (ver acima).
const THUMB_SIZE = 96;
const THUMB_MAX_CHARS = 6_000;

type PhotoUser = { uid?: string; displayName?: string; email?: string; role?: string; companyId?: string };

export type PhotoChange =
  | { kind: "add"; photos: ProductPhoto[] }
  | { kind: "remove"; photoId: string }
  | { kind: "cover"; photoId: string };

// A mesma regra das regras do Firestore, para a tela não oferecer o que o
// banco vai recusar. O papel "user" é o dono antigo — as regras o tratam como
// alimentador (isAlimentador).
export function canEditProductPhotos(
  user: PhotoUser | null | undefined,
  item: { companyId?: string } | null | undefined
): boolean {
  if (!user || !item || !user.uid) return false;
  if (user.role === "admin") return true;
  if (user.role !== "alimentador" && user.role !== "user") return false;
  return !!user.companyId && item.companyId === user.companyId;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Não foi possível abrir a imagem."));
    img.src = src;
  });
}

function newCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Este navegador não conseguiu processar a foto.");
  // JPEG não tem transparência: PNG com fundo transparente sairia preto.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

function toJpeg(ctx: CanvasRenderingContext2D, quality: number): string {
  const out = ctx.canvas.toDataURL("image/jpeg", quality);
  // Canvas grande demais para o aparelho devolve "data:," em vez de erro.
  if (!out.startsWith("data:image/jpeg")) {
    throw new Error("Este aparelho não conseguiu converter a foto. Tente uma foto menor.");
  }
  return out;
}

// Reduz e comprime a foto NO APARELHO, antes de qualquer envio: uma foto de
// celular tem 3 a 6 MB, e o que sobe é ~150 KB.
export async function compressPhotoFile(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error(`"${file.name}" não é uma foto.`);
  }

  const url = URL.createObjectURL(file);
  try {
    let img: HTMLImageElement;
    try {
      img = await loadImage(url);
    } catch {
      throw new Error(`Não foi possível abrir "${file.name}". Envie a foto em JPG ou PNG.`);
    }

    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) throw new Error(`"${file.name}" está vazia ou corrompida.`);

    for (const maxDim of PHOTO_SIZES) {
      const scale = Math.min(1, maxDim / Math.max(w0, h0));
      const width = Math.max(1, Math.round(w0 * scale));
      const height = Math.max(1, Math.round(h0 * scale));
      const ctx = newCanvas(width, height);
      ctx.drawImage(img, 0, 0, width, height);

      for (let quality = 0.8; quality >= 0.45; quality -= 0.1) {
        const dataUrl = toJpeg(ctx, quality);
        if (dataUrl.length <= PHOTO_MAX_CHARS) return { dataUrl, width, height };
      }
    }
    throw new Error("A foto ficou grande demais mesmo depois de reduzida. Tente outra foto.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function makeThumbnail(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  const side = Math.min(w0, h0);
  const ctx = newCanvas(THUMB_SIZE, THUMB_SIZE);
  ctx.drawImage(img, (w0 - side) / 2, (h0 - side) / 2, side, side, 0, 0, THUMB_SIZE, THUMB_SIZE);

  let out = "";
  for (const quality of [0.65, 0.5, 0.35]) {
    out = toJpeg(ctx, quality);
    if (out.length <= THUMB_MAX_CHARS) break;
  }
  return out;
}

function newPhotoId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export function buildPhoto(
  compressed: { dataUrl: string; width: number; height: number },
  user: PhotoUser
): ProductPhoto {
  return {
    id: newPhotoId(),
    dataUrl: compressed.dataUrl,
    width: compressed.width,
    height: compressed.height,
    addedAt: new Date().toISOString(),
    addedByUid: user.uid || "",
    addedByName: user.displayName || user.email || ""
  };
}

// Leitura tolerante: o que não for uma foto válida fica de fora, em vez de
// quebrar a tela inteira por causa de um item.
function readPhotos(data: any): ProductPhoto[] {
  const list = Array.isArray(data?.photos) ? data.photos : [];
  return list.filter(
    (p: any): p is ProductPhoto =>
      !!p && typeof p.id === "string" && typeof p.dataUrl === "string" && p.dataUrl.startsWith("data:image/")
  );
}

export async function loadProductPhotos(stockItemId: string): Promise<ProductPhoto[]> {
  const snap = await getDoc(doc(db, PHOTOS_COLLECTION, stockItemId));
  return snap.exists() ? readPhotos(snap.data()) : [];
}

function applyChange(current: ProductPhoto[], change: PhotoChange): ProductPhoto[] {
  if (change.kind === "remove") return current.filter(p => p.id !== change.photoId);

  if (change.kind === "cover") {
    const idx = current.findIndex(p => p.id === change.photoId);
    if (idx <= 0) return current;
    return [current[idx], ...current.slice(0, idx), ...current.slice(idx + 1)];
  }

  // A tela já corta o que não cabe; esta conferência vale contra o que está no
  // SERVIDOR — outra pessoa pode ter colocado fotos no mesmo pneu agora há pouco.
  const free = MAX_PHOTOS_PER_PRODUCT - current.length;
  if (change.photos.length > free) {
    throw new Error(
      free <= 0
        ? `Este pneu já tem ${MAX_PHOTOS_PER_PRODUCT} fotos, o limite. Exclua uma para colocar outra.`
        : `Só cabe${free > 1 ? "m" : ""} mais ${free} foto${free > 1 ? "s" : ""} neste pneu.`
    );
  }
  const next = [...current, ...change.photos];
  const total = next.reduce((acc, p) => acc + p.dataUrl.length, 0);
  if (total > DOC_MAX_CHARS) {
    throw new Error("As fotos deste pneu passaram do tamanho máximo. Exclua uma foto antes de colocar outra.");
  }
  return next;
}

// Coloca, tira ou troca a capa — sempre numa transação que lê o estado do
// SERVIDOR, para duas pessoas mexendo no mesmo pneu não apagarem a foto uma da
// outra. Devolve a lista como ficou.
export async function changeProductPhotos(
  item: StockItem,
  change: PhotoChange,
  user: PhotoUser
): Promise<ProductPhoto[]> {
  const stockRef = doc(db, "stock", item.id);
  const photosRef = doc(db, PHOTOS_COLLECTION, item.id);

  // A transação pode rodar mais de uma vez; a miniatura de cada foto é
  // calculada uma vez só.
  const thumbs = new Map<string, string>();
  const thumbOf = async (photo: ProductPhoto) => {
    if (!thumbs.has(photo.id)) thumbs.set(photo.id, await makeThumbnail(photo.dataUrl));
    return thumbs.get(photo.id)!;
  };

  let result: ProductPhoto[] = [];
  await runTransaction(db, async (tx) => {
    const stockSnap = await tx.get(stockRef);
    if (!stockSnap.exists()) {
      throw new Error("Este pneu não existe mais no estoque. Atualize a tela.");
    }
    const photosSnap = await tx.get(photosRef);
    const stockData: any = stockSnap.data();
    const next = applyChange(photosSnap.exists() ? readPhotos(photosSnap.data()) : [], change);
    const thumb = next.length > 0 ? await thumbOf(next[0]) : "";

    if (next.length > 0) {
      const photosDoc: ProductPhotosDoc = {
        stockItemId: item.id,
        // A loja vem do documento de estoque, não da tela: é ela que as regras
        // conferem.
        companyId: stockData.companyId || "",
        sku: stockData.sku || item.sku || "",
        photos: next,
        updatedAt: serverTimestamp(),
        updatedByUid: user.uid || "",
        updatedByName: user.displayName || user.email || ""
      };
      tx.set(photosRef, photosDoc);
    } else if (photosSnap.exists()) {
      tx.delete(photosRef);
    }

    tx.update(stockRef, {
      photoCount: next.length,
      photoThumb: thumb,
      // A foto de verdade aposenta a imagem ilustrativa antiga (link).
      ...(next.length > 0 && stockData.imageUrl ? { imageUrl: "" } : {}),
      updatedAt: serverTimestamp()
    });
    result = next;
  });
  return result;
}

// Limpeza depois de excluir o pneu. Nunca bloqueia a exclusão: uma foto que
// sobrar ocupa espaço, mas não aparece em lugar nenhum.
export async function deleteProductPhotosDoc(stockItemId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, PHOTOS_COLLECTION, stockItemId));
  } catch (err) {
    console.warn(`[FOTOS] Não foi possível apagar as fotos do pneu ${stockItemId}:`, err);
  }
}

// A causa real chega à tela: permissão, conexão e limite pedem ações diferentes.
export function photoErrorMessage(err: unknown, saving: boolean): string {
  const code = (err as any)?.code;
  const message = (err as any)?.message || "";
  if (!code) return message || (saving ? "Não foi possível salvar a foto." : "Não foi possível carregar as fotos.");
  if (code === "permission-denied") {
    return saving
      ? "O banco não liberou a gravação. Só o dono da loja do pneu ou o administrador coloca fotos. " +
        "Se a função de fotos acabou de entrar no sistema, falta o administrador publicar as regras novas do banco."
      : "O banco não liberou as fotos. Se a função de fotos acabou de entrar no sistema, " +
        "falta o administrador publicar as regras novas do banco.";
  }
  if (code === "unavailable" || code === "deadline-exceeded") {
    return saving
      ? "Sem conexão com o banco: a foto não foi salva. Verifique a internet e tente de novo."
      : "Sem conexão com o banco para carregar as fotos. Verifique a internet e tente de novo.";
  }
  if (code === "invalid-argument" && /size|bytes|large/i.test(message)) {
    return "As fotos deste pneu passaram do limite de tamanho do banco. Exclua uma foto e tente de novo.";
  }
  if (code === "resource-exhausted") {
    return "O banco atingiu o limite de uso do plano por hoje. Tente de novo mais tarde.";
  }
  return `${saving ? "Erro ao salvar a foto" : "Erro ao carregar as fotos"} (${code}).`;
}
