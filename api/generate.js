import Anthropic from "@anthropic-ai/sdk";
import formidable from "formidable";
import fs from "fs";

export const config = { api: { bodyParser: false } };

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ multiples: true });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Erro ao ler arquivos" });

    try {
      const markup = parseFloat(fields.markup?.[0] || fields.markup || "35");
      const multiplier = 1 + markup / 100;

      const catalogFile = Array.isArray(files.catalog) ? files.catalog[0] : files.catalog;
      const priceFile = Array.isArray(files.price) ? files.price[0] : files.price;

      const catB64 = toBase64(catalogFile.filepath);
      const catMime = getMime(catalogFile);
      const priceB64 = toBase64(priceFile.filepath);
      const priceMime = getMime(priceFile);

      // Lê tabela de preços
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
              text: `Extraia TODOS os produtos desta tabela de preços. Retorne SOMENTE JSON válido, sem texto extra, sem markdown. Formato: {"products":[{"code":"COD","name":"NOME","prices":{"P":10.00,"M":12.00,"G":14.00}}]}. Se o preço não variar por tamanho, use {"ÚNICO":valor}. Se não houver nome, use string vazia.`
            }
          ]
        }]
      });

      let priceMap = {};
      const priceTxt = priceRes.content.find(b => b.type === "text")?.text || "";
      const priceClean = priceTxt.replace(/```json|```/g, "").trim();
      const parsedPrices = JSON.parse(priceClean);
      (parsedPrices.products || []).forEach(p => {
        priceMap[p.code] = { name: p.name, prices: p.prices };
      });

      // Lê catálogo
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
              text: `Liste todos os produtos deste catálogo com suas imagens em base64 se possível. Retorne SOMENTE JSON válido, sem texto extra. Formato: {"brand":"NOME DA MARCA","products":[{"code":"COD","name":"NOME DO PRODUTO","imageBase64":"base64 da imagem ou vazio"}]}`
            }
          ]
        }]
      });

      const catTxt = catRes.content.find(b => b.type === "text")?.text || "";
      const catClean = catTxt.replace(/```json|```/g, "").trim();
      const parsedCat = JSON.parse(catClean);
      const brand = parsedCat.brand || "";
      const products = (parsedCat.products || []).map(p => {
        const info = priceMap[p.code] || {};
        const rawPrices = info.prices || {};
        const markedPrices = {};
        Object.entries(rawPrices).forEach(([tam, val]) => {
          markedPrices[tam] = (parseFloat(val) * multiplier).toFixed(2);
        });
        return {
          code: p.code,
          name: p.name || info.name || "",
          prices: markedPrices,
          imageBase64: p.imageBase64 || ""
        };
      });

      res.status(200).json({ brand, products, markup });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
