// Nos testes, as bibliotecas do CDN vêm do node_modules (mesmas versões fixadas na tela), sem depender da rede:
// SDK do Firebase, Leaflet, MarkerCluster, Chart.js e ExcelJS (.xlsx). Fontes e mapas de fundo (OpenStreetMap)
// são respondidos vazios.
const ARQUIVOS = {
  "leaflet.min.js": "node_modules/leaflet/dist/leaflet.js",
  "leaflet.min.css": "node_modules/leaflet/dist/leaflet.css",
  "leaflet.markercluster.min.js": "node_modules/leaflet.markercluster/dist/leaflet.markercluster.js",
  "MarkerCluster.min.css": "node_modules/leaflet.markercluster/dist/MarkerCluster.css",
  "MarkerCluster.Default.min.css": "node_modules/leaflet.markercluster/dist/MarkerCluster.Default.css",
  "chart.umd.min.js": "node_modules/chart.js/dist/chart.umd.js",
  "exceljs.min.js": "node_modules/exceljs/dist/exceljs.min.js",
};
// PNG transparente de 1×1 (mosaico do mapa de fundo).
const PNG_VAZIO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export async function rotearCdn(contexto) {
  await contexto.route("https://www.gstatic.com/firebasejs/**", (rota) => {
    const arquivo = new URL(rota.request().url()).pathname.split("/").pop();
    rota.fulfill({ path: `node_modules/firebase/${arquivo}`, contentType: "text/javascript" });
  });
  await contexto.route("https://cdnjs.cloudflare.com/**", (rota) => {
    const arquivo = new URL(rota.request().url()).pathname.split("/").pop();
    const local = ARQUIVOS[arquivo];
    if (!local) return rota.fulfill({ status: 404, body: "" });
    rota.fulfill({ path: local, contentType: arquivo.endsWith(".css") ? "text/css" : "text/javascript" });
  });
  await contexto.route(/tile\.openstreetmap\.org/, (rota) => rota.fulfill({ body: PNG_VAZIO, contentType: "image/png" }));
  await contexto.route(/fonts\.(googleapis|gstatic)\.com/, (rota) => rota.fulfill({ body: "", contentType: "text/css" }));
}

/**
 * Confere, na página aberta, que nada passa da largura da tela: tira o corte (overflow-x: clip) de html/body
 * para medir de verdade e lista elementos visíveis fora da tela que não estão dentro de uma área com rolagem própria.
 */
export async function medirLargura(pagina) {
  return pagina.evaluate(() => {
    const raiz = document.documentElement, corpo = document.body;
    const antes = [raiz.style.overflowX, corpo.style.overflowX];
    raiz.style.overflowX = "visible"; corpo.style.overflowX = "visible";
    const largura = raiz.clientWidth, rolagem = Math.max(raiz.scrollWidth, corpo.scrollWidth);
    const fora = [];
    for (const el of corpo.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || (r.right <= largura + 1 && r.left >= -1)) continue;
      let a = el.parentElement, dentroDeRolagem = false;
      while (a && a !== corpo) { if (getComputedStyle(a).overflowX !== "visible") { dentroDeRolagem = true; break; } a = a.parentElement; }
      if (dentroDeRolagem || getComputedStyle(el).visibility === "hidden") continue;
      fora.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].join(".")} (${Math.round(r.left)}–${Math.round(r.right)})`);
    }
    raiz.style.overflowX = antes[0]; corpo.style.overflowX = antes[1];
    return { largura, rolagem, fora: fora.slice(0, 8) };
  });
}
