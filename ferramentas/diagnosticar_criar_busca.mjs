// Diagnóstico do /api/criar-busca contra o Firebase de PRODUÇÃO (roda no GitHub Actions).
// Não grava buscas: usa só { simular: true }. Cria um login de teste temporário
// (uid "diagnostico-mapaleads", sem e-mail) e apaga no final.
// Log público: só status, códigos e mensagens técnicas (e-mail da conta de serviço e chave são mascarados).
//
// Uso (no workflow "Diagnosticar Functions"): precisa do secret FIREBASE_SERVICE_ACCOUNT e de
// `node testes/empacotar.mjs` rodado antes (testa o MESMO código empacotado que o Netlify usa).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = (process.argv[2] || "https://mapaleads-rn.netlify.app").replace(/\/$/, "");
const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!conta.private_key) {
  console.log("ERRO: secret FIREBASE_SERVICE_ACCOUNT ausente.");
  process.exit(1);
}
// Mesmas variáveis que o Netlify usa.
process.env.FIREBASE_PROJECT_ID = conta.project_id;
process.env.FIREBASE_CLIENT_EMAIL = conta.client_email;
process.env.FIREBASE_PRIVATE_KEY = conta.private_key.replace(/\n/g, "\\n");
delete process.env.MAPALEADS_GITHUB_TOKEN;

const mascarar = (texto) => String(texto ?? "")
  .replaceAll(conta.client_email, "<conta-de-servico>")
  .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "<chave>")
  .slice(0, 500);
const log = (...partes) => console.log(...partes.map(mascarar));

// Captura o console.error da Function (é lá que sai o erro técnico).
const erroOriginal = console.error;
console.error = (...a) => erroOriginal(...a.map((x) => mascarar(typeof x === "string" ? x : JSON.stringify(x))));

const { initializeApp, cert } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const { getFirestore } = await import("firebase-admin/firestore");
const app = initializeApp({ credential: cert(conta) }, "diagnostico");
const UID = "diagnostico-mapaleads";

let resultado = 0;
try {
  // 1) Login de teste: token customizado -> ID token (mesma API do navegador).
  const cfg = await (await fetch(`${SITE}/api/config-publica`)).json();
  log(`config-publica: apiKey=${Boolean(cfg.apiKey)} projectId_confere=${cfg.projectId === conta.project_id}`);
  const tokenCustom = await getAuth(app).createCustomToken(UID);
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${cfg.apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokenCustom, returnSecureToken: true }),
  });
  const { idToken } = await r.json();
  log(`login de teste: ${idToken ? "ok" : "falhou (HTTP " + r.status + ")"}`);

  const corpo = JSON.stringify({ termos: "diagnostico", cidades: "Natal RN", profundidade: "rapida", simular: true });

  // 2) Firestore direto (Admin SDK aqui no runner).
  try {
    const doc = await getFirestore(app).doc("config/metricas").get();
    log(`Firestore direto (runner): ok, config/metricas existe=${doc.exists}`);
  } catch (erro) {
    log(`Firestore direto (runner): ERRO code=${erro.code} msg=${erro.message}`);
    resultado = 1;
  }

  // 3) A MESMA Function empacotada, rodando aqui (Node sem require(esm), como no Netlify).
  const caminho = resolve(".netlify/teste-empacotamento/criar-busca/netlify/functions/criar-busca.mjs");
  const { default: criarBusca } = await import(pathToFileURL(caminho).href);
  const local = await criarBusca(new Request("http://localhost/api/criar-busca", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: corpo,
  }));
  log(`criar-busca empacotada (runner): HTTP ${local.status} ${await local.text()}`);
  if (local.status !== 200) resultado = 1;

  // 4) Produção de verdade (Netlify).
  const prod = await fetch(`${SITE}/api/criar-busca`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: corpo,
  });
  log(`criar-busca em produção (${SITE}): HTTP ${prod.status} ${await prod.text()}`);
  if (prod.status !== 200) resultado = 1;
} catch (erro) {
  log(`Falha no diagnóstico: ${erro.name} code=${erro.code} msg=${erro.message}`);
  resultado = 1;
} finally {
  try {
    await getAuth(app).deleteUser(UID);
    log("login de teste apagado.");
  } catch {
    log("login de teste: nada para apagar.");
  }
}
process.exit(resultado);
