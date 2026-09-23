// Carrega o bloco <relevancia> de publico/index.html como módulo (mesmo código da tela).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../publico/index.html", import.meta.url)), "utf8");
const m = html.match(/\/\/ <relevancia>[\s\S]*?\/\/ <\/relevancia>/);
if (!m) throw new Error("Bloco <relevancia> não encontrado em publico/index.html");
const codigo = `${m[0]}\nexport { SINONIMOS, semAcento, palavras, sugerirSinonimos, casaFrase, criterioSegmento, noSegmento };`;
export const R = await import(`data:text/javascript;base64,${Buffer.from(codigo).toString("base64")}`);
