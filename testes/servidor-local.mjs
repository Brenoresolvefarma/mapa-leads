// Servidor local SÓ PARA TESTES: serve a página (publico/), os dados do IBGE em /dados/
// (como o build do Netlify faz) e roteia /api/* para as Netlify Functions do repositório.
// Usado por testes/tela.test.mjs junto com os emuladores do Firebase.
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TIPOS = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript" };

/** Carrega as Functions com rota (config.path); as agendadas não têm URL. */
async function carregarFuncoes() {
  const rotas = new Map();
  for (const arquivo of await readdir("netlify/functions")) {
    const modulo = await import(pathToFileURL(resolve("netlify/functions", arquivo)).href);
    if (modulo.config?.path) rotas.set(modulo.config.path, modulo.default);
  }
  return rotas;
}

export async function iniciarServidor(porta = 0) {
  const rotas = await carregarFuncoes();
  const servidor = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const funcao = rotas.get(url.pathname);
      if (funcao) {
        const partes = [];
        for await (const p of req) partes.push(p);
        const corpo = Buffer.concat(partes);
        const resposta = await funcao(new Request(url, {
          method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : corpo,
        }));
        res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
        res.end(Buffer.from(await resposta.arrayBuffer()));
        return;
      }
      const caminho = url.pathname === "/" ? "publico/index.html"
        : url.pathname.startsWith("/dados/") ? join("dados", url.pathname.slice(7).replace(/[^a-z_.]/gi, ""))
        : null;
      if (!caminho) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TIPOS[extname(caminho)] || "application/octet-stream" });
      res.end(await readFile(caminho));
    } catch (erro) {
      res.writeHead(500); res.end(String(erro?.message || erro));
    }
  });
  await new Promise((ok) => servidor.listen(porta, "127.0.0.1", ok));
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}
