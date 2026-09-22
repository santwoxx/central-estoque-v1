#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────
# Relatório de estoque do ERP Time Sistemas (PDF) → JSON de carga do sistema
#
#   python tools/estoque-time-sistemas.py <relatorio.pdf> <PREFIXO> <saida.json> [--loja=Nome] [--varejo-nos-dois]
#
# Exemplo (Valença, 22/09/2026):
#   python tools/estoque-time-sistemas.py "estoque valencia.pdf" VALENCA frontend/src/valenca_estoque.json --loja=Valença
#
# O JSON gerado é o que o botão "Injetar Estoque <loja>" (Cadastros e Ajustes,
# só administrador) carrega. A carga pula todo código que já existe na loja,
# então rodar este script de novo e recarregar não duplica nada.
#
# O que ele faz, e por quê:
#   • Lê o PDF pelas POSIÇÕES das colunas (modo "layout" do pypdf), não por
#     espaço: há descrições com espaço duplo no meio, e o campo Referência às
#     vezes vem preenchido com lixo (ex.: um preço digitado ali).
#   • CONFERE contra o rodapé do próprio relatório (quantidade de produtos,
#     saldo e os dois totais em R$). Se não bater centavo por centavo, para sem
#     gravar nada — um JSON incompleto viraria estoque errado.
#   • Separa medida / marca / modelo por dicionário de marcas, e não pela
#     "primeira palavra depois da medida" (que gerava marcas como "R" e "XL").
#   • Preços: à vista = P. Atacado, a prazo = P. Varejo. No ERP o Varejo é
#     sempre Atacado + 4%, a mesma regra das outras lojas no sistema.
#     `--varejo-nos-dois` usa o Varejo nos dois campos.
#   • Câmaras de ar, protetores e rodas entram com a categoria no campo marca
#     ("CAMARA DE AR", "PROTETOR", "RODA"), para ficarem separadas dos pneus
#     nos filtros. A descrição original do ERP fica sempre em `description`.
#
# Requer: pip install pypdf
# ─────────────────────────────────────────────────────────────────
import re, json, io, sys, os
from collections import Counter
from pypdf import PdfReader

if len(sys.argv) < 4:
    print("uso: estoque-time-sistemas.py <relatorio.pdf> <PREFIXO> <saida.json> [--loja=Nome] [--varejo-nos-dois]")
    sys.exit(2)

PDF, PREFIX, OUT = sys.argv[1], sys.argv[2].upper(), sys.argv[3]
PRICE_MODE = "varejo_ambos" if "--varejo-nos-dois" in sys.argv else "atacado_vista"
STORE = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--loja=")), PREFIX.title())

DESC_COL = 45   # descrição começa na coluna 51; antes dela (após o código) ficam referência e código de barras
REF_MAX = 28    # referência fica por volta da coluna 17; código de barras entre 31 e 39

num = lambda s: float(s.replace(".", "").replace(",", "."))

seg = re.compile(r"\S+(?: \S+)*")

rows, footer, report_date = [], None, ""
for pi, page in enumerate(PdfReader(PDF).pages, 1):
    for line in page.extract_text(extraction_mode="layout").splitlines():
        parts = [(m.start(), m.group()) for m in seg.finditer(line)]
        if not parts:
            continue
        text = line.strip()
        dm = re.search(r"(\d{2}/\d{2}/\d{4} \d{2}:\d{2})", text)
        if dm and "Time Sistemas" in text:
            report_date = dm.group(1)
        if "Quantidade de produtos na lista" in text:
            nums = re.findall(r"[\d.]+,\d+|\d+", text.split(":", 1)[1])
            footer = {"produtos": int(nums[0]), "saldo": num(nums[1]), "varejo": num(nums[2]), "atacado": num(nums[3])}
            continue
        # Linha de produto: começa com o código e tem "UN" seguido de 3 números.
        if not re.fullmatch(r"\d+", parts[0][1]):
            continue
        un_idx = next((i for i, (_, t) in enumerate(parts) if t == "UN"), None)
        if un_idx is None or len(parts) < un_idx + 4:
            continue
        codigo = parts[0][1]
        ref, barcode = "", ""
        desc_parts = []
        for col, t in parts[1:un_idx]:
            if col >= DESC_COL:
                desc_parts.append(t)
            elif col < REF_MAX:
                ref = t
            else:
                barcode = t
        saldo, varejo, atacado = (num(parts[un_idx + k][1]) for k in (1, 2, 3))
        rows.append({
            "page": pi, "codigo": codigo, "referencia": ref, "barcode": barcode,
            "descricao": " ".join(desc_parts), "saldo": saldo, "varejo": varejo, "atacado": atacado
        })


tot = {
    "produtos": len(rows),
    "saldo": round(sum(r["saldo"] for r in rows), 3),
    "varejo": round(sum(r["saldo"] * r["varejo"] for r in rows), 2),
    "atacado": round(sum(r["saldo"] * r["atacado"] for r in rows), 2),
}
if not footer or any(abs(footer[k] - tot[k]) >= 0.005 for k in footer):
    print("NÃO CONFERE com o rodapé do relatório — nada foi gravado.")
    print("  rodapé  :", footer)
    print("  extraído:", tot)
    sys.exit(1)
dups = sorted({r["codigo"] for r in rows if [x["codigo"] for x in rows].count(r["codigo"]) > 1})
if dups:
    print("Códigos repetidos no relatório:", dups, "— nada foi gravado.")
    sys.exit(1)
print(f"Conferido com o rodapé: {tot['produtos']} produtos, {int(tot['saldo'])} un, "
      f"varejo R$ {tot['varejo']:,.2f}, atacado R$ {tot['atacado']:,.2f}")

old = []
if os.path.exists(OUT):
    try:
        old = json.load(io.open(OUT, encoding="utf-8"))
    except Exception:
        old = []

# ── Marcas: nome oficial ← como o ERP escreve (inclusive truncado pela coluna)
BRANDS = [
    ("MAXTREK", ["MAXTREK", "MAXTRE"]),
    ("TERRENA", ["TERRENA"]),
    ("SPEEDMAX", ["SPEEDMAX"]),
    ("ATLANDER", ["ATLANDER"]),
    ("DYNAMO", ["DYNAMO"]),
    ("COMFORSER", ["COMFORSER"]),
    ("CONTINENTAL", ["CONTINENTAL", "CONT"]),
    ("LANDSPIDER", ["LANDSPIDER"]),
    ("COMPASAL", ["COMPASAL", "COMPAS"]),
    ("BLACKARROW", ["BLACKARROW"]),
    ("DOVROAD", ["DOVROAD"]),
    ("ONYX", ["ONYX"]),
    ("APTANY", ["APTANY"]),
    ("WANLI", ["WANLI"]),
    ("ZMAX", ["ZMAX"]),
    ("AUTOGREEN", ["AUTOGREEN", "AUTOGREE"]),
    ("HAIDA", ["HAIDA"]),
    ("XBRI", ["XBRI", "XBR", "XB"]),
    ("LINGLONG", ["LINGLONG"]),
    ("WESTLAKE", ["WESTLAKE"]),
    ("FARROAD", ["FARROAD"]),
    ("SUNSET", ["SUNSET"]),
    ("TRAZANO", ["TRAZANO"]),
    ("GRIPMASTER", ["GRIPMASTER"]),
    ("LONGMARCH", ["LONGMARCH"]),
    ("ARISUN", ["ARISUN"]),
    ("BONNA", ["BONNA"]),
    ("FLEXEN", ["FLEXEN"]),
]
ALIAS = {a: canon for canon, aliases in BRANDS for a in aliases}

# Linha de produto que o ERP não marca, mas é inconfundível — e a própria loja
# escreve a marca em outras linhas do mesmo pneu (ex.: "POWC 2 CONT").
MODEL_IMPLIES = [
    (r"\bPOWER CONTACT\b", "CONTINENTAL"),
    (r"\bBRAVURIS\b", "CONTINENTAL"),
    (r"\bECOPLUS\b", "XBRI"),
    (r"\bFORZA\b", "XBRI"),
    (r"\bFRD\d+\b", "FARROAD"),
]

# Correções de digitação evidentes (o texto original fica em `description`).
TYPOS = {"ZUPHIRA": "ZYPHIRA", "QUADRICULO": "QUADRICICLO"}

# Tokens técnicos que ficam só na descrição: índice de carga/velocidade, lonas.
TECH = re.compile(r"^(\d{2,3}[A-Za-z]|\d{2,3}/\d{2,3}[A-Za-z]|\d{1,2}PR|XL|FR|RWL|LT)$", re.I)

def fnum(v):
    return int(v) if float(v).is_integer() else round(v, 2)

def classify(desc):
    d = desc.upper()
    if d.startswith("CAMARA DE AR"): return "CAMARA"
    if d.startswith("PROTETOR"): return "PROTETOR"
    if d.startswith("RODA"): return "RODA"
    return "PNEU"

SIZE_RX = [
    (re.compile(r"\b(\d{3}/\d{2})\s+(Z?R)\s?(\d{2}(?:\.\d)?C?)\b", re.I), lambda m: f"{m[1]} {m[2].upper()}{m[3].upper()}"),
    (re.compile(r"\b(\d{3})\s+R(\d{2}C)\b", re.I), lambda m: f"{m[1]} R{m[2].upper()}"),
    (re.compile(r"\b(\d{2})X(\d+(?:\.\d+)?)\s*-\s*(\d{2})\b", re.I), lambda m: f"{m[1]}X{m[2]}-{m[3]}"),
    (re.compile(r"^(\d{4})\s+(\d{2})\b"), lambda m: f"{m[1]} {m[2]}"),
    (re.compile(r"\b(\d{3,4}/\d{2})\b"), lambda m: m[1]),
]

def extract_size(text):
    for rx, fmt in SIZE_RX:
        m = rx.search(text)
        if m:
            return fmt(m), (text[:m.start()] + " " + text[m.end():]).strip()
    return "", text

def split_tire(desc, flags):
    size, rest = extract_size(desc)
    words = [TYPOS.get(w.upper(), w) for w in rest.split()]
    # Truncamento no fim da descrição: "(9" solto, "C30 Z" / "C30 ZMA" (Zmax).
    if words and re.fullmatch(r"\(\d*", words[-1]):
        words.pop(); flags.append("descrição cortada pelo ERP")
    if len(words) >= 2 and words[-2].upper() == "C30" and words[-1].upper() in ("Z", "ZMA"):
        words[-1] = "ZMAX"; flags.append("descrição cortada pelo ERP")
    if words and words[-1].upper() == "COM" and "A/T" in [w.upper() for w in words]:
        words[-1] = "COMFORSER"; flags.append("descrição cortada pelo ERP")
    if any(w.upper() in ("MAXTRE", "XBR", "XB", "AUTOGREE") for w in words):
        flags.append("descrição cortada pelo ERP")

    upper = [w.upper() for w in words]
    brand = ""
    # Marcas de duas palavras / separadas.
    if "LING" in upper and "LONG" in upper:
        brand = "LINGLONG"; words = [w for w in words if w.upper() not in ("LING", "LONG")]
    elif "BLACK" in upper and "ARROW" in upper:
        brand = "BLACKARROW"; words = [w for w in words if w.upper() not in ("BLACK", "ARROW")]
    else:
        for i, w in enumerate(words):
            canon = ALIAS.get(w.upper())
            if canon:
                brand = canon
                words = words[:i] + words[i + 1:]
                break
    if not brand:
        joined = " ".join(words).upper()
        for rx, canon in MODEL_IMPLIES:
            if re.search(rx, joined):
                brand = canon; flags.append(f"marca deduzida pela linha do pneu ({canon})")
                break
    # SAJPN marca pneu vindo da loja SAJ — não é modelo.
    if any(w.upper() == "SAJPN" for w in words):
        words = [w for w in words if w.upper() != "SAJPN"]; flags.append("veio da SAJ (etiqueta SAJPN)")

    model_words = [w for w in words if not TECH.match(w)]
    model = " ".join(model_words).upper().strip()
    if not brand:
        if model_words:
            brand = model_words[0].upper()
            model = " ".join(model_words[1:]).upper()
        flags.append("marca não identificada — conferir")
    return size, brand, model

def split_other(desc, category, flags):
    d = desc.upper().strip()
    if category == "CAMARA":
        rest = d[len("CAMARA DE AR"):].strip()
        m = re.search(r"(\d{1,2}(?:\.\d)?-\d{2})\s*$", rest) or \
            re.search(r"(\d{3}/\d{2}\s*R\s?\d{2}(?:\.\d)?)", rest) or \
            re.search(r"(\d{1,4}(?:\.\d)?(?:/\d{2,3})?(?:\s*-\s*\d{2})?(?:X\d{2})?)", rest)
        size = re.sub(r"\s+", "", m.group(1)).replace("R", " R") if m else ""
        model = (rest[:m.start()] + " " + rest[m.end():]).strip() if m else rest
        return size, "CAMARA DE AR", re.sub(r"\s+", " ", model).replace("- ", "").strip(" -")
    if category == "PROTETOR":
        m = re.search(r"(?:ARO\s*|R)(\d{1,2})", d)
        return (f"ARO {m.group(1)}" if m else ""), "PROTETOR", ""
    # RODA
    m = re.search(r"(\d{3}/\d{2}\.\d)", d) or re.search(r"RODA\s+(\d{3})\b", d)
    size = m.group(1) if m else ""
    model = d.replace("RODA", "", 1)
    if m: model = model.replace(m.group(1), "", 1)
    return size, "RODA", re.sub(r"\s+", " ", model).strip()

items, report = [], []
for r in rows:
    flags = []
    desc = r["descricao"].strip()
    cat = classify(desc)
    if cat == "PNEU":
        size, brand, model = split_tire(desc, flags)
    else:
        size, brand, model = split_other(desc, cat, flags)
    if r["referencia"]:
        flags.append(f"campo Referência do ERP com \"{r['referencia']}\" (parece preço digitado no lugar errado)")
    if r["varejo"] == 0 and r["atacado"] == 0:
        flags.append("SEM PREÇO no ERP — vai aparecer sem valor no catálogo")

    if PRICE_MODE == "atacado_vista":
        cash, inst = r["atacado"], r["varejo"]
    else:
        cash, inst = r["varejo"], r["varejo"]

    items.append({
        "sku": f"{PREFIX}-{r['codigo']}",
        "brand": brand,
        "model": model,
        "size": size or "—",
        "quantity": int(r["saldo"]),
        "priceCash": fnum(cash),
        "priceInstallment": fnum(inst),
        "price": fnum(cash),
        "costPrice": 0,
        "notes": f"Estoque {STORE} — relatório Time Sistemas de {report_date}. Código no ERP: {r['codigo']}",
        "description": desc
    })
    report.append({"codigo": r["codigo"], "cat": cat, "size": size, "brand": brand, "model": model, "flags": flags, "desc": desc, "qty": int(r["saldo"]), "cash": cash, "inst": inst})

io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(items, ensure_ascii=False, indent=2) + "\n")

# ── Análise ─────────────────────────────────────────────────────────
cats = Counter(x["cat"] for x in report)
units = Counter()
for x in report: units[x["cat"]] += x["qty"]
print("== CATEGORIAS ==")
for c in ("PNEU", "CAMARA", "PROTETOR", "RODA"):
    print(f"  {c:<9} {cats[c]:>3} produtos  {units[c]:>3} un")
print(f"  total     {len(report):>3} produtos  {sum(units.values()):>3} un")

print("\n== MARCAS (pneus) ==")
bc = Counter(); bu = Counter()
for x in report:
    if x["cat"] == "PNEU": bc[x["brand"]] += 1; bu[x["brand"]] += x["qty"]
for b, n in bc.most_common(): print(f"  {b:<14} {n:>3} produtos  {bu[b]:>3} un")

print("\n== ALERTAS ==")
for x in report:
    if x["flags"]:
        print(f"  {x['codigo']:>4} {x['desc'][:44]:<44} → " + "; ".join(sorted(set(x["flags"]))))

print("\n== CONFERÊNCIA DA SEPARAÇÃO (amostra) ==")
for x in report:
    if x["codigo"] in ("433", "596", "622", "151", "3", "626", "360", "438", "129", "661", "576", "163", "64", "637", "437", "374"):
        print(f"  {x['codigo']:>4} medida={x['size']!r:<16} marca={x['brand']!r:<14} modelo={x['model']!r}")

# ── Diferença contra o estoque anterior (JSON apagado em 21/09) ────
def old_code(sku):
    m = re.match(rf"{PREFIX}-(\d+)", sku or ""); return m.group(1) if m else None
oldmap = {}
for o in old:
    c = old_code(o.get("sku"))
    if c: oldmap[c] = o
newmap = {x["codigo"]: x for x in report}
added = [c for c in newmap if c not in oldmap]
removed = [c for c in oldmap if c not in newmap]
changed = [(c, oldmap[c]["quantity"], newmap[c]["qty"]) for c in newmap if c in oldmap and int(oldmap[c]["quantity"]) != newmap[c]["qty"]]
print(f"\n== DIFERENÇA CONTRA O ARQUIVO ANTERIOR ({len(oldmap)} produtos, {sum(int(o['quantity']) for o in oldmap.values())} un) ==")
print(f"  novos no PDF: {len(added)} produtos, {sum(newmap[c]['qty'] for c in added)} un")
for c in added: print(f"    + {c:>4} {newmap[c]['qty']:>2} un  {newmap[c]['desc']}")
print(f"  saíram (estavam antes, não estão no PDF): {len(removed)} produtos, {sum(int(oldmap[c]['quantity']) for c in removed)} un")
for c in removed: print(f"    - {c:>4} {int(oldmap[c]['quantity']):>2} un  {oldmap[c].get('description','')}")
print(f"  quantidade mudou: {len(changed)}")
for c, a, b in changed: print(f"    ~ {c:>4} {a:>2} → {b:>2} un  {newmap[c]['desc']}")
