// Gera as imagens da marca a partir das fontes editáveis do repositório:
//  - publico/og-image.png (1200×630, preview de link) a partir de ferramentas/marca/og-image.html;
//  - favicon-32.png, apple-touch-icon.png (180), icone-192.png e icone-512.png a partir de publico/favicon.svg.
// Uso: node ferramentas/gerar_imagens.mjs   (NAVEGADOR = caminho do Chromium/Chrome)
import { readFileSync, statSync } from "node:fs";
import { chromium } from "playwright-core";

const malha = JSON.parse(readFileSync("dados/malha_rn_municipio_minima.geojson.json", "utf8"));
const pop = new Map(JSON.parse(readFileSync("dados/municipios_rn.json", "utf8")).municipios.map((m) => [m.codigo_ibge, m.populacao_2022]));

// Mesma projeção da tela (equiretangular com correção de latitude).
const KX = Math.cos((-5.9 * Math.PI) / 180), L = { x0: -38.6, x1: -34.95, y0: -4.8, y1: -7.0 };
const H = ((L.y0 - L.y1) / ((L.x1 - L.x0) * KX)) * 100;
const px = ([lon, lat]) => [((lon - L.x0) / (L.x1 - L.x0)) * 100, ((L.y0 - lat) / (L.y0 - L.y1)) * H];
const caminho = (g) => (g.type === "Polygon" ? g.coordinates : g.coordinates.flat())
  .map((a) => "M" + a.map((p) => px(p).map((v) => v.toFixed(2)).join(",")).join("L") + "Z").join("");
// Rampa azul (população, faixas iguais às da tela Mercado).
const FAIXAS = [5000, 10000, 20000, 50000, 100000, 300000];
const CORES = ["#1d3a70", "#23478a", "#2a5aa8", "#3272cc", "#4f8fe0", "#86b6ef", "#cde2fb"];
const cor = (p) => CORES[(FAIXAS.findIndex((f) => p <= f) + 1 || 7) - 1];
const mapa = malha.features.map((f) => `<path class="mun" fill="${cor(pop.get(f.properties.codarea) || 0)}" d="${caminho(f.geometry)}"/>`).join("");

const html = readFileSync("ferramentas/marca/og-image.html", "utf8")
  .replace('viewBox="0 0 100 60" aria-hidden="true"><!-- MAPA -->', `viewBox="0 0 100 ${H.toFixed(2)}" aria-hidden="true">${mapa}`);

// PROXY_NAVEGADOR: só no ambiente de desenvolvimento (que sai pela internet por um proxy), para carregar a fonte.
const navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium",
  ...(process.env.PROXY_NAVEGADOR ? { proxy: { server: process.env.PROXY_NAVEGADOR } } : {}) });
try {
  const og = await navegador.newPage({ viewport: { width: 1200, height: 630 }, ignoreHTTPSErrors: Boolean(process.env.PROXY_NAVEGADOR) });
  await og.setContent(html, { waitUntil: "networkidle" });
  await og.evaluate(() => document.fonts.ready);
  await og.screenshot({ path: "publico/og-image.png", type: "png" });
  const svg = readFileSync("publico/favicon.svg", "utf8");
  for (const [arquivo, lado] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180], ["icone-192.png", 192], ["icone-512.png", 512]]) {
    const p = await navegador.newPage({ viewport: { width: lado, height: lado } });
    // apple-touch-icon sem cantos transparentes (o iOS arredonda sozinho).
    const fundo = arquivo === "apple-touch-icon.png" ? "background:#1f5fd6;" : "";
    await p.setContent(`<html><body style="margin:0;${fundo}">${svg.replace("<svg ", `<svg width="${lado}" height="${lado}" `)}</body></html>`);
    await p.screenshot({ path: `publico/${arquivo}`, omitBackground: !fundo });
  }
} finally {
  await navegador.close();
}
const kb = (f) => Math.round(statSync(f).size / 1024);
console.log(`og-image.png: ${kb("publico/og-image.png")} KB (limite 300 KB)`);
if (kb("publico/og-image.png") > 300) { console.log("ERRO: og-image acima de 300 KB"); process.exit(1); }
