// Gera as imagens da marca a partir das fontes editáveis do repositório:
//  - publico/og-image-rn-pb.png (1200×630, preview de link) a partir de ferramentas/marca/og-image.html;
//  - favicon-32.png, apple-touch-icon.png (180), icone-192.png e icone-512.png a partir de publico/favicon.svg.
// Uso: node ferramentas/gerar_imagens.mjs   (NAVEGADOR = caminho do Chromium/Chrome)
import { readFileSync, statSync } from "node:fs";
import { chromium } from "playwright-core";

// Estados ativos (RN e PB) juntos, numa projeção só (equiretangular com correção de latitude, como a tela).
const UFS = ["rn", "pb"];
const malha = { features: UFS.flatMap((uf) => JSON.parse(readFileSync(`dados/malha_${uf}_municipio_minima.geojson.json`, "utf8")).features) };
const pop = new Map(UFS.flatMap((uf) => JSON.parse(readFileSync(`dados/municipios_${uf}.json`, "utf8")).municipios.map((m) => [m.codigo_ibge, m.populacao_2022])));

let x0 = 180, x1 = -180, y0 = -90, y1 = 90;
const ver = (c) => (typeof c[0] === "number" ? (x0 = Math.min(x0, c[0]), x1 = Math.max(x1, c[0]), y0 = Math.max(y0, c[1]), y1 = Math.min(y1, c[1])) : c.forEach(ver));
for (const f of malha.features) ver(f.geometry.coordinates);
const KX = Math.cos((((y0 + y1) / 2) * Math.PI) / 180), L = { x0, x1, y0, y1 };
const H = ((L.y0 - L.y1) / ((L.x1 - L.x0) * KX)) * 100;
const px = ([lon, lat]) => [((lon - L.x0) / (L.x1 - L.x0)) * 100, ((L.y0 - lat) / (L.y0 - L.y1)) * H];
const caminho = (g) => (g.type === "Polygon" ? g.coordinates : g.coordinates.flat())
  .map((a) => "M" + a.map((p) => px(p).map((v) => v.toFixed(2)).join(",")).join("L") + "Z").join("");
// Rampa azul (população, faixas iguais às da tela Mercado).
const FAIXAS = [5000, 10000, 20000, 50000, 100000, 300000];
const CORES = ["#1d3a70", "#23478a", "#2a5aa8", "#3272cc", "#4f8fe0", "#86b6ef", "#cde2fb"];
const cor = (p) => CORES[(FAIXAS.findIndex((f) => p <= f) + 1 || 7) - 1];
// Sigla de cada estado no meio dos contornos dele (média dos pontos), com contorno escuro para ler sobre o mapa.
const siglas = UFS.map((uf) => {
  const pts = JSON.parse(readFileSync(`dados/malha_${uf}_municipio_minima.geojson.json`, "utf8")).features
    .flatMap((f) => (f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat()).flat());
  const [x, y] = px([pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]);
  return `<text class="uf" x="${x.toFixed(2)}" y="${y.toFixed(2)}">${uf.toUpperCase()}</text>`;
}).join("");
// Divisa RN × PB: lados de contorno que aparecem nos dois estados (a malha do IBGE usa os mesmos pontos na divisa).
const lados = (uf) => {
  const m = new Map();
  for (const f of JSON.parse(readFileSync(`dados/malha_${uf}_municipio_minima.geojson.json`, "utf8")).features)
    for (const a of f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat())
      for (let i = 1; i < a.length; i++) { const k = [a[i - 1], a[i]].map((p) => p.join(",")).sort().join(";"); m.set(k, [a[i - 1], a[i]]); }
  return m;
};
const [ladosA, ladosB] = UFS.map(lados);
const divisa = [...ladosA].filter(([k]) => ladosB.has(k)).map(([, [p, q]]) => `M${px(p).map((v) => v.toFixed(2)).join(",")}L${px(q).map((v) => v.toFixed(2)).join(",")}`).join("");
const mapa = malha.features.map((f) => `<path class="mun" fill="${cor(pop.get(f.properties.codarea) || 0)}" d="${caminho(f.geometry)}"/>`).join("") + `<path class="divisa" d="${divisa}"/>` + siglas;

// FONTES_LOCAIS = pasta com inter-latin-{400,600,800}-normal.woff2 (npm @fontsource/inter): usa a Inter sem internet.
let html = readFileSync("ferramentas/marca/og-image.html", "utf8");
if (process.env.FONTES_LOCAIS) {
  const face = (peso) => `@font-face{font-family:Inter;font-weight:${peso};src:url(data:font/woff2;base64,${readFileSync(`${process.env.FONTES_LOCAIS}/inter-latin-${peso}-normal.woff2`).toString("base64")}) format("woff2")}`;
  html = html.replace(/<link href="https:\/\/fonts\.googleapis[^>]*>/, `<style>${[400, 600, 800].map(face).join("")}</style>`);
}
html = html
  .replace('viewBox="0 0 100 60" aria-hidden="true"><!-- MAPA -->', `viewBox="0 0 100 ${H.toFixed(2)}" aria-hidden="true">${mapa}`);

// PROXY_NAVEGADOR: só no ambiente de desenvolvimento (que sai pela internet por um proxy), para carregar a fonte.
const navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium",
  ...(process.env.PROXY_NAVEGADOR ? { proxy: { server: process.env.PROXY_NAVEGADOR } } : {}) });
try {
  const og = await navegador.newPage({ viewport: { width: 1200, height: 630 }, ignoreHTTPSErrors: Boolean(process.env.PROXY_NAVEGADOR) });
  await og.setContent(html, { waitUntil: "networkidle" });
  await og.evaluate(() => document.fonts.ready);
  await og.screenshot({ path: "publico/og-image-rn-pb.png", type: "png" });
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
console.log(`divisa RN × PB: ${divisa.split("M").length - 1} lados`);
console.log(`og-image-rn-pb.png: ${kb("publico/og-image-rn-pb.png")} KB (limite 300 KB)`);
if (kb("publico/og-image-rn-pb.png") > 300) { console.log("ERRO: og-image-rn-pb acima de 300 KB"); process.exit(1); }
