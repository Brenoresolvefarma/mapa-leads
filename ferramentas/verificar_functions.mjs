// Verifica as Netlify Functions NO AR (produção ou deploy preview).
// Uso: node ferramentas/verificar_functions.mjs https://mapaleads-rn.netlify.app
// Log público: só status HTTP e sim/não — nunca chaves, tokens ou dados.
const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base.startsWith("https://")) {
  console.error("Informe a URL do site (https://...).");
  process.exit(2);
}

const checagens = [];
async function checar(nome, caminho, opcoes, esperado, validarCorpo) {
  let status = 0;
  let ok = false;
  let detalhe = "";
  try {
    const r = await fetch(`${base}${caminho}`, opcoes);
    status = r.status;
    const texto = await r.text();
    let corpo = null;
    try { corpo = JSON.parse(texto); } catch { /* não é JSON */ }
    ok = status === esperado && (!validarCorpo || validarCorpo(corpo, texto));
    if (!ok && corpo?.erro) detalhe = ` (erro: ${String(corpo.erro).slice(0, 80)})`;
  } catch (erro) {
    detalhe = ` (${erro.name})`;
  }
  checagens.push(ok);
  console.log(`${ok ? "OK  " : "FALHOU"} ${nome}: HTTP ${status} (esperado ${esperado})${detalhe}`);
}

const post = (corpo, token) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(corpo),
});

await checar("página", "/", {}, 200, (_, t) => t.includes("MapaLeads") && t.includes("Nova busca"));
await checar("dados IBGE (build)", "/dados/microrregioes_rn.json", {}, 200,
  (c) => c?.microrregioes?.length === 19 && c?.regioes_imediatas?.length === 11);
await checar("dados municípios (build)", "/dados/municipios_rn.json", {}, 200, (c) => c?.municipios?.length === 167);
await checar("config-publica", "/api/config-publica", {}, 200,
  (c) => Boolean(c?.apiKey) && Boolean(c?.projectId) && Boolean(c?.authDomain));
await checar("criar-busca sem login", "/api/criar-busca", post({ termos: "x" }), 401);
await checar("criar-busca com token inválido", "/api/criar-busca", post({ termos: "x" }, "token-invalido"), 401);
await checar("criar-busca método errado", "/api/criar-busca", {}, 405);
await checar("cancelar-busca sem login", "/api/cancelar-busca", post({ id: "x" }), 401);
await checar("apagar-busca sem login", "/api/apagar-busca", post({ id: "x" }), 401);
await checar("liberar-busca sem login", "/api/liberar-busca", post({ id: "x", acao: "simular" }), 401);
await checar("admin-usuarios sem login", "/api/admin-usuarios", post({ acao: "listar" }), 401);
await checar("perfis sem login", "/api/perfis", post({ acao: "listar" }), 401);
await checar("saude-motor sem login", "/api/saude-motor", post({}), 401);
await checar("saude-motor com token inválido", "/api/saude-motor", post({}, "token-invalido"), 401);
await checar("admin-usuarios com token inválido", "/api/admin-usuarios", post({ acao: "listar" }, "token-invalido"), 401);

const falhas = checagens.filter((c) => !c).length;
console.log(falhas ? `${falhas} verificação(ões) falharam.` : "Todas as Functions responderam como esperado.");
process.exit(falhas ? 1 : 0);
