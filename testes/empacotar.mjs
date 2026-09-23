// Empacota as Netlify Functions com o MESMO empacotador do Netlify (zip-it-and-ship-it,
// esbuild) e descompacta cada uma em .netlify/teste-empacotamento/<nome>/.
// Depois, testes/funcoes.test.mjs roda contra esse código empacotado, com Node SEM
// suporte a require() de ES Module (como o runtime das Functions em produção).
// Motivo: em 24/09 o deploy real falhou com ERR_REQUIRE_ESM (jose x jwks-rsa) e os
// testes contra o código-fonte não pegaram.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { zipFunctions } from "@netlify/zip-it-and-ship-it";

const DESTINO = ".netlify/teste-empacotamento";
rmSync(DESTINO, { recursive: true, force: true });
mkdirSync(`${DESTINO}/zips`, { recursive: true });

const resultado = await zipFunctions("netlify/functions", `${DESTINO}/zips`, {
  basePath: process.cwd(),
  config: { "*": { nodeBundler: "esbuild", includedFiles: ["dados/*.json"] } },
});
for (const funcao of resultado) {
  execFileSync("unzip", ["-q", "-o", funcao.path, "-d", `${DESTINO}/${funcao.name}`]);
}
console.log("Empacotadas:", readdirSync(DESTINO).filter((n) => n !== "zips").sort().join(", "));
