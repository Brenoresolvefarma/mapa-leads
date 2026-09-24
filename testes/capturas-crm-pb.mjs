// Capturas do celular (390 px) do mini-CRM, da carteira e da PB — contra os EMULADORES, com dados 100% fictícios.
// Rodar: firebase emulators:exec --only firestore,auth --project demo-mapaleads "node testes/capturas-crm-pb.mjs"
// Saída: PASTA_CAPTURAS (padrão: docs/capturas/crm-pb). O mapa de fundo (OpenStreetMap) fica em branco aqui
// (o ambiente de desenvolvimento não acessa os mosaicos); os contornos e as cores são os do IBGE.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { rotearCdn } from "./rotas-cdn.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, { FIREBASE_PROJECT_ID: "demo-mapaleads", FIREBASE_CLIENT_EMAIL: "t@demo-mapaleads.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }), FIREBASE_WEB_API_KEY: "falsa" });
delete process.env.MAPALEADS_GITHUB_TOKEN;
const { iniciarServidor } = await import("./servidor-local.mjs");
const { firebase } = await import("../netlify/lib/servidor.mjs");
const { chaveLead, fatiaDe } = await import("../netlify/lib/logica.mjs");

const PASTA = process.env.PASTA_CAPTURAS || "docs/capturas/crm-pb";
mkdirSync(PASTA, { recursive: true });
const { auth, db } = firebase();
const [a, b] = await Promise.all([
  auth.createUser({ email: "flavio@x.example", password: "senha-forte-1", displayName: "Flávio" }),
  auth.createUser({ email: "gabi@x.example", password: "senha-forte-2", displayName: "Gabi" }),
]);
const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ontem = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 86400000));
const lead = (nome, cidade, bairro, i, uf = "RN", extra = {}) => ({
  nome, categoria: "Serviço de home care", categorias: ["Serviço de home care"], telefone: `(${uf === "RN" ? 84 : 83}) 90000-00${String(i).padStart(2, "0")}`,
  whatsapp_link: `https://wa.me/55${uf === "RN" ? 84 : 83}9000000${String(i).padStart(2, "0")}`, email: "", site: "", instagram: "", endereco: "Rua Exemplo, 100",
  bairro, cidade, uf, nota: 4 + (i % 9) / 10, qtd_avaliacoes: 7 * i + 3, link_maps: "https://maps.google.com", termo_que_encontrou: "home care",
  cidade_buscada: `${cidade} ${uf}`, cidade_confere: "sim", id_lugar: `exemplo-${uf}-${i}`, ...extra });
const rn = [lead("Home Care Exemplo", "Natal", "Tirol", 1), lead("Cuidar Exemplo", "Natal", "Lagoa Nova", 2), lead("Vida Exemplo", "Natal", "Ponta Negra", 3),
  lead("Lar Exemplo", "Parnamirim", "Centro", 4), lead("Amparo Exemplo", "Mossoró", "Centro", 5)];
const pb = [lead("Paraíba Care Exemplo", "João Pessoa", "Manaíra", 1, "PB", { latitude: -7.098, longitude: -34.834 }),
  lead("Cuidado JP Exemplo", "João Pessoa", "Tambaú", 2, "PB", { latitude: -7.117, longitude: -34.823 }),
  lead("Campina Exemplo", "Campina Grande", "Centro", 3, "PB", { latitude: -7.23, longitude: -35.88 }),
  lead("Patos Exemplo", "Patos", "Centro", 4, "PB", { latitude: -7.02, longitude: -37.28 })];
const agora = Date.now();
const busca = (id, dono, leads, cidades, idade) => db.doc(`buscas/${id}`).set({ tipo: "comum", lista: true, dono_uid: dono, status: "concluida",
  criada_em: new Date(agora - idade), finalizada_em: new Date(agora - idade + 60000), qtd_lotes: 1, parametros: { termos: ["home care"], cidades }, resumo: { total: leads.length } })
  .then(() => db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono, leads }));
await busca("capA", a.uid, rn, ["Mossoró RN", "Natal RN", "Parnamirim RN"], 2000);
await busca("capPB", a.uid, pb, ["Campina Grande PB", "João Pessoa PB", "Patos PB"], 1000);
await busca("capB", b.uid, [rn[0], lead("Outro Exemplo", "Natal", "Alecrim", 9)], ["Natal RN"], 3000);
// Status já marcados pelo Flávio (como se ele tivesse usado a tela): Contatado (hoje), Negociando (atrasado), Cliente
const reg = (s, n, p, h) => ({ s, m: "", n, p, em: agora, busca: "capA", h });
const marcar = async (l, r) => {
  const k = chaveLead(l), f = fatiaDe(k);
  await db.doc(`crm/${a.uid}__${f}`).set({ dono_uid: a.uid, leads: { [k]: r } }, { merge: true });
  if (["contatado", "negociando", "cliente"].includes(r.s)) await db.doc(`carteira/${f}`).set({ leads: { [k]: { uid: a.uid, nome: "Flávio", s: r.s, desde: agora, ultimo: agora } } }, { merge: true });
};
await marcar(rn[0], reg("contatado", "ligar sexta", hoje, [{ d: agora, u: "Flávio", s: "contatado", m: "", n: "ligar sexta", p: hoje }]));
await marcar(rn[1], reg("negociando", "mandou proposta", ontem, [{ d: agora, u: "Flávio", s: "negociando", m: "", n: "mandou proposta", p: ontem },
  { d: agora - 86400000 * 2, u: "Flávio", s: "contatado", m: "", n: "", p: "" }]));
await marcar(rn[3], reg("cliente", "fechou 2 pacientes", "", [{ d: agora, u: "Flávio", s: "cliente", m: "", n: "fechou 2 pacientes", p: "" }]));

const local = await iniciarServidor();
const navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium" });
async function abrir(email, senha) {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "pt-BR", hasTouch: true, isMobile: true });
  await rotearCdn(ctx);
  await ctx.route("https://wa.me/**", (r) => r.fulfill({ body: "ok" }));
  await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("erro na página:", e.message));
  await p.goto(`${local.url}/?emulador=1`);
  await p.waitForSelector("#entrar:not([disabled])");
  await p.fill("#le", email); await p.fill("#ls", senha); await p.click("#entrar");
  await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)");
  return p;
}
async function abrirSo(p, id) {
  await p.tap("#barra-inferior a[data-ir=leads]");
  await p.tap("#abrir-buscas");
  await p.waitForSelector(`#caixa-buscas [data-abrir=${id}]`);
  await p.waitForTimeout(500); // a lista redesenha quando as buscas chegam
  await p.$$eval("#caixa-buscas [data-abrir]", (xs, alvo) => xs.forEach((x) => { x.checked = x.dataset.abrir === alvo; }), id);
  await p.tap("#aplicar-buscas");
  await p.waitForSelector("#cartoes .cartao-lead .status-lead, #cartoes .cartao-lead .na-carteira");
  await p.waitForTimeout(600);
}
const foto = async (p, nome) => { await p.screenshot({ path: `${PASTA}/${nome}.png` }); console.log(`captura: ${nome}.png`); };

const p = await abrir("flavio@x.example", "senha-forte-1");
await p.waitForFunction(() => /contato/.test(document.querySelector("#para-hoje")?.textContent || ""));
await foto(p, "01-inicio-para-hoje");
await abrirSo(p, "capA");
await p.evaluate(() => { document.querySelector("#crm-barra").scrollIntoView({ block: "start" }); scrollBy(0, -70); });
await foto(p, "02-cartoes-com-status");
await p.locator("#cartoes .cartao-lead", { hasText: "Vida Exemplo" }).locator("a.btn-whats").tap();
await p.waitForSelector("#folha-crm:not(.oculto)");
await p.fill("#folha-nota", "pediu retorno amanhã");
await foto(p, "03-como-foi");
await p.tap("[data-folha-fechar]");
await p.tap("#crm-barra [data-crm-hoje]");
await p.waitForTimeout(500);
await p.evaluate(() => { document.querySelector("#crm-barra").scrollIntoView({ block: "start" }); scrollBy(0, -70); });
await foto(p, "04-aba-para-hoje");
await p.locator("#cartoes .cartao-lead", { hasText: "Cuidar Exemplo" }).locator(".nome-lead").tap();
await p.waitForSelector("#ficha:not(.oculto) .historico li");
await foto(p, "05-ficha-historico");
await p.context().close();

const g = await abrir("gabi@x.example", "senha-forte-2");
await abrirSo(g, "capB");
await g.evaluate(() => { document.querySelector("#crm-barra").scrollIntoView({ block: "start" }); scrollBy(0, -70); });
await foto(g, "06-lead-na-carteira-de-outro");
await g.context().close();

const m = await abrir("flavio@x.example", "senha-forte-1");
await abrirSo(m, "capPB");
await m.evaluate(() => { location.hash = "#mapa/pb"; });
await m.waitForFunction(() => /Paraíba/.test(document.querySelector("#mapa-painel h2")?.textContent || ""));
await m.waitForTimeout(1200);
await foto(m, "07-mapa-pb");
await m.locator("#mapa-painel [data-ir-micro='25022']").tap();
await m.waitForFunction(() => location.hash === "#mapa/pb/joao-pessoa");
await m.waitForTimeout(1200);
await foto(m, "08-mapa-pb-microrregiao");
await m.evaluate(() => { location.hash = "#mercado"; });
await m.waitForSelector("#uf-mercado");
await m.selectOption("#uf-mercado", "PB");
await m.waitForFunction(() => /População da PB/.test(document.querySelector("#kpis-mercado")?.textContent || ""));
await m.waitForTimeout(800);
await foto(m, "09-mercado-pb");
await m.evaluate(() => document.querySelector("#mapa-mercado").scrollIntoView({ block: "start" }));
await m.waitForTimeout(400);
await foto(m, "10-mercado-pb-mapa");
await m.context().close();
await navegador.close();
local.servidor.close();
process.exit(0);
