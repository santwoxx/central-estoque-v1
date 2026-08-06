// Client-side parser functions for XML, CSV, tab-separated text, HTML tables, JSON, and free-form text.

// ─────────────────────────────────────────────────────────────────
// Helper: Parse XML NF-e using browser's native DOMParser
// ─────────────────────────────────────────────────────────────────
export function parseNFeXml(xmlText: string): any[] {
  const items: any[] = [];

  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Check for parsing errors
    const parserError = xmlDoc.getElementsByTagName("parsererror");
    if (parserError.length > 0) {
      console.error("DOMParser error:", parserError[0].textContent);
      return [];
    }

    const detList = xmlDoc.getElementsByTagName("det");
    if (!detList || detList.length === 0) return [];

    for (let i = 0; i < detList.length; i++) {
      const det = detList[i];
      const prod = det.getElementsByTagName("prod")[0];
      if (!prod) continue;

      const xProdEl = prod.getElementsByTagName("xProd")[0];
      const qComEl = prod.getElementsByTagName("qCom")[0];
      const vUnComEl = prod.getElementsByTagName("vUnCom")[0];
      const uComEl = prod.getElementsByTagName("uCom")[0];
      const xPedEl = prod.getElementsByTagName("xPed")[0];

      const xProd = xProdEl ? xProdEl.textContent || "" : "";
      const qCom = qComEl ? parseFloat(qComEl.textContent || "0") : 0;
      const vUnCom = vUnComEl ? parseFloat(vUnComEl.textContent || "0") : 0;
      const uCom = uComEl ? uComEl.textContent || "" : "";
      const xPed = xPedEl ? xPedEl.textContent || "" : "";

      // Try to infer brand/model/size from product name
      const sizeMatch = xProd.match(/\b(\d{3}\/\d{2}R\d{2})\b/i);
      const size = sizeMatch ? sizeMatch[1] : uCom || "—";

      // Brand heuristic: first word in product name
      const words = xProd.trim().split(/\s+/);
      const brand = words[0] || "Desconhecida";
      const model = words.slice(1).join(" ") || xProd;

      if (xProd) {
        items.push({
          virtualId: `PROD-XML-${i + 1}-${Date.now()}`,
          brand: brand.toUpperCase(),
          model: model.toUpperCase() || brand.toUpperCase(),
          size,
          quantity: Math.round(qCom) || 1,
          price: vUnCom || 0,
          notes: xPed || "",
          description: `Importado de XML NF-e: ${xProd}`
        });
      }
    }
  } catch (error) {
    console.error("Failed to parse XML using DOMParser:", error);
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse inventory report text (SEM GTIN format)
// ─────────────────────────────────────────────────────────────────
export function parseInventoryReportText(text: string): any[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const merged: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    if (/^\d+\s+SEM\s+GTIN/i.test(t)) {
      merged.push(t);
    } else if (merged.length > 0) {
      if (t.startsWith("CUSTO") || t.startsWith("QTD") || t.startsWith("VALOR")) continue;
      merged[merged.length - 1] += " " + t;
    }
  }

  const items: any[] = [];
  let idx = 0;

  for (const line of merged) {
    const mainMatch = line.match(
      /^\d+\s+SEM\s+GTIN\s+\d+\s+PNEU\s+(.+?)\s+PNEUS\s*\([^)]*\)\s+UN\s+([\d\s.,]+)/i
    );
    if (!mainMatch) continue;

    const productPart = mainMatch[1].trim();
    const afterUN = mainMatch[2].trim();

    const nums = (afterUN.match(/[\d.,]+/g) || []);
    let quantity = 0;
    let price = 0;

    if (nums.length === 2) {
      const raw0 = nums[0];
      const raw1 = nums[1];
      const v0 = parseFloat(raw0.replace(",", "."));
      const v1 = parseFloat(raw1.replace(",", "."));
      if (!raw0.includes(",") && !raw0.includes(".") && v0 < 500) {
        quantity = Math.round(v0);
        price = v1;
      } else {
        price = v0;
        quantity = Math.round(v1);
      }
    } else if (nums.length >= 3) {
      quantity = Math.round(parseFloat(nums[nums.length - 1].replace(",", "."))) || 1;
      const priceJoined = nums.slice(0, -1).join("").replace(",", ".");
      price = parseFloat(priceJoined) || 0;
    } else if (nums.length === 1) {
      quantity = Math.round(parseFloat(nums[0].replace(",", "."))) || 1;
    }

    const sizeRx = [
      /(\d{3}\/\d{2}R\d{2}(?:XL|C)?)/i,
      /(\d{3}\s+R\d{2}\s+C)/i,
      /(\d{3}\/\d{2}R\d{2})/i,
      /(\d{3}R\d{2})/i,
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
        .replace(/^\d+\/\d+R\d*\s*/, "").trim();

      if (beforeSize) {
        brand = beforeSize;
        model = afterSize || beforeSize;
      } else {
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
        if (!model) model = brand;
      }
    } else {
      const parts = productPart.split(/\s+/);
      brand = parts[0];
      model = parts.slice(1).join(" ") || brand;
    }

    idx++;
    items.push({
      virtualId: `PROD-REP-${idx}-${Date.now()}`,
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
// Helper: Parse tab-separated inventory (TSV / Spreadsheet pastes)
// ─────────────────────────────────────────────────────────────────
export function parseTabInventory(text: string): any[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const items: any[] = [];
  let idx = 0;

  const KNOWN_BRANDS = [
    "CONTINENTAL", "BARUM", "GENERAL", "GENERAL TIRES", "GENERAL TIRE",
    "PIRELLI", "MICHELIN", "GOODYEAR", "BRIDGESTONE", "DUNLOP",
    "FIRESTONE", "HANKOOK", "YOKOHAMA", "MAXXIS", "FALKEN", "XBRI", "SPEED MAX"
  ];

  const SIZE_RX = /(\d{3}\/\d{2}(?:\/\d{2})?)\s+(R\d{2}C?)/i;
  const hasTabs = text.includes("\t");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let description = "";
    let qty = 1;
    let price = 0;
    let brand = "Desconhecida";
    let model = "";
    let sizeNorm = "—";
    let notes = "";

    // Parse price helper that also checks for "consulta"
    const getPriceAndNotes = (rawPrice: string) => {
      if (/consulta/i.test(rawPrice)) {
        return { p: 0, n: "Sob consulta" };
      }
      const clean = rawPrice
        .replace(/R\$\s*/i, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/[^\d.]/g, "")
        .trim();
      return { p: parseFloat(clean) || 0, n: "" };
    };

    if (hasTabs) {
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      
      description = cols[0].trim();

      if (cols.length === 2) {
        qty = parseInt(cols[1].replace(/\D/g, "")) || 1;
      } else if (cols.length === 3) {
        qty = parseInt(cols[1].replace(/\D/g, "")) || 1;
        const res = getPriceAndNotes(cols[2]);
        price = res.p;
        if (res.n) notes = res.n;
      } else if (cols.length >= 4) {
        const col1Clean = cols[1].replace(/\s/g, "");
        // If col[1] is a pure number, it's likely qty in "desc \t qty \t cost \t price"
        const isCol1Numeric = /^\d+$/.test(col1Clean);
        
        if (isCol1Numeric) {
          qty = parseInt(col1Clean) || 1;
          const res = getPriceAndNotes(cols[3] || cols[2]);
          price = res.p;
          if (res.n) notes = res.n;
          if (cols[2] && cols[3]) {
            notes = notes ? `${notes} (Custo: ${cols[2].trim()})` : `Custo: ${cols[2].trim()}`;
          }
        } else {
          brand = cols[1].trim() !== "—" && cols[1].trim() !== "" ? cols[1].trim() : "Desconhecida";
          qty = parseInt(cols[2].replace(/\D/g, "")) || 1;
          const res = getPriceAndNotes(cols[3]);
          price = res.p;
          if (res.n) notes = res.n;
        }
      }
    } else {
      const match = line.match(/^(.+?)\s+(\d+)\s+R\$\s*([\d.,]+)\s+R\$\s*([\d.,]+)$/i);
      if (!match) continue;
      description = match[1].trim();
      qty = parseInt(match[2]) || 1;
      const cleanPrice = match[4]
        .replace(/R\$\s*/i, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .trim();
      price = parseFloat(cleanPrice) || 0;
    }

    const sizeMatch = description.match(SIZE_RX);
    if (sizeMatch) {
      const sizeBase = sizeMatch[1];
      const sizeR    = sizeMatch[2];
      sizeNorm = `${sizeBase}${sizeR}`;

      const sizeEnd = sizeMatch.index! + sizeMatch[0].length;
      let rest = description.substring(sizeEnd).trim();

      rest = rest.replace(/^\d+(?:\/\d+)?[A-Z]?\s*(?:XL\s*)?(?:FR\s*)?/i, "").trim();
      rest = rest.replace(/^XL\s*/i, "").trim();
      rest = rest.replace(/^FR\s*/i, "").trim();
      rest = rest.replace(/\s*\(?Contibid\)?\s*$/i, "").trim();
      rest = rest.replace(/\s*\(?BID\)?\s*$/i, "").trim();

      let detectedBrand = "Desconhecida";
      let detectedModel = rest;

      for (const kb of KNOWN_BRANDS) {
        const upperRest = rest.toUpperCase();
        if (upperRest.endsWith(kb)) {
          detectedBrand = kb;
          detectedModel = rest.substring(0, upperRest.length - kb.length).trim();
          break;
        }
        const kbIdx = upperRest.indexOf(kb);
        if (kbIdx >= 0) {
          detectedBrand = kb;
          detectedModel = (rest.substring(0, kbIdx) + " " + rest.substring(kbIdx + kb.length)).trim();
          break;
        }
      }

      detectedModel = detectedModel.replace(/\s*\d{2,3}[A-Z]\.?\s*/g, " ").trim();
      detectedModel = detectedModel.replace(/\s{2,}/g, " ").trim();

      if (detectedBrand === "Desconhecida" && rest) {
        const parts = rest.split(/\s+/);
        detectedBrand = parts[parts.length - 1] || parts[0];
        detectedModel = rest;
      }

      if (brand === "Desconhecida") {
        brand = detectedBrand;
      }
      model = detectedModel || description;
    } else {
      model = description;
      
      if (brand === "Desconhecida") {
        const upperDesc = description.toUpperCase();
        for (const kb of KNOWN_BRANDS) {
          if (upperDesc.startsWith(kb)) {
            brand = kb;
            model = description.substring(kb.length).trim();
            break;
          }
        }
      }
    }

    if (!model && brand === "Desconhecida") continue;

    idx++;
    items.push({
      virtualId: `PROD-TAB-${idx}-${Date.now()}`,
      brand: brand.toUpperCase(),
      model: (model || brand).toUpperCase(),
      size: sizeNorm,
      quantity: qty,
      price,
      notes,
      description: `Importado: ${brand} ${model} ${sizeNorm}`
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse CSV text
// ─────────────────────────────────────────────────────────────────
export function parseCsvText(csvText: string): any[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

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
        virtualId: `PROD-CSV-${idx + 1}-${Date.now()}`,
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
// Helper: Parse JSON data
// ─────────────────────────────────────────────────────────────────
export function parseJSON(text: string): any[] {
  try {
    const data = JSON.parse(text);
    const rawItems = Array.isArray(data) ? data : [data];
    const items: any[] = [];
    
    rawItems.forEach((obj: any, idx: number) => {
      if (typeof obj !== "object" || obj === null) return;
      
      const keys = Object.keys(obj);
      const getVal = (aliases: string[]) => {
        const key = keys.find(k => aliases.includes(k.toLowerCase()));
        return key ? obj[key] : undefined;
      };

      const description = getVal(["produto", "modelo", "descricao", "descrição", "description", "name", "nome", "item"]) || "";
      const brand = getVal(["marca", "brand", "fabricante", "make"]) || "Desconhecida";
      const size = getVal(["medida", "size", "tamanho", "dimensao", "dimensão", "dimension"]) || "—";
      const quantity = parseInt(getVal(["quantidade", "qty", "quantity", "qtd", "estoque", "quant", "amount"])) || 1;
      
      const rawPrice = getVal(["preco", "preço", "price", "valor", "vl_unit", "preco_unit", "value", "cost"]);
      let price = 0;
      if (typeof rawPrice === "number") {
        price = rawPrice;
      } else if (typeof rawPrice === "string") {
        price = parseFloat(rawPrice.replace(/R\$\s*/i, "").replace(/\./g, "").replace(",", ".")) || 0;
      }
      
      const notes = getVal(["obs", "observacao", "observação", "notes", "nota", "comment"]) || "";

      if (description || brand) {
        items.push({
          virtualId: `PROD-JSON-${idx}-${Date.now()}`,
          brand: String(brand).toUpperCase(),
          model: String(description || brand).toUpperCase(),
          size: String(size),
          quantity,
          price,
          notes: String(notes),
          description: `Importado via JSON: ${brand} ${description}`
        });
      }
    });
    
    return items;
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse HTML Table (scraped / copied source)
// ─────────────────────────────────────────────────────────────────
export function parseHTMLTable(htmlText: string): any[] {
  const items: any[] = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    const rows = Array.from(doc.getElementsByTagName("tr"));
    if (rows.length === 0) return [];

    const parsePriceLocal = (rawPrice: string) => {
      if (/consulta/i.test(rawPrice)) return { p: 0, n: "Sob consulta" };
      const clean = rawPrice
        .replace(/R\$\s*/i, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/[^\d.]/g, "")
        .trim();
      return { p: parseFloat(clean) || 0, n: "" };
    };

    let idx = 0;
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td, th"));
      if (cells.length < 2) continue;

      const cellTexts = cells.map(c => c.textContent?.trim() || "");
      
      // Skip header rows
      if (cellTexts.some(t => /produto|descri|marca|modelo|quantidade|preço|preco/i.test(t))) {
        continue;
      }

      const description = cellTexts[0];
      let qty = 1;
      let price = 0;
      let brand = "Desconhecida";
      let model = description;
      let notes = "";

      if (cellTexts.length === 2) {
        qty = parseInt(cellTexts[1].replace(/\D/g, "")) || 1;
      } else if (cellTexts.length === 3) {
        qty = parseInt(cellTexts[1].replace(/\D/g, "")) || 1;
        const res = parsePriceLocal(cellTexts[2]);
        price = res.p;
        if (res.n) notes = res.n;
      } else if (cellTexts.length >= 4) {
        brand = cellTexts[1] !== "—" && cellTexts[1] !== "" ? cellTexts[1] : "Desconhecida";
        qty = parseInt(cellTexts[2].replace(/\D/g, "")) || 1;
        const res = parsePriceLocal(cellTexts[3]);
        price = res.p;
        if (res.n) notes = res.n;
      }

      if (!description) continue;

      idx++;
      items.push({
        virtualId: `PROD-HTML-${idx}-${Date.now()}`,
        brand: brand.toUpperCase(),
        model: model.toUpperCase(),
        size: "—",
        quantity: qty,
        price,
        notes,
        description: `Importado de Tabela HTML: ${brand} ${model}`
      });
    }
  } catch (e) {
    console.error("HTML parsing failed:", e);
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse free-form / unstructured text (Ultra-Robust Fallback)
// ─────────────────────────────────────────────────────────────────
// Helper function to find and extract/normalize tire sizes from a line of text
function findAndExtractSize(line: string): { size: string; cleanLine: string } {
  let size = "—";
  let cleanLine = line;

  // 1. Standard Size: e.g. 205/55R16, 205-55-16, 205 55 16, 205/55 R 16, 275/80R22.5
  let m = line.match(/\b(\d{3})[\/\-\s](\d{2})[\/\-\s]?(?:R|ZR)?(\d{2}(?:\.5)?)(?:XL|C)?\b/i);
  if (m) {
    size = `${m[1]}/${m[2]}R${m[3]}`;
    const fullMatch = m[0];
    if (fullMatch.toUpperCase().endsWith("XL")) size += "XL";
    else if (fullMatch.toUpperCase().endsWith("C")) size += "C";
    
    cleanLine = line.replace(fullMatch, " ");
    return { size, cleanLine };
  }

  // 2. Flotation Size: e.g. 31X10.5R15, 31x10.5-15, 31 10.5 15
  m = line.match(/\b(\d{2})[\s\-xX](\d{1,2}(?:\.5)?)[\/\-\s]?(?:R)?(\d{2})\b/i);
  if (m) {
    size = `${m[1]}X${m[2]}R${m[3]}`;
    cleanLine = line.replace(m[0], " ");
    return { size, cleanLine };
  }

  // 3. Truck/Commercial: e.g. 7.50R16, 11R22.5, 10R22.5
  m = line.match(/\b(\d{1,2}(?:\.\d{1,2})?)[/\-\s]?(?:R)(\d{2}(?:\.5)?)\b/i);
  if (m) {
    size = `${m[1]}R${m[2]}`;
    cleanLine = line.replace(m[0], " ");
    return { size, cleanLine };
  }

  // 4. Simple/Rim-only: e.g. 175R14, 175-14
  m = line.match(/\b(\d{3})[\/\-\s]?(?:R|ZR)(\d{2})\b/i);
  if (m) {
    size = `${m[1]}R${m[2]}`;
    cleanLine = line.replace(m[0], " ");
    return { size, cleanLine };
  }

  return { size, cleanLine };
}

export function parseFreeFormText(text: string): any[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const items: any[] = [];
  let idx = 0;

  const KNOWN_BRANDS = [
    "PIRELLI", "MICHELIN", "GOODYEAR", "BRIDGESTONE", "DUNLOP",
    "FIRESTONE", "HANKOOK", "YOKOHAMA", "MAXXIS", "FALKEN",
    "CONTINENTAL", "BARUM", "GENERAL TIRE", "GENERAL TIRES", "GENERAL",
    "KUMHO", "BFGOODRICH", "COOPER", "TOYO", "NEXEN", "XBRI", "SPEED MAX",
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
    "MONROE", "KYB", "NAKATA", "COFAP", "SACHS", "MAPCO", "MOURA", "HELIAR"
  ];

  // Sort brands by length descending to match longer multi-word names first
  const sortedBrands = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.length < 3) continue;

    // Skip generic headers
    if (/^(total|subtotal|obs|nota|valor|custo|qtd|quantidade|preco|preço|produto|estoque|relatorio|relatório)/i.test(line)) continue;
    if (/^\d+\s+SEM\s+GTIN/i.test(line)) continue;

    // 1. Extract load index and speed rating (e.g. 91V, 109T) before size extraction
    let notes = "";
    const indexMatch = line.match(/\b(\d{2,3}[A-Z])\b/);
    if (indexMatch) {
      notes = indexMatch[1].toUpperCase();
      line = line.replace(indexMatch[0], " ");
    }

    // 2. Extract and remove tire size (and normalize its format)
    const { size, cleanLine } = findAndExtractSize(line);
    line = cleanLine;

    // 3. Extract and remove Price
    let price = 0;
    // Look for explicit currency tag first
    const currencyMatch = line.match(/(?:R\$|RS|r\$|rs)\s*([\d.,]+)/i);
    if (currencyMatch) {
      price = parseFloat(currencyMatch[1].replace(/\./g, "").replace(",", ".")) || 0;
      line = line.replace(currencyMatch[0], " ");
    } else {
      // Look for a number at the end of the line (e.g., "por 390", "450", "450 cada")
      const priceEndMatch = line.match(/(?:por|a|de|valendo|custa|custando)?\s*\b(\d{2,5}(?:[.,]\d{2})?)\s*(?:reais|cada|und|un)?\s*$/i);
      if (priceEndMatch) {
        price = parseFloat(priceEndMatch[1].replace(/\.(?=\d{3})/g, "").replace(",", ".")) || 0;
        line = line.replace(priceEndMatch[0], " ");
      }
    }

    // 4. Extract and remove Quantity
    let quantity = 1;
    const qtyXMatch = line.match(/\b(\d{1,3})\s*[xX]\b/);
    const qtyXMatch2 = line.match(/\b[xX]\s*(\d{1,3})\b/);
    const qtyUnMatch = line.match(/\b(\d{1,3})\s*(?:unids?|unds?|uns?|pçs?|pcs?|pecas?|pneus?|qts?|qtds?)\b/i);

    if (qtyXMatch) {
      quantity = parseInt(qtyXMatch[1]) || 1;
      line = line.replace(qtyXMatch[0], " ");
    } else if (qtyXMatch2) {
      quantity = parseInt(qtyXMatch2[1]) || 1;
      line = line.replace(qtyXMatch2[0], " ");
    } else if (qtyUnMatch) {
      quantity = parseInt(qtyUnMatch[1]) || 1;
      line = line.replace(qtyUnMatch[0], " ");
    } else {
      // Fallback: Check if line starts with a number (like "10 Pirelli...")
      const leadingQtyMatch = line.match(/^[-–•*\s]*(\d{1,3})\b/);
      if (leadingQtyMatch) {
        quantity = parseInt(leadingQtyMatch[1]) || 1;
        line = line.replace(leadingQtyMatch[0], " ");
      }
    }

    // 5. Clean line and extract Brand
    line = line.replace(/^[-–•*\s,;:|]+/, "").replace(/[-–•*\s,;:|]+$/, "").trim();
    
    let brand = "Desconhecida";
    const upperLine = line.toUpperCase();
    for (const kb of sortedBrands) {
      const idxBrand = upperLine.indexOf(kb);
      if (idxBrand >= 0) {
        brand = kb;
        line = (line.substring(0, idxBrand) + " " + line.substring(idxBrand + kb.length)).trim();
        break;
      }
    }

    // If no known brand matched, take the first word as the brand
    if (brand === "Desconhecida" && line) {
      const words = line.split(/\s+/);
      if (words[0] && words[0].length > 2 && !/^\d+$/.test(words[0])) {
        brand = words[0];
        line = line.substring(brand.length).trim();
      }
    }

    // 6. Extract Model from remaining text
    let model = line
      .replace(/^[-–•*\s,;:|/]+/, "")
      .replace(/[-–•*\s,;:|/]+$/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Remove filler words
    model = model.replace(/\b(?:cada|und|unidade|uni|por|de|com|x)\b/gi, "").trim();
    model = model.replace(/^[-–•*\s,;:|/]+/, "").replace(/[-–•*\s,;:|/]+$/, "").trim();

    if (!model) model = brand !== "Desconhecida" ? brand : "PNEU";

    idx++;
    items.push({
      virtualId: `PROD-FREE-${idx}-${Date.now()}`,
      brand: brand.toUpperCase(),
      model: model.toUpperCase(),
      size: size,
      quantity,
      price,
      notes,
      description: `Importado: ${brand.toUpperCase()} ${model.toUpperCase()} ${size}`
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Parse Unified Stock report (multi-company spreadsheet)
// ─────────────────────────────────────────────────────────────────
export function parseUnifiedStock(text: string, companies: any[] = []): any[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 3) return [];

  // Check if it matches the Unified Stock header
  const header = lines[0].toLowerCase();
  if (!header.includes("codigo") || !header.includes("descri") || !header.includes("vista") || !header.includes("prazo")) {
    return [];
  }

  // Extract company names from row 2
  const companyNames = lines[1].split("\t").map(n => n.trim()).filter(Boolean);
  if (companyNames.length === 0) return [];

  const items: any[] = [];
  
  const KNOWN_BRANDS = [
    "CONTINENTAL", "BARUM", "GENERAL", "GENERAL TIRES", "GENERAL TIRE",
    "PIRELLI", "MICHELIN", "GOODYEAR", "BRIDGESTONE", "DUNLOP",
    "FIRESTONE", "HANKOOK", "YOKOHAMA", "MAXXIS", "FALKEN", "XBRI", "SPEED MAX",
    "ONYX", "ONYX NY-06", "ZMAX", "APLUS", "MAXTREK", "CONFORSER", "DOVROAD", "BLACK ARROW",
    "ROADTRACK", "TERRENA", "ZMAX", "ONYX", "ONYX NY-06"
  ];
  const SIZE_RX = /(\d{3}\/\d{2}(?:\/\d{2})?)\s*(R\d{2}C?)/i;

  // Process data rows (starting from line 2)
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split("\t").map(c => c.trim());
    if (cols.length < 5) continue;

    const sku = cols[0];
    const description = cols[1];
    
    // The last two columns are Price Cash and Price Installment
    const priceCashRaw = cols[cols.length - 2] || "";
    const priceInstRaw = cols[cols.length - 1] || "";

    const parsePriceLocal = (rawPrice: string) => {
      if (!rawPrice || rawPrice === "-" || /consulta/i.test(rawPrice)) return 0;
      const clean = rawPrice
        .replace(/R\$\s*/i, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/[^\d.]/g, "")
        .trim();
      return parseFloat(clean) || 0;
    };

    const priceCash = parsePriceLocal(priceCashRaw);
    const priceInstallment = parsePriceLocal(priceInstRaw || priceCashRaw);

    // Parse brand, model, size from description
    let brand = "Desconhecida";
    let model = description;
    let sizeNorm = "—";

    const sizeMatch = description.match(SIZE_RX);
    if (sizeMatch) {
      const sizeBase = sizeMatch[1];
      const sizeR    = sizeMatch[2];
      sizeNorm = `${sizeBase}${sizeR}`;

      const sizeEnd = sizeMatch.index! + sizeMatch[0].length;
      let rest = description.substring(sizeEnd).trim();

      // Clean up common prefixes/suffixes
      rest = rest.replace(/^\d+(?:\/\d+)?[A-Z]?\s*(?:XL\s*)?(?:FR\s*)?/i, "").trim();
      rest = rest.replace(/^XL\s*/i, "").trim();
      rest = rest.replace(/^FR\s*/i, "").trim();
      rest = rest.replace(/\s*\(?Contibid\)?\s*$/i, "").trim();
      rest = rest.replace(/\s*\(?BID\)?\s*$/i, "").trim();

      let detectedBrand = "Desconhecida";
      let detectedModel = rest;

      for (const kb of KNOWN_BRANDS) {
        const upperRest = rest.toUpperCase();
        if (upperRest.endsWith(kb)) {
          detectedBrand = kb;
          detectedModel = rest.substring(0, upperRest.length - kb.length).trim();
          break;
        }
        const kbIdx = upperRest.indexOf(kb);
        if (kbIdx >= 0) {
          detectedBrand = kb;
          detectedModel = (rest.substring(0, kbIdx) + " " + rest.substring(kbIdx + kb.length)).trim();
          break;
        }
      }

      detectedModel = detectedModel.replace(/\s*\d{2,3}[A-Z]\.?\s*/g, " ").trim();
      detectedModel = detectedModel.replace(/\s{2,}/g, " ").trim();

      if (detectedBrand === "Desconhecida" && rest) {
        const parts = rest.split(/\s+/);
        detectedBrand = parts[parts.length - 1] || parts[0];
        detectedModel = rest;
      }

      brand = detectedBrand;
      model = detectedModel || description;
    } else {
      // Non-tire item (wheels, protectors, etc.)
      let cleanDesc = description.replace(/^[—\s-]+/, "").trim();
      
      for (const kb of KNOWN_BRANDS) {
        if (cleanDesc.toUpperCase().includes(kb)) {
          brand = kb;
          const kbIdx = cleanDesc.toUpperCase().indexOf(kb);
          cleanDesc = (cleanDesc.substring(0, kbIdx) + " " + cleanDesc.substring(kbIdx + kb.length)).trim();
          break;
        }
      }
      
      model = cleanDesc;
      if (brand === "Desconhecida") {
        const parts = cleanDesc.split(/\s+/);
        if (parts.length > 1) {
          brand = parts[0];
          model = parts.slice(1).join(" ");
        } else {
          model = cleanDesc;
        }
      }
    }

    // Now extract quantities for each company
    // Quantity columns are between index 2 and cols.length - 3 (inclusive)
    const qtyColumns = [];
    for (let colIdx = 2; colIdx < cols.length - 2; colIdx++) {
      qtyColumns.push({
        val: cols[colIdx],
        index: colIdx - 2
      });
    }

    // For each quantity column, if the quantity is > 0, create an item!
    qtyColumns.forEach((qCol) => {
      const qtyVal = qCol.val;
      if (!qtyVal || qtyVal === "-" || qtyVal === "0" || qtyVal === "") return;

      const quantity = parseInt(qtyVal) || 0;
      if (quantity <= 0) return;

      const compNameFromSheet = companyNames[qCol.index] || "";
      
      let companyId = "";
      let companyName = compNameFromSheet;

      if (companies && companies.length > 0) {
        const found = companies.find(c => c.name.toLowerCase() === compNameFromSheet.toLowerCase());
        if (found) {
          companyId = found.id;
          companyName = found.name;
        }
      }

      items.push({
        virtualId: `PROD-UNIFIED-${sku}-${qCol.index}-${Date.now()}`,
        sku,
        brand: brand.toUpperCase(),
        model: (model || brand).toUpperCase(),
        size: sizeNorm,
        quantity,
        price: priceCash,
        priceCash,
        priceInstallment,
        companyId,
        companyName,
        notes: sku ? `Cód: ${sku}` : "",
        description: `Importado de Estoque Geral: ${brand} ${model}`
      });
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// Main Coordinator: Tries all parsers in sequence and selects the best one
// ─────────────────────────────────────────────────────────────────
export function parseStockText(text: string, mimeType?: string, companies: any[] = []): any[] {
  if (!text || !text.trim()) return [];

  const cleanText = text.trim();

  // 0. Unified Stock Report (from the system itself)
  if (cleanText.toLowerCase().includes("codigo") && cleanText.toLowerCase().includes("descri") && cleanText.toLowerCase().includes("vista")) {
    const unifiedItems = parseUnifiedStock(cleanText, companies);
    if (unifiedItems.length > 0) return unifiedItems;
  }

  // 1. JSON
  if (cleanText.startsWith("[") || cleanText.startsWith("{")) {
    const jsonItems = parseJSON(cleanText);
    if (jsonItems.length > 0) return jsonItems;
  }

  // 2. HTML Table
  if (cleanText.includes("<tr") || cleanText.includes("<td") || cleanText.includes("<table")) {
    const htmlItems = parseHTMLTable(cleanText);
    if (htmlItems.length > 0) return htmlItems;
  }

  // 3. XML (NF-e)
  if (cleanText.includes("<nfeProc") || cleanText.includes("<infNFe") || (mimeType && (mimeType === "text/xml" || mimeType === "application/xml"))) {
    const xmlItems = parseNFeXml(cleanText);
    if (xmlItems.length > 0) return xmlItems;
  }

  // 4. Inventory Report (SEM GTIN)
  if (/SEM\s+GTIN/i.test(cleanText)) {
    const reportItems = parseInventoryReportText(cleanText);
    if (reportItems.length > 0) return reportItems;
  }

  // 5. Tab-separated values (TSV / pastes from Excel, Sheets or tables)
  const tabItems = parseTabInventory(cleanText);
  if (tabItems.length > 0) return tabItems;

  // 6. CSV (comma or semicolon separated)
  const csvItems = parseCsvText(cleanText);
  const usefulCsv = csvItems.filter(i => i.brand !== "Desconhecida" && i.quantity > 0);
  if (usefulCsv.length > 0) return csvItems;

  // 7. Free-form fallback
  return parseFreeFormText(cleanText);
}

// ─────────────────────────────────────────────────────────────────
// Helper: Load PDF.js from CDN dynamically
// ─────────────────────────────────────────────────────────────────
async function loadPdfJS(): Promise<any> {
  if ((window as any).pdfjsLib) {
    return (window as any).pdfjsLib;
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js";
    script.onload = () => {
      const pdfjsLib = (window as any).pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
      resolve(pdfjsLib);
    };
    script.onerror = () => reject(new Error("Falha ao carregar o leitor de PDF (CDN). Verifique sua conexão com a internet."));
    document.head.appendChild(script);
  });
}

// ─────────────────────────────────────────────────────────────────
// Helper: Extract text from PDF file client-side
// ─────────────────────────────────────────────────────────────────
export async function extractTextFromPdf(file: File): Promise<string> {
  const pdfjsLib = await loadPdfJS();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(" ");
    fullText += pageText + "\n";
  }
  
  return fullText;
}
