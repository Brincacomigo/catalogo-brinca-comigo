import Anthropic from "@anthropic-ai/sdk";
import formidable from "formidable";
import fs from "fs";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

export const config = { api: { bodyParser: false, responseLimit: false, maxDuration: 60 } };

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function toBase64(fp) { return fs.readFileSync(fp).toString("base64"); }
function getMime(file) {
  const ext = file.originalFilename?.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  return "image/jpeg";
}
function mapCol(sz) {
  const s = (sz||"").toLowerCase().replace(/\s/g,"");
  if (s.includes("1/2/3")||s.includes("1a3")) return "1 a 3";
  if (s.includes("4/6/8")||s.includes("4a8")) return "4 a 8";
  if (s.includes("p/m/g")||s.includes("pagg")) return "P a GG";
  if (s.includes("p/m")||s.includes("pam")) return "P a M";
  if (s==="único"||s==="unico"||s==="un") return "ÚNICO";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const form = formidable({ multiples: true, maxFileSize: 20*1024*1024 });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Erro ao ler arquivos" });
    try {
      const markup = parseFloat(fields.markup?.[0]||fields.markup||"35");
      const mult = 1 + markup/100;
      const catFile = Array.isArray(files.catalog)?files.catalog[0]:files.catalog;
      const priceFile = Array.isArray(files.price)?files.price[0]:files.price;

      // Roda as duas chamadas de IA em paralelo para economizar tempo
      const [priceRes, catRes] = await Promise.all([
        client.messages.create({
          model: "claude-sonnet-4-20250514", max_tokens: 4000,
          messages: [{ role: "user", content: [
            { type: getMime(priceFile)==="application/pdf"?"document":"image", source: { type:"base64", media_type:getMime(priceFile), data:toBase64(priceFile.filepath) } },
            { type: "text", text: `Extraia todos os produtos. Colunas: "P a GG","P a M","1 a 3","4 a 8","ÚNICO". JSON sem markdown: {"products":[{"code":"62521","prices":{"1 a 3":74.90,"4 a 8":84.90}}]}` }
          ]}]
        }),
        client.messages.create({
          model: "claude-sonnet-4-20250514", max_tokens: 4000,
          messages: [{ role: "user", content: [
            { type: getMime(catFile)==="application/pdf"?"document":"image", source: { type:"base64", media_type:getMime(catFile), data:toBase64(catFile.filepath) } },
            { type: "text", text: `Liste todos os produtos com código, tamanhos e página. JSON sem markdown: {"brand":"NOME","products":[{"code":"62521","sizes":["1/2/3","4/6/8"],"page":10}]}` }
          ]}]
        })
      ]);

      // Monta mapa de preços
      let priceMap = {};
      const pTxt = priceRes.content.find(b=>b.type==="text")?.text||"";
      (JSON.parse(pTxt.replace(/```json|```/g,"").trim()).products||[])
        .forEach(p=>{ priceMap[String(p.code)]=p.prices||{}; });

      // Processa catálogo
      const cTxt = catRes.content.find(b=>b.type==="text")?.text||"";
      const parsedCat = JSON.parse(cTxt.replace(/```json|```/g,"").trim());
      const brand = parsedCat.brand||"";

      const result = (parsedCat.products||[]).map(p => {
        const base = priceMap[String(p.code)]||{};
        const marked = {};
        (p.sizes||[]).forEach(sz => {
          const col = mapCol(sz);
          if (col && base[col]) marked[sz] = "R$ "+(parseFloat(base[col])*mult).toFixed(2).replace(".",",");
        });
        if (!Object.keys(marked).length && base["ÚNICO"])
          marked["ÚNICO"] = "R$ "+(parseFloat(base["ÚNICO"])*mult).toFixed(2).replace(".",",");
        return { code:p.code, sizes:p.sizes||[], prices:marked, page:p.page };
      });

      // Agrupa por página
      const byPage = {};
      result.forEach(p => {
        const pg = p.page||1;
        if (!byPage[pg]) byPage[pg]=[];
        byPage[pg].push(p);
      });

      // Carimba no PDF
      const pdfDoc = await PDFDocument.load(fs.readFileSync(catFile.filepath));
      const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontN = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const pages = pdfDoc.getPages();

      Object.entries(byPage).forEach(([pg, prods]) => {
        const idx = parseInt(pg)-1;
        if (idx<0||idx>=pages.length) return;
        const page = pages[idx];
        const {width} = page.getSize();
        const list = prods.filter(p=>Object.keys(p.prices).length>0);
        if (!list.length) return;

        const rowH = 15;
        const boxH = list.length*rowH+8;

        page.drawRectangle({ x:0, y:0, width, height:boxH, color:rgb(1,1,1), opacity:0.93 });
        page.drawRectangle({ x:0, y:boxH-1, width, height:1, color:rgb(0.9,0.9,0.9), opacity:1 });

        list.forEach((p,i) => {
          const y = boxH-(i+1)*rowH;
          page.drawText(String(p.code), { x:8, y:y+3, size:8, font:fontB, color:rgb(0.1,0.1,0.1) });
          const priceStr = Object.entries(p.prices).map(([sz,v])=>`${sz}: ${v}`).join("   ");
          page.drawText(priceStr, { x:58, y:y+3, size:8, font:fontN, color:rgb(0.8,0.3,0.0) });
        });
      });

      const out = await pdfDoc.save();
      res.status(200).json({ brand, products:result, markup, pdfBase64:Buffer.from(out).toString("base64") });

    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
}


function toBase64(filePath) {
  return fs.readFileSync(filePath).toString("base64");
}

function getMime(file) {
  const ext = file.originalFilename?.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/jpeg";
}

function mapSizeToColumn(sizeStr) {
  const s = (sizeStr || "").toLowerCase().replace(/\s/g, "");
  if (s.includes("1/2/3") || s.includes("1a3") || s === "1-3") return "1 a 3";
  if (s.includes("4/6/8") || s.includes("4a8") || s === "4-8") return "4 a 8";
  if (s.includes("p/m/g/gg") || s.includes("pagg")) return "P a GG";
  if (s.includes("p/m") || s.includes("pam")) return "P a M";
  if (s === "único" || s === "unico" || s === "un") return "ÚNICO";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ multiples: true, maxFileSize: 20 * 1024 * 1024 });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Erro ao ler arquivos: " + err.message });

    try {
      const markup = parseFloat(fields.markup?.[0] || fields.markup || "35");
      const multiplier = 1 + markup / 100;

      const catalogFile = Array.isArray(files.catalog) ? files.catalog[0] : files.catalog;
      const priceFile = Array.isArray(files.price) ? files.price[0] : files.price;

      const priceB64 = toBase64(priceFile.filepath);
      const priceMime = getMime(priceFile);

      // 1. Lê tabela de preços
      const priceRes = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: priceMime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: priceMime, data: priceB64 } },
            { type: "text", text: `Extraia todos os produtos desta tabela. Colunas possíveis: "P a GG", "P a M", "1 a 3", "4 a 8", "ÚNICO". Retorne SOMENTE JSON sem markdown: {"products":[{"code":"62521","prices":{"1 a 3":74.90,"4 a 8":84.90}}]}` }
          ]
        }]
      });

      let priceMap = {};
      const priceTxt = priceRes.content.find(b => b.type === "text")?.text || "";
      const parsedPrices = JSON.parse(priceTxt.replace(/```json|```/g, "").trim());
      (parsedPrices.products || []).forEach(p => { priceMap[String(p.code)] = p.prices || {}; });

      // 2. Lê catálogo — produtos por página
      const catB64 = toBase64(catalogFile.filepath);
      const catMime = getMime(catalogFile);

      const catRes = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: catMime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: catMime, data: catB64 } },
            { type: "text", text: `Liste todos os produtos deste catálogo. Para cada produto informe o código, tamanhos disponíveis e número da página onde aparece. Retorne SOMENTE JSON sem markdown: {"brand":"NOME","products":[{"code":"62521","sizes":["1/2/3","4/6/8"],"page":10}]}` }
          ]
        }]
      });

      const catTxt = catRes.content.find(b => b.type === "text")?.text || "";
      const parsedCat = JSON.parse(catTxt.replace(/```json|```/g, "").trim());
      const brand = parsedCat.brand || "";
      const products = parsedCat.products || [];

      // 3. Cruza códigos com preços e aplica markup
      const result = products.map(p => {
        const basePrice = priceMap[String(p.code)] || {};
        const markedPrices = {};
        (p.sizes || []).forEach(sz => {
          const col = mapSizeToColumn(sz);
          if (col && basePrice[col]) {
            markedPrices[sz] = "R$ " + (parseFloat(basePrice[col]) * multiplier).toFixed(2).replace(".", ",");
          }
        });
        if (Object.keys(markedPrices).length === 0 && basePrice["ÚNICO"]) {
          markedPrices["ÚNICO"] = "R$ " + (parseFloat(basePrice["ÚNICO"]) * multiplier).toFixed(2).replace(".", ",");
        }
        return { code: p.code, sizes: p.sizes || [], prices: markedPrices, page: p.page };
      });

      // 4. Agrupa produtos por página
      const byPage = {};
      result.forEach(p => {
        const pg = p.page || 1;
        if (!byPage[pg]) byPage[pg] = [];
        byPage[pg].push(p);
      });

      // 5. Abre PDF e carimba preços no rodapé de cada página
      const pdfBytes = fs.readFileSync(catalogFile.filepath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const pages = pdfDoc.getPages();

      Object.entries(byPage).forEach(([pageNum, prods]) => {
        const pageIdx = parseInt(pageNum) - 1;
        if (pageIdx < 0 || pageIdx >= pages.length) return;
        const page = pages[pageIdx];
        const { width } = page.getSize();

        // Filtra só produtos que têm preço
        const prodsWithPrice = prods.filter(p => Object.keys(p.prices).length > 0);
        if (prodsWithPrice.length === 0) return;

        const rowHeight = 16;
        const totalHeight = prodsWithPrice.length * rowHeight + 10;
        const startY = totalHeight;

        // Fundo branco semi-transparente
        page.drawRectangle({
          x: 0, y: 0, width, height: totalHeight,
          color: rgb(1, 1, 1), opacity: 0.92,
        });

        prodsWithPrice.forEach((p, i) => {
          const y = startY - (i + 1) * rowHeight;
          const priceStr = Object.entries(p.prices)
            .map(([sz, val]) => `${sz}: ${val}`)
            .join("   ");

          // Código em negrito
          page.drawText(String(p.code), {
            x: 8, y: y + 3, size: 8, font,
            color: rgb(0.1, 0.1, 0.1),
          });

          // Preços em normal
          page.drawText(priceStr, {
            x: 60, y: y + 3, size: 8, font: fontNormal,
            color: rgb(0.85, 0.35, 0.05),
          });
        });
      });

      const modifiedPdfBytes = await pdfDoc.save();
      const modifiedB64 = Buffer.from(modifiedPdfBytes).toString("base64");

      res.status(200).json({ brand, products: result, markup, pdfBase64: modifiedB64 });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}


export const config = { api: { bodyParser: false, responseLimit: false, maxDuration: 60 } };

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function toBase64(filePath) {
  return fs.readFileSync(filePath).toString("base64");
}

function getMime(file) {
  const ext = file.originalFilename?.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/jpeg";
}

// Mapeia tamanhos do catálogo para colunas da tabela
function mapSizeToColumn(sizeStr) {
  const s = sizeStr.toLowerCase().replace(/\s/g, "");
  if (s.includes("1/2/3") || s.includes("1a3") || s === "1-3") return "1 a 3";
  if (s.includes("4/6/8") || s.includes("4a8") || s === "4-8") return "4 a 8";
  if (s.includes("p/m") || s.includes("pam") || s.includes("pagm")) return "P a M";
  if (s.includes("p/m/g/gg") || s.includes("pagg") || s.includes("paggg")) return "P a GG";
  if (s === "único" || s === "unico" || s === "un") return "ÚNICO";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ multiples: true, maxFileSize: 20 * 1024 * 1024 });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Erro ao ler arquivos: " + err.message });

    try {
      const markup = parseFloat(fields.markup?.[0] || fields.markup || "35");
      const multiplier = 1 + markup / 100;

      const catalogFile = Array.isArray(files.catalog) ? files.catalog[0] : files.catalog;
      const priceFile = Array.isArray(files.price) ? files.price[0] : files.price;

      const priceB64 = toBase64(priceFile.filepath);
      const priceMime = getMime(priceFile);

      // 1. Lê tabela de preços com IA
      const priceRes = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            {
              type: priceMime === "application/pdf" ? "document" : "image",
              source: { type: "base64", media_type: priceMime, data: priceB64 }
            },
            {
              type: "text",
              text: `Extraia todos os produtos desta tabela de preços. As colunas de tamanho podem ser: "P a GG", "P a M", "1 a 3", "4 a 8", "ÚNICO". Retorne SOMENTE JSON válido sem markdown. Formato: {"products":[{"code":"62521","prices":{"1 a 3":74.90,"4 a 8":84.90}}]}`
            }
          ]
        }]
      });

      let priceMap = {};
      const priceTxt = priceRes.content.find(b => b.type === "text")?.text || "";
      const priceClean = priceTxt.replace(/```json|```/g, "").trim();
      const parsedPrices = JSON.parse(priceClean);
      (parsedPrices.products || []).forEach(p => { priceMap[String(p.code)] = p.prices || {}; });

      // 2. Lê catálogo com IA para identificar produtos por página
      const catB64 = toBase64(catalogFile.filepath);
      const catMime = getMime(catalogFile);

      const catRes = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            {
              type: catMime === "application/pdf" ? "document" : "image",
              source: { type: "base64", media_type: catMime, data: catB64 }
            },
            {
              type: "text",
              text: `Para cada produto neste catálogo, identifique: o código, os tamanhos disponíveis e em qual página está. Retorne SOMENTE JSON válido sem markdown. Formato: {"brand":"NOME","products":[{"code":"62521","sizes":["1/2/3","4/6/8"],"page":10}]}`
            }
          ]
        }]
      });

      const catTxt = catRes.content.find(b => b.type === "text")?.text || "";
      const catClean = catTxt.replace(/```json|```/g, "").trim();
      const parsedCat = JSON.parse(catClean);
      const brand = parsedCat.brand || "";
      const products = parsedCat.products || [];

      // 3. Monta lista de produtos com preços marcados
      const result = products.map(p => {
        const basePrice = priceMap[String(p.code)] || {};
        const markedPrices = {};
        (p.sizes || []).forEach(sz => {
          const col = mapSizeToColumn(sz);
          if (col && basePrice[col]) {
            markedPrices[sz] = "R$ " + (parseFloat(basePrice[col]) * multiplier).toFixed(2).replace(".", ",");
          }
        });
        // fallback: se não achou por tamanho, pega ÚNICO
        if (Object.keys(markedPrices).length === 0 && basePrice["ÚNICO"]) {
          markedPrices["ÚNICO"] = "R$ " + (parseFloat(basePrice["ÚNICO"]) * multiplier).toFixed(2).replace(".", ",");
        }
        return { code: p.code, sizes: p.sizes || [], prices: markedPrices, page: p.page };
      });

      // 4. Abre o PDF original e carimba os preços
      const pdfBytes = fs.readFileSync(catalogFile.filepath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const pages = pdfDoc.getPages();

      for (const product of result) {
        if (!product.prices || Object.keys(product.prices).length === 0) continue;
        const pageIdx = (product.page || 1) - 1;
        if (pageIdx < 0 || pageIdx >= pages.length) continue;
        const page = pages[pageIdx];
        const { width, height } = page.getSize();

        // Procura posição do código na página para saber onde colocar o preço
        // Como não temos coordenadas exatas, colocamos no rodapé da página agrupado por código
        const priceText = Object.entries(product.prices)
          .map(([sz, val]) => `${sz}: ${val}`)
          .join("  |  ");

        // Posição: parte inferior da página, empilhado por produto
        const yPos = 40 + (result.filter(r => r.page === product.page).indexOf(product) * 18);

        page.drawRectangle({
          x: 10, y: yPos - 4, width: width - 20, height: 16,
          color: rgb(1, 1, 1), opacity: 0.85,
        });

        page.drawText(`${product.code}  ${priceText}`, {
          x: 14, y: yPos,
          size: 9, font,
          color: rgb(0.15, 0.15, 0.15),
        });
      }

      const modifiedPdfBytes = await pdfDoc.save();
      const modifiedB64 = Buffer.from(modifiedPdfBytes).toString("base64");

      res.status(200).json({ brand, products: result, markup, pdfBase64: modifiedB64 });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
