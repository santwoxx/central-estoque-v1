import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { XMLParser } from "fast-xml-parser";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

// Helper to extract text from a PDF buffer without AI
async function extractPdfText(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ verbosity: -1 });
  const result: string = await parser.getText(buf);
  return result || "";
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());

// Increase payload limit for base64 uploads
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ─────────────────────────────────────────────────────────────────
// Helper: Parse XML NF-e directly without AI
// ─────────────────────────────────────────────────────────────────
function parseNFeXml(xmlText: string): any[] {
  const items: any[] = [];

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_"
    });
    const jsonObj = parser.parse(xmlText);

    // Common standard paths for NF-e structures
    const infNFe = jsonObj.nfeProc?.NFe?.infNFe || jsonObj.NFe?.infNFe || jsonObj.infNFe;
    if (!infNFe) return [];

    let detList = infNFe.det;
    if (!detList) return [];

    // If there is only one product, fast-xml-parser returns it as an object instead of array
    if (!Array.isArray(detList)) {
      detList = [detList];
    }

    detList.forEach((det: any, idx: number) => {
      const prod = det?.prod;
      if (!prod) return;

      const xProd  = prod.xProd || "";
      const qCom   = parseFloat(prod.qCom || "0");
      const vUnCom = parseFloat(prod.vUnCom || "0");
      const uCom   = prod.uCom || "";
      const xPed   = prod.xPed || "";

      // Try to infer brand/model/size from product name
      // Common tire patterns: 205/55R16, 185/70R14
      const sizeMatch = xProd.match(/\b(\d{3}\/\d{2}R\d{2})\b/i);
      const size = sizeMatch ? sizeMatch[1] : uCom || "—";

      // Brand heuristic: first word in product name
      const words = xProd.trim().split(/\s+/);
      const brand = words[0] || "Desconhecida";
      const model = words.slice(1).join(" ") || xProd;

      if (xProd) {
        items.push({
          virtualId: `PROD-${String(idx + 1).padStart(3, "0")}`,
          brand,
          model,
          size,
          quantity: Math.round(qCom) || 1,
          price: vUnCom || 0,
          notes: xPed || "",
          description: `Importado de XML NF-e: ${xProd}`
        });
      }
    });
  } catch (error) {
    console.error("Failed to parse XML using fast-xml-parser:", error);
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse inventory report text (SEM GTIN format)
// Handles structured report exports from stock management systems.
// Format: {ID} SEM GTIN {ID} PNEU {SIZE} {BRAND} {MODEL} PNEUS (...) UN {QTY} {PRICE}
// ─────────────────────────────────────────────────────────────────
function parseInventoryReportText(text: string): any[] {
  console.log(`[SEM GTIN parser] Input length: ${text.length}, first 80 chars: ${JSON.stringify(text.slice(0, 80))}`);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  // Step 1: Merge multi-line entries.
  // Lines belonging to the same entry often have brand/model split across lines.
  // A new entry starts with "{number} SEM GTIN".
  const merged: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    if (/^\d+\s+SEM\s+GTIN/i.test(t)) {
      // New product entry — start a new merged line
      merged.push(t);
    } else if (merged.length > 0) {
      // Skip summary/footer lines
      if (t.startsWith("CUSTO") || t.startsWith("QTD") || t.startsWith("VALOR")) continue;
      // Append continuation lines (brand/model text split across lines, or orphaned number fragments)
      merged[merged.length - 1] += " " + t;
    }
  }

  console.log(`[SEM GTIN parser] Merged ${merged.length} entries. First entry sample: ${JSON.stringify(merged[0]?.slice(0, 120))}`);

  const items: any[] = [];
  let idx = 0;

  for (const line of merged) {
    // Match the full structure up to "PNEUS (...)" and then "UN" + numbers
    const mainMatch = line.match(
      /^\d+\s+SEM\s+GTIN\s+\d+\s+PNEU\s+(.+?)\s+PNEUS\s*\([^)]*\)\s+UN\s+([\d\s.,]+)/i
    );
    if (!mainMatch) continue;

    const productPart = mainMatch[1].trim();
    const afterUN = mainMatch[2].trim();

    // ── Parse qty and price from afterUN ──────────────────────────
    // Format: "{qty} {price}" or broken across lines: "{price_start} {fragment} {qty}"
    const nums = (afterUN.match(/[\d.,]+/g) || []);
    let quantity = 0;
    let price = 0;

    if (nums.length === 2) {
      const raw0 = nums[0];
      const raw1 = nums[1];
      const v0 = parseFloat(raw0.replace(",", "."));
      const v1 = parseFloat(raw1.replace(",", "."));
      // qty = small clean integer without comma; price = the other
      if (!raw0.includes(",") && !raw0.includes(".") && v0 < 500) {
        quantity = Math.round(v0);
        price = v1;
      } else {
        price = v0;
        quantity = Math.round(v1);
      }
    } else if (nums.length >= 3) {
      // Multi-fragment price (e.g. "1010,0 0 4" from split line "1010,00\n4")
      quantity = Math.round(parseFloat(nums[nums.length - 1].replace(",", "."))) || 1;
      // Join the remaining fragments to reconstruct the price (e.g. "1010,0"+"0" → "1010.00")
      const priceJoined = nums.slice(0, -1).join("").replace(",", ".");
      price = parseFloat(priceJoined) || 0;
    } else if (nums.length === 1) {
      quantity = Math.round(parseFloat(nums[0].replace(",", "."))) || 1;
    }

    // ── Extract tire size from productPart ──────────────────────
    // Tire size patterns (order matters — most specific first):
    const sizeRx = [
      /(\d{3}\/\d{2}R\d{2}(?:XL|C)?)/i,   // 205/55R16, 175/65R14XL
      /(\d{3}\s+R\d{2}\s+C)/i,              // 195 R14 C
      /(\d{3}\/\d{2}R\d{2})/i,             // fallback
      /(\d{3}R\d{2})/i,                     // 185R15
    ];

    let size = "";
    let sizeIdx = -1;
    let sizeLen = 0;
    for (const rx of sizeRx) {
      const m = productPart.match(rx);
      if (m && m.index !== undefined) {
        size = m[1].trim();
        sizeIdx = m.index;
        sizeLen = m[0].length;
        break;
      }
    }

    // ── Determine brand and model ─────────────────────────────────
    // Multi-word brands must be checked BEFORE splitting on first space
    const MULTI_WORD_BRANDS = [
      "BLACK ARROW", "GENERAL TIRES", "GENERAL TIRE", "SMART CHASER",
      "LINGLONG OWL", "BARUM BRAVURIS", "MAXTREK MAXIMUS", "MAXTREK SIERRA",
      "CONTINENTAL POWER", "CONTINENTAL ULTRA", "ALTIMAX ONE", "BRAVURIS AT",
      "CROSSWIND AT", "CONFORSER CF"
    ];

    let brand = "Desconhecida";
    let model = "";

    if (size && sizeIdx >= 0) {
      const beforeSize = productPart.substring(0, sizeIdx).trim();
      const afterSize  = productPart.substring(sizeIdx + sizeLen).trim()
        // Remove residual load index like "118/116R" right after size
        .replace(/^\d+\/\d+R\d*\s*/, "").trim();

      if (beforeSize) {
        // Brand appears BEFORE the size (e.g. "CONTINENTAL 225/75R16 VANCAP")
        brand = beforeSize;
        model = afterSize || beforeSize;
      } else {
        // Brand appears AFTER the size (most common)
        // Check for multi-word brand first
        const upperAfter = afterSize.toUpperCase();
        const multiMatch = MULTI_WORD_BRANDS.find(b => upperAfter.startsWith(b));
        if (multiMatch) {
          brand = multiMatch;
          model = afterSize.substring(multiMatch.length).trim() || brand;
        } else {
          const aParts = afterSize.split(/\s+/);
          brand = aParts[0] || "Desconhecida";
          model = aParts.slice(1).join(" ") || "";
        }
        // If model is empty, use brand as model (single-brand products like DUNLOP, FIRESTONE)
        if (!model) model = brand;
      }
    } else {
      // No size found – take first word as brand, rest as model
      const parts = productPart.split(/\s+/);
      brand = parts[0];
      model = parts.slice(1).join(" ") || brand;
    }

    idx++;
    items.push({
      virtualId: `PROD-${String(idx).padStart(3, "0")}`,
      brand: brand.toUpperCase(),
      model: model.toUpperCase() || brand.toUpperCase(),
      size: size || "—",
      quantity,
      price,
      notes: "",
      description: `Importado de relatório: ${brand} ${model} ${size}`
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse tab-separated inventory (e.g. Jorge/Central Autocenter format)
// Format per line: "{SIZE} {INDEX} {MODEL} {BRAND}\t{QTY}\tR$ {COST}\tR$ {PRICE}"
// ─────────────────────────────────────────────────────────────────
function parseTabInventory(text: string): any[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const items: any[] = [];
  let idx = 0;

  // Known brands for this format (first word or known multi-word suffix)
  const KNOWN_BRANDS = [
    "CONTINENTAL", "BARUM", "GENERAL", "GENERAL TIRES", "GENERAL TIRE",
    "PIRELLI", "MICHELIN", "GOODYEAR", "BRIDGESTONE", "DUNLOP",
    "FIRESTONE", "HANKOOK", "YOKOHAMA", "MAXXIS", "FALKEN"
  ];

  // Tire size pattern for this format: 205/55 R16, 195/70 R15C, 225/70 R15C
  const SIZE_RX = /(\d{3}\/\d{2}(?:\/\d{2})?)\s+(R\d{2}C?)/i;

  // Detect if text uses tabs or spaces as delimiters
  const hasTabs = text.includes("\t");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let description: string;
    let qtyRaw: string;
    let priceRaw: string;

    if (hasTabs) {
      // Split on TAB — format is: description\tqty\tcost\tprice
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      description = cols[0].trim();
      qtyRaw      = (cols[1] || "").trim();
      priceRaw    = (cols[3] || cols[2] || "").trim();
    } else {
      // No tabs found — try regex-based extraction for space-separated data
      // Pattern: {description} {qty} R$ {cost} R$ {price}
      const match = line.match(/^(.+?)\s+(\d+)\s+R\$\s*([\d.,]+)\s+R\$\s*([\d.,]+)$/i);
      if (!match) continue;
      description = match[1].trim();
      qtyRaw      = match[2];
      priceRaw    = match[4]; // sale price (second R$ value)
    }

    // Extract tire size
    const sizeMatch = description.match(SIZE_RX);
    if (!sizeMatch) continue; // Skip lines that don't look like tire entries

    const sizeBase = sizeMatch[1];          // e.g. "205/55"
    const sizeR    = sizeMatch[2];          // e.g. "R16" or "R15C"
    const sizeNorm = `${sizeBase}${sizeR}`; // e.g. "205/55R16"

    const sizeEnd = sizeMatch.index! + sizeMatch[0].length;
    let rest = description.substring(sizeEnd).trim();

    // Remove load index / speed rating prefix (e.g. "82T", "91V FR", "104/102R")
    // Trim first to avoid leading space issue with ^ anchor
    rest = rest.trim();
    rest = rest.replace(/^\d+(?:\/\d+)?[A-Z]?\s*(?:XL\s*)?(?:FR\s*)?/i, "").trim();
    rest = rest.replace(/^XL\s*/i, "").trim();
    rest = rest.replace(/^FR\s*/i, "").trim();

    // Remove trailing dealer tags like "Contibid", "(Contibid)", "(BID)"
    rest = rest.replace(/\s*\(?Contibid\)?\s*$/i, "").trim();
    rest = rest.replace(/\s*\(?BID\)?\s*$/i, "").trim();

    // Find brand: check if any known brand appears at the END of the remaining text
    let brand = "Desconhecida";
    let model = rest;

    for (const kb of KNOWN_BRANDS) {
      const upperRest = rest.toUpperCase();
      // Check end of string
      if (upperRest.endsWith(kb)) {
        brand = kb;
        model = rest.substring(0, upperRest.length - kb.length).trim();
        break;
      }
      // Check if it appears anywhere (in case it's in the middle)
      const kbIdx = upperRest.indexOf(kb);
      if (kbIdx >= 0) {
        brand = kb;
        // model is everything that is NOT the brand
        model = (rest.substring(0, kbIdx) + " " + rest.substring(kbIdx + kb.length)).trim();
        break;
      }
    }

    // Clean up model: remove load/speed indexes still embedded
    model = model.replace(/\s*\d{2,3}[A-Z]\.?\s*/g, " ").trim();
    model = model.replace(/\s{2,}/g, " ").trim();

    // If brand still unknown, use the first word of rest
    if (brand === "Desconhecida" && rest) {
      const parts = rest.split(/\s+/);
      brand = parts[parts.length - 1] || parts[0]; // last word often is brand
      model = rest;
    }

    // Quantity
    const qty = parseInt(qtyRaw.replace(/\D/g, "")) || 0;

    // Price — remove "R$", dots (thousand sep), normalise comma to dot
    const priceClean = priceRaw
      .replace(/R\$\s*/i, "")
      .replace(/\./g, "")     // remove thousand separator dots
      .replace(",", ".")      // decimal comma to dot
      .trim();
    const price = parseFloat(priceClean) || 0;

    if (!model && brand === "Desconhecida") continue;

    idx++;
    items.push({
      virtualId: `PROD-${String(idx).padStart(3, "0")}`,
      brand: brand.toUpperCase(),
      model: (model || brand).toUpperCase(),
      size: sizeNorm,
      quantity: qty,
      price,
      notes: "",
      description: `Importado: ${brand} ${model} ${sizeNorm}`
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse CSV text
// ─────────────────────────────────────────────────────────────────
function parseCsvText(csvText: string): any[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Detect delimiter: comma or semicolon
  const delimiter = lines[0].includes(";") ? ";" : ",";

  const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase()
    .replace(/["""]/g, "")
    .replace(/\s+/g, "_")
  );

  const items: any[] = [];

  const colMap: Record<string, string[]> = {
    brand:    ["marca", "brand", "fabricante"],
    model:    ["modelo", "model", "produto", "descricao", "descrição", "description", "nome"],
    size:     ["medida", "size", "tamanho", "dimensão", "dimension"],
    quantity: ["quantidade", "qty", "quantity", "qtd", "estoque", "quant"],
    price:    ["preco", "preço", "price", "valor", "vl_unit", "preco_unit"],
    notes:    ["obs", "observacao", "observação", "notes", "nota"],
  };

  function findCol(field: string): number {
    const aliases = colMap[field] || [];
    for (const alias of aliases) {
      const idx = headers.findIndex(h => h.includes(alias));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  lines.slice(1).forEach((line, idx) => {
    const cols = line.split(delimiter).map(c => c.trim().replace(/^[""]|[""]$/g, "").replace(/["""]/g, ""));
    if (cols.length < 2) return;

    const get = (field: string) => {
      const i = findCol(field);
      return i >= 0 ? cols[i] || "" : "";
    };

    const brand = get("brand") || "Desconhecida";
    const model = get("model") || cols[1] || "Produto";
    const size  = get("size") || "—";
    const qty   = parseInt(get("quantity")) || 0;
    const price = parseFloat((get("price") || "0").replace(",", ".")) || 0;
    const notes = get("notes") || "";

    if (brand || model) {
      items.push({
        virtualId: `PROD-${String(idx + 1).padStart(3, "0")}`,
        brand,
        model,
        size,
        quantity: qty,
        price,
        notes,
        description: `Importado via CSV: ${brand} ${model}`
      });
    }
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse free-form / unstructured text
// Handles natural language patterns like:
//   "10 Pirelli Cinturato P7 205/55R16 - R$ 450 cada"
//   "5x 205/55R16 Pirelli Cinturato P7 R$489"
//   "- 3 Michelin 195/60R15 Primacy 4 390,00"
//   "205/55R16 10 Pirelli Cinturato P7 450,00"
// ─────────────────────────────────────────────────────────────────
function parseFreeFormText(text: string): any[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const items: any[] = [];
  let idx = 0;

  const KNOWN_BRANDS = [
    "PIRELLI", "MICHELIN", "GOODYEAR", "BRIDGESTONE", "DUNLOP",
    "FIRESTONE", "HANKOOK", "YOKOHAMA", "MAXXIS", "FALKEN",
    "CONTINENTAL", "BARUM", "GENERAL TIRE", "GENERAL TIRES", "GENERAL",
    "KUMHO", "BFGOODRICH", "COOPER", "TOYO", "NEXEN",
    "GT RADIAL", "WANLI", "SAILUN", "LINGLONG",
    "DOUBLECOIN", "AEOLUS", "TRIANGLE", "CHAOYANG", "WESTLAKE",
    "BLACK ARROW", "SMART CHASER", "MAXTREK", "CONFORSER",
    "ALTIMAX", "BRAVURIS", "VANCAP", "CROSSWIND",
    "PACE", "AUSTONE", "DELINTE", "ARIVO", "ROADLUX", "SOLMAX",
    "GITI", "PRIMWELL", "SUMITE", "JINGU", "ANNAITE", "COMPASS",
    "PREMIUM", "TORQUE", "MAGNA", "STORMAST", "MABOR", "SUPERIA",
    "DAYTON", "KELLY", "REMO", "MIDWAY", "POLARIS", "ROADKING",
    "CENTARA", "VENTUS", "ECSTING", "POTENZA", "TURANZA", "DUELER",
    "ALENZA", "SCORPION", "CINTURATO", "EUROVAN", "AGILIS",
    "BOSCH", "VARGA", "ATE", "TRW", "VALEO", "HELLA",
    "MONROE", "KYB", "NAKATA", "COFAP", "SACHS", "MAPCO"
  ];

  // Tire size patterns (most specific first):
  //   205/55R16, 205/55R16XL, 205/55R16C
  //   175R14, 185R15C (older sizes without aspect ratio)
  //   31x10.5R15 (off-road / light truck)
  const SIZE_RX = /\b(\d{3}\/\d{2}R\d{2}(?:XL|C)?|\d{3}R\d{2}(?:XL|C)?)\b/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length < 6) continue;
    if (/^(total|subtotal|obs|nota|valor|custo|qtd|quantidade|preco|produto)/i.test(line)) continue;
    if (/^\d+\s+SEM\s+GTIN/i.test(line)) continue;

    const sizeMatch = line.match(SIZE_RX);
    if (!sizeMatch) continue;

    const size = sizeMatch[1].toUpperCase();
    const sizeIdx = sizeMatch.index!;
    const sizeEnd = sizeIdx + sizeMatch[0].length;

    // ── Extract quantity ──────────────────────────────────────────
    // Prefer start-of-line to avoid model names like "P7"
    const beforeSize = line.substring(0, sizeIdx).trim();
    let quantity = 1;
    const qtyFromStart = line.match(/^[-–•*\s]*(?:mais\s+|e\s+)?(\d{1,5})(?:\s*x\s*|\s+)/i);
    const qtyFromBefore = beforeSize.match(/(?:^|[\s,;:])(\d{1,5})\s*x?\s*$/i);
    if (qtyFromStart) {
      const parsed = parseInt(qtyFromStart[1]);
      if (parsed > 0 && parsed < 100000) quantity = parsed;
    } else if (qtyFromBefore) {
      const parsed = parseInt(qtyFromBefore[1]);
      if (parsed > 0 && parsed < 100000) quantity = parsed;
    }

    // ── Extract price (R$ prefix or trailing number) ──────────────
    let price = 0;
    const rsMatch = line.match(/(?:R\$|RS|r\$|rs)\s*(\d[\d.]*(?:,\d{1,2})?)/i);
    if (rsMatch) {
      price = parseFloat(rsMatch[1].replace(/\./g, "").replace(",", ".")) || 0;
    } else {
      const afterSize = line.substring(sizeEnd).trim();
      const priceMatch = afterSize.match(/(\d{2,}(?:[.,]\d{1,2})?)\s*$/);
      if (priceMatch) {
        const parsed = parseFloat(priceMatch[1].replace(/\.(?=\d{3})/g, "").replace(",", "."));
        if (parsed > 0 && parsed < 50000) price = parsed;
      }
    }

    // ── Find known brand ──────────────────────────────────────────
    const upperLine = line.toUpperCase();
    let brand = "Desconhecida";
    let bi = -1;
    for (const kb of KNOWN_BRANDS) {
      bi = upperLine.indexOf(kb);
      if (bi >= 0) { brand = kb; break; }
    }

    // ── Extract model ─────────────────────────────────────────────
    let model = "";
    if (bi >= 0) {
      const be = bi + brand.length;
      if (bi < sizeIdx) {
        model = line.substring(be, sizeIdx).trim();
      } else {
        model = line.substring(be).trim();
      }
    } else {
      const noBrandQty = beforeSize.match(/^(\d{1,5})\s+(.+)/);
      if (noBrandQty && quantity === 1) {
        quantity = parseInt(noBrandQty[1]);
        model = noBrandQty[2];
      } else {
        model = beforeSize.replace(/^\d+\s*x?\s*/i, "").trim();
      }
      if (!model) {
        model = line.substring(sizeEnd).replace(/(?:R\$|RS|r\$|rs)[\d.,\s]+.*$/i, "").trim();
      }
    }

    // ── Extract load index / speed rating from text after size ────
    let notes = "";
    const afterSizeAll = line.substring(sizeEnd).trim();
    const liMatch = afterSizeAll.match(/\b(\d{2,3}(?:\/\d{2,3})?[A-Z](?:\s*XL|\s*REINF|\s*RF|\s*SL)?)\b/i);
    if (liMatch) {
      notes = liMatch[1].toUpperCase();
    }

    // ── Extract quantity: 3rd fallback (between size and brand) ───
    if (quantity === 1 && bi >= 0 && bi > sizeEnd) {
      const betweenSizeBrand = line.substring(sizeEnd, bi).trim();
      const qtyBetween = betweenSizeBrand.match(/^(\d{1,5})\s*$/);
      if (qtyBetween) {
        const parsed = parseInt(qtyBetween[1]);
        if (parsed > 0 && parsed < 100000) quantity = parsed;
      }
    }

    // ── Clean model ───────────────────────────────────────────────
    // Remove R$/por price patterns
    model = model.replace(/(?:[-–—]\s*)?(?:R\s*\$?\s*|por\s+)[\d.,]+\s*(?:cada|und|unidade|uni)?\s*$/i, "").trim();
    // Remove trailing price-like numbers (e.g. "450,00", "390")
    model = model.replace(/\s+\d{2,}(?:[.,]\d{1,2})?\s*$/, "").trim();
    // Clean prefixes
    model = model.replace(/^(?:[-–•*\s]+|,\s*)/, "").trim();
    model = model.replace(/\(?(?:cada|und|unidade|uni)\)?\s*$/i, "").trim();
    model = model.replace(/\s{2,}/g, " ").trim();
    // Extract trailing quantity from model (e.g. "Cinturato P7 10" → qty=10, model="Cinturato P7")
    const trailingQty = model.match(/^(.+?)\s+(\d{2,5})$/);
    if (trailingQty && quantity === 1) {
      const parsed = parseInt(trailingQty[2]);
      if (parsed > 1 && parsed < 10000) {
        quantity = parsed;
        model = trailingQty[1].trim();
      }
    }

    if (!model && brand === "Desconhecida") continue;
    if (!model) model = brand;

    // ── Push item ─────────────────────────────────────────────────
    idx++;
    items.push({
      virtualId: `PROD-${String(idx).padStart(3, "0")}`,
      brand: brand.toUpperCase(),
      model: model.toUpperCase() || brand.toUpperCase(),
      size,
      quantity,
      price,
      notes,
      description: `${brand} ${model} ${size}${notes ? ` ${notes}` : ""}`
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// API: Parse file (PDF, image, XML, CSV) with local parsers only
// ─────────────────────────────────────────────────────────────────
app.post("/api/parse-pdf", async (req, res) => {
  try {
    const { fileBase64, mimeType, fileText } = req.body;
    console.log(`[BODY] mimeType=${mimeType} | fileText length=${fileText?.length} | fileBase64 length=${fileBase64?.length} | fileText start=${JSON.stringify(fileText?.slice(0,80))}`);

    // ── XML: direct NF-e parser ──────────────────────────────────
    if (mimeType === "text/xml" || mimeType === "application/xml") {
      if (!fileText) {
        res.status(400).json({ error: "Conteúdo XML não fornecido." });
        return;
      }
      const items = parseNFeXml(fileText);
      res.json({ success: true, items });
      return;
    }

    // ── CSV / Plain Text: multi-parser chain (no AI) ──────────────
    if (mimeType === "text/csv" || mimeType === "text/plain") {
      if (!fileText) {
        res.status(400).json({ error: "Conteúdo do texto não fornecido." });
        return;
      }

      // 1st attempt: detect SEM GTIN inventory report format
      if (/SEM\s+GTIN/i.test(fileText)) {
        console.log("Detected SEM GTIN inventory report format — using dedicated parser");
        const reportItems = parseInventoryReportText(fileText);
        if (reportItems.length > 0) {
          res.json({ success: true, items: reportItems });
          return;
        }
      }

      // 2nd attempt: tab-separated inventory (e.g. Central Autocenter format)
      const tabItems = parseTabInventory(fileText);
      if (tabItems.length > 0) {
        console.log(`Tab-separated parser extracted ${tabItems.length} items`);
        res.json({ success: true, items: tabItems });
        return;
      }

      // 3rd attempt: structured CSV/spreadsheet format
      const csvItems = parseCsvText(fileText);
      const usefulCsv = csvItems.filter(i => i.brand !== "Desconhecida" && i.quantity > 0);
      if (usefulCsv.length > 0) {
        res.json({ success: true, items: csvItems });
        return;
      }

      // 4th attempt: free-form / unstructured text (natural language patterns)
      const freeFormItems = parseFreeFormText(fileText);
      if (freeFormItems.length > 0) {
        console.log(`Free-form parser extracted ${freeFormItems.length} items`);
        res.json({ success: true, items: freeFormItems });
        return;
      }

      // Nothing worked
      res.status(422).json({
        error: "Não foi possível interpretar o texto. Verifique se é um relatório SEM GTIN, planilha com TAB, CSV ou texto com medidas de pneu."
      });
      return;
    }

    // ── PDF: try native text extraction first (no AI) ────────────
    if (!fileBase64) {
      res.status(400).json({ error: "O conteúdo do arquivo base64 é obrigatório." });
      return;
    }

    // Strip data URI prefix if present (e.g., data:application/pdf;base64,...)
    const cleanBase64 = fileBase64.replace(/^data:.*,/, "");
    const pdfBuffer = Buffer.from(cleanBase64, "base64");

    // Attempt #1: Extract embedded text from the PDF (works for system-generated PDFs)
    try {
      const extractedText = await extractPdfText(pdfBuffer);

      if (extractedText.trim().length > 30) {
        console.log(`PDF text extracted (${extractedText.length} chars) — trying local parsers`);

        // Try SEM GTIN inventory report format first
        if (/SEM\s+GTIN/i.test(extractedText)) {
          const reportItems = parseInventoryReportText(extractedText);
          if (reportItems.length > 0) {
            console.log(`SEM GTIN parser extracted ${reportItems.length} items from PDF`);
            res.json({ success: true, items: reportItems });
            return;
          }
        }

        // Try CSV format
        const csvItems = parseCsvText(extractedText);
        const usefulCsv = csvItems.filter(i => i.brand !== "Desconhecida" && i.quantity > 0);
        if (usefulCsv.length > 0) {
          console.log(`CSV parser extracted ${usefulCsv.length} items from PDF`);
          res.json({ success: true, items: csvItems });
          return;
        }

        // Try free-form text parser
        const freeFormItems = parseFreeFormText(extractedText);
        if (freeFormItems.length > 0) {
          console.log(`Free-form parser extracted ${freeFormItems.length} items from PDF`);
          res.json({ success: true, items: freeFormItems });
          return;
        }

        console.log("PDF has text but no known format matched");
      } else {
        console.log("PDF has no extractable text (likely scanned/image)");
      }
    } catch (pdfErr) {
      console.warn("pdf-parse failed:", pdfErr);
    }

    res.status(422).json({
      error: "Não foi possível interpretar o PDF. Use a aba 'Colar Texto' como alternativa."
    });
  } catch (error: any) {
    console.error("Error processing file:", error);
    res.status(500).json({ error: error.message || "Erro interno do servidor" });
  }
});

// ─────────────────────────────────────────────────────────────────
// API: Save daily backup on server disk
// ─────────────────────────────────────────────────────────────────
app.post("/api/backup", async (req, res) => {
  try {
    const { items, userEmail, companyName } = req.body;
    if (!Array.isArray(items)) {
      res.status(400).json({ error: "Lista de itens inválida." });
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const backupDir = path.join(process.cwd(), "backups");
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const cleanedCompanyName = String(companyName || "geral")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .toLowerCase();

    const fileName = `backup-${cleanedCompanyName}-${todayStr}.json`;
    const filePath = path.join(backupDir, fileName);

    const backupData = {
      backupDate: new Date().toISOString(),
      companyName: companyName || "Geral",
      createdByUser: userEmail || "Sistema",
      totalItems: items.length,
      items
    };

    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), "utf8");
    console.log(`[BACKUP] Saved local file: ${filePath}`);

    res.json({ success: true, fileName, message: "Backup salvo com sucesso no servidor." });
  } catch (error: any) {
    console.error("Erro ao salvar backup:", error);
    res.status(500).json({ error: error.message || "Erro ao salvar backup no servidor." });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
