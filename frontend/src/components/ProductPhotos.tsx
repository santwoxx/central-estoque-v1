import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, Check, ChevronLeft, ChevronRight, ImagePlus, Loader2, Star, Trash2, X } from "lucide-react";
import type { ProductPhoto, StockItem } from "../types";
import { formatDate } from "../utils";
import {
  buildPhoto,
  canEditProductPhotos,
  changeProductPhotos,
  compressPhotoFile,
  loadProductPhotos,
  MAX_PHOTOS_PER_PRODUCT,
  photoErrorMessage
} from "../utils/productPhotos";
import StoreChip from "./StoreChip";

// ─────────────────────────────────────────────────────────────────
// Fotos do pneu: a miniatura das listas e a janela que mostra, coloca e tira
// as fotos. Onde as fotos moram e quem pode mexer: utils/productPhotos.ts.
// ─────────────────────────────────────────────────────────────────

// O mesmo pneu desenhado que a lista de Cadastros já mostrava sem imagem.
export const TIRE_PLACEHOLDER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDQ5MzIxIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjYiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIyIi8+PHBhdGggZD0iTTEyIDJ2NCBNMTIgMTh2NCBNNC45MyA0LjkzbDIuODMgMi44MyBNMTYuMjQgMTYuMjRsMi44MyAyLjgzIE0yIDEyaDQgTTE4IDEyaDQgTTQuOTMgMTkuMDdsMi44My0yLjgzIE0xNi4yNCA3Ljc2bDIuODMtMi44MyIvPjwvc3ZnPg==";

type PhotoUser = { uid: string; displayName?: string; email?: string; role?: string; companyId?: string };

// ── Miniatura clicável das listas ─────────────────────────────────
// Mostra a capa. Sem foto, mostra o pneu desenhado e, para quem pode colocar
// foto, um selo de câmera — é o convite para fotografar.
export function ProductPhotoThumb({
  item,
  canEdit,
  onOpen,
  className = "h-10 w-10"
}: {
  item: StockItem;
  canEdit: boolean;
  onOpen: () => void;
  className?: string;
}) {
  const count = Number(item.photoCount) || 0;
  // A capa de verdade vem antes; a imagem antiga por link só enquanto não há foto.
  const src = item.photoThumb || (count === 0 ? item.imageUrl || "" : "");
  const clickable = count > 0 || canEdit;
  const label =
    count > 0
      ? `Ver ${count === 1 ? "a foto" : `as ${count} fotos`} deste pneu`
      : canEdit
      ? "Colocar fotos deste pneu"
      : "Pneu sem fotos";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (clickable) onOpen();
      }}
      disabled={!clickable}
      title={label}
      aria-label={label}
      className={`relative shrink-0 overflow-hidden rounded-lg border bg-slate-50 transition-all ${className} ${
        clickable ? "cursor-pointer border-slate-200 hover:border-gold-400 hover:shadow-sm" : "cursor-default border-slate-200"
      }`}
    >
      <img
        src={src || TIRE_PLACEHOLDER}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className={src ? "h-full w-full object-cover" : "h-full w-full object-contain p-1.5 opacity-70"}
      />
      {count > 1 && (
        <span className="absolute bottom-0 right-0 rounded-tl bg-slate-900/80 px-1 text-[8px] font-black leading-tight text-white">
          {count}
        </span>
      )}
      {count === 0 && canEdit && (
        <span className="absolute bottom-0 right-0 rounded-tl bg-gold-500 p-[3px] text-white">
          <Camera size={9} className="stroke-[2.5px]" />
        </span>
      )}
    </button>
  );
}

// ── Janela de fotos ───────────────────────────────────────────────
interface ProductPhotosModalProps {
  item: StockItem;
  // Ausente na consulta pública: a janela só mostra.
  user?: PhotoUser | null;
  onClose: () => void;
}

export default function ProductPhotosModal({ item, user, onClose }: ProductPhotosModalProps) {
  const canEdit = canEditProductPhotos(user, item);
  const [photos, setPhotos] = useState<ProductPhoto[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Uma leitura por abertura. Pneu que o estoque diz não ter foto nem consulta
  // o banco: é o caso da maioria, e cada consulta conta na cota diária.
  const announced = Number(item.photoCount) || 0;
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    if (announced === 0 && reloadKey === 0) {
      setPhotos([]);
      return;
    }
    setPhotos(null);
    loadProductPhotos(item.id)
      .then(list => {
        if (cancelled) return;
        setPhotos(list);
        setIndex(0);
      })
      .catch(err => {
        if (cancelled) return;
        setLoadError(photoErrorMessage(err, false));
        setPhotos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, reloadKey]);

  const list = photos || [];
  const currentIndex = list.length ? Math.min(index, list.length - 1) : 0;
  const current = list.length ? list[currentIndex] : null;

  const go = (delta: number) => {
    if (list.length < 2) return;
    setIndex((currentIndex + delta + list.length) % list.length);
  };

  // Esc fecha (menos no meio de um envio, que já está a caminho do banco);
  // as setas passam as fotos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (err) {
      setError(photoErrorMessage(err, true));
    } finally {
      setBusy("");
    }
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = e.target.files ? Array.from(e.target.files) : [];
    // Limpa o campo para a mesma foto poder ser escolhida de novo depois.
    e.target.value = "";
    if (!files.length || !user || photos === null) return;

    const free = MAX_PHOTOS_PER_PRODUCT - photos.length;
    if (free <= 0) {
      setError(`Este pneu já tem ${MAX_PHOTOS_PER_PRODUCT} fotos, o limite. Exclua uma para colocar outra.`);
      return;
    }
    const chosen = files.slice(0, free);
    const leftOut = files.length - chosen.length;

    await run(chosen.length > 1 ? `Preparando ${chosen.length} fotos...` : "Preparando a foto...", async () => {
      const prepared: ProductPhoto[] = [];
      for (let i = 0; i < chosen.length; i++) {
        if (chosen.length > 1) setBusy(`Preparando foto ${i + 1} de ${chosen.length}...`);
        prepared.push(buildPhoto(await compressPhotoFile(chosen[i]), user));
      }
      setBusy(prepared.length > 1 ? "Enviando as fotos..." : "Enviando a foto...");
      const next = await changeProductPhotos(item, { kind: "add", photos: prepared }, user);
      setPhotos(next);
      setIndex(Math.max(0, next.length - prepared.length));
      setNotice(
        (prepared.length > 1 ? `${prepared.length} fotos salvas.` : "Foto salva.") +
          (leftOut > 0
            ? ` ${leftOut} ficou${leftOut > 1 ? "aram" : ""} de fora: o limite é ${MAX_PHOTOS_PER_PRODUCT} fotos por pneu.`
            : "")
      );
    });
  };

  const handleRemove = (photo: ProductPhoto) => {
    if (!user) return;
    if (!window.confirm("Excluir esta foto do pneu? Não dá para desfazer.")) return;
    run("Excluindo a foto...", async () => {
      const next = await changeProductPhotos(item, { kind: "remove", photoId: photo.id }, user);
      setPhotos(next);
      setIndex(i => Math.max(0, Math.min(i, next.length - 1)));
      setNotice("Foto excluída.");
    });
  };

  const handleCover = (photo: ProductPhoto) => {
    if (!user) return;
    run("Trocando a capa...", async () => {
      const next = await changeProductPhotos(item, { kind: "cover", photoId: photo.id }, user);
      setPhotos(next);
      setIndex(0);
      setNotice("Pronto: esta é a capa que aparece na lista.");
    });
  };

  const title = `${item.size} ${item.brand} ${item.model}`.replace(/\s+/g, " ").trim();
  const ownStore = !!user?.companyId && user.companyId === item.companyId;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 p-3 backdrop-blur-xs sm:p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Fotos do pneu ${title}`}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl animate-scaleUp"
        onClick={e => e.stopPropagation()}
      >
        {/* Cabeçalho: qual pneu e de qual loja — a foto é DESTE documento. */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-black text-slate-900">
              <Camera size={15} className="text-gold-600" /> Fotos do pneu
            </h3>
            <p className="mt-0.5 truncate text-xs font-bold uppercase text-slate-700" title={title}>
              {title}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {item.companyName && <StoreChip name={item.companyName} own={ownStore} />}
              <span className="font-mono text-[9px] text-slate-400">{item.sku}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!!busy}
            className="shrink-0 rounded p-1 text-slate-400 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {photos === null ? (
            <div className="flex h-56 items-center justify-center gap-2 text-xs text-slate-400">
              <Loader2 size={16} className="animate-spin" /> Carregando fotos...
            </div>
          ) : loadError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <p className="flex items-start gap-1.5 font-semibold">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {loadError}
              </p>
              <button
                type="button"
                onClick={() => setReloadKey(k => k + 1)}
                className="mt-2 rounded border border-red-300 bg-white px-3 py-1 text-[11px] font-bold text-red-700 hover:bg-red-100 cursor-pointer"
              >
                Tentar de novo
              </button>
            </div>
          ) : current ? (
            <>
              <div className="relative flex h-[min(56vh,420px)] items-center justify-center overflow-hidden rounded-xl bg-slate-950">
                <img
                  src={current.dataUrl}
                  alt={`Foto ${currentIndex + 1} de ${list.length} — ${title}`}
                  className="max-h-full max-w-full object-contain"
                />
                {currentIndex === 0 && list.length > 1 && (
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-gold-500 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-white shadow">
                    <Star size={9} className="fill-current" /> Capa
                  </span>
                )}
                {list.length > 1 && (
                  <>
                    <span className="absolute right-2 top-2 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {currentIndex + 1}/{list.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => go(-1)}
                      className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-1.5 text-slate-800 shadow hover:bg-white cursor-pointer"
                      title="Foto anterior"
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => go(1)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-1.5 text-slate-800 shadow hover:bg-white cursor-pointer"
                      title="Próxima foto"
                    >
                      <ChevronRight size={18} />
                    </button>
                  </>
                )}
              </div>

              {list.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {list.map((photo, i) => (
                    <button
                      key={photo.id}
                      type="button"
                      onClick={() => setIndex(i)}
                      title={i === 0 ? "Foto 1 (capa)" : `Foto ${i + 1}`}
                      className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition-all cursor-pointer ${
                        i === currentIndex ? "border-gold-500" : "border-transparent opacity-70 hover:opacity-100"
                      }`}
                    >
                      <img src={photo.dataUrl} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}

              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  {currentIndex > 0 && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => handleCover(current)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                    >
                      <Star size={13} /> Usar como capa
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => handleRemove(current)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                  >
                    <Trash2 size={13} /> Excluir esta foto
                  </button>
                </div>
              )}

              <p className="text-[10px] text-slate-400">
                Colocada {current.addedByName ? `por ${current.addedByName} ` : ""}em {formatDate(current.addedAt)}.
              </p>
            </>
          ) : (
            <div className="flex h-48 flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 px-6 text-center">
              <Camera size={32} className="mb-2 text-slate-300" />
              <p className="text-sm font-bold text-slate-700">Nenhuma foto deste pneu ainda</p>
              <p className="mt-1 text-xs text-slate-500">
                {canEdit
                  ? "Tire uma foto agora ou escolha da galeria."
                  : "A loja ainda não colocou fotos deste pneu."}
              </p>
            </div>
          )}

          {busy && (
            <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800">
              <Loader2 size={14} className="animate-spin" /> {busy}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          {notice && !busy && (
            <div className="flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
              <Check size={14} className="mt-0.5 shrink-0 stroke-[3px]" /> {notice}
            </div>
          )}
        </div>

        {/* Só aparece para quem pode mexer, e só depois de saber o que já existe:
            com a leitura falhando, não dá para dizer quantas fotos ainda cabem. */}
        {canEdit && photos !== null && !loadError && (
          <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
            {list.length < MAX_PHOTOS_PER_PRODUCT ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => cameraRef.current?.click()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gold-500 px-3 py-2.5 text-xs font-black text-white shadow-sm hover:bg-gold-600 disabled:opacity-50 cursor-pointer"
                >
                  <Camera size={15} /> Tirar foto
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => galleryRef.current?.click()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                >
                  <ImagePlus size={15} /> Da galeria
                </button>
              </div>
            ) : (
              <p className="text-xs font-semibold text-slate-600">
                Este pneu já tem {MAX_PHOTOS_PER_PRODUCT} fotos, o limite. Exclua uma para colocar outra.
              </p>
            )}
            <p className="text-[10px] leading-snug text-slate-500">
              Até {MAX_PHOTOS_PER_PRODUCT} fotos por pneu; a primeira é a capa que aparece na lista. A foto é
              reduzida no aparelho antes de enviar e fica salva na hora.
            </p>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFiles}
            />
            <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} />
          </div>
        )}
      </div>
    </div>
  );
}
