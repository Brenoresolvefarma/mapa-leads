// API_LOCAL=1 (validar um PR ANTES do merge, no deploy preview): a página vem do site informado, com Firebase e
// CDNs reais, mas as chamadas /api/* são atendidas pelas Functions DESTE commit, empacotadas como no Netlify
// (node testes/empacotar.mjs) e rodando no runner com as credenciais reais. Motivo: o deploy preview não recebe
// as variáveis secretas do Netlify. /api/config-publica vem do site de produção (é pública).
// Usado por ferramentas/testar_tela_producao.mjs e ferramentas/capturar_telas.mjs.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCAO = "https://mapaleads-rn.netlify.app";

/** Carrega as Functions empacotadas com as credenciais da conta de serviço. */
export async function carregarFuncoesLocais(conta) {
  // Mesmas variáveis que o Netlify usa (a chave com "\n" literal, como colada lá).
  process.env.FIREBASE_PROJECT_ID = conta.project_id;
  process.env.FIREBASE_CLIENT_EMAIL = conta.client_email;
  process.env.FIREBASE_PRIVATE_KEY = conta.private_key.replace(/\n/g, "\\n");
  const funcoes = {};
  for (const nome of ["criar-busca", "cancelar-busca", "admin-usuarios", "perfis", "saude-motor"]) {
    const caminho = resolve(".netlify/teste-empacotamento", nome, "netlify/functions", `${nome}.mjs`);
    funcoes[`/api/${nome}`] = (await import(pathToFileURL(caminho).href)).default;
  }
  return funcoes;
}

/** Faz o contexto do navegador mandar /api/* do SITE para as Functions locais. */
export async function rotearApiLocal(ctx, site, funcoes) {
  await ctx.route(`${site}/api/**`, async (rota) => {
    const req = rota.request();
    const caminho = new URL(req.url()).pathname;
    if (caminho === "/api/config-publica") {
      const r = await fetch(`${PRODUCAO}/api/config-publica`);
      return rota.fulfill({ status: r.status, contentType: "application/json", body: await r.text() });
    }
    const fn = funcoes[caminho];
    if (!fn) return rota.fulfill({ status: 404, body: "{}" });
    const resposta = await fn(new Request(`http://local${caminho}`, {
      method: req.method(), headers: await req.allHeaders(), body: req.method() === "POST" ? req.postData() : undefined,
    }));
    return rota.fulfill({ status: resposta.status, contentType: "application/json", body: await resposta.text() });
  });
}
