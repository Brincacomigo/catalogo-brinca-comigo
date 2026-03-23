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

      let priceMap = {};
      const pTxt = priceRes.content.find(b=>b.type==="text")?.text||"";
      (JSON.parse(pTxt.replace(/```json|```/g,"").trim()).products||[])
        .forEach(p=>{ priceMap[String(p.code)]=p.prices||{}; });

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

      const byPage = {};
      result.forEach(p => {
        const pg = p.page||1;
        if (!byPage[pg]) byPage[pg]=[];
        byPage[pg].push(p);
      });

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
        page.drawRectangle({ x:0, y:boxH-1, width, height:1, color:rgb(0.9,0.9,0.9) });
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
