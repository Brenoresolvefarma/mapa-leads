// Teste da TELA (v2) no Chromium (Playwright) contra os emuladores do Firebase + Functions locais.
// Dados 100% fictícios. Rodar: npm run test:tela   (precisa de Java e de um Chromium)
//  - NAVEGADOR: caminho do Chromium/Chrome (padrão: /opt/pw-browsers/chromium; no CI, o Chrome do runner);
//  - bibliotecas do CDN servidas do node_modules (testes/rotas-cdn.mjs), sem depender da rede;
//  - TESTAR_XLSX=1 testa o .xlsx de verdade com o SheetJS do CDN oficial (o CI tem internet);
//  - MOTOR=webkit roda no motor do Safari (no CI, só o teste de tema).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright-core";
import { medirLargura, rotearCdn } from "./rotas-cdn.mjs";
import ExcelJS from "exceljs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_PROJECT_ID = "demo-mapaleads";
process.env.FIREBASE_CLIENT_EMAIL = "teste@demo-mapaleads.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
process.env.FIREBASE_WEB_API_KEY = "chave-falsa";
delete process.env.MAPALEADS_GITHUB_TOKEN;

const { iniciarServidor } = await import("./servidor-local.mjs");
const { firebase } = await import("../netlify/lib/servidor.mjs");

const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const pasta = mkdtempSync(join(tmpdir(), "mapaleads-tela-"));
let navegador, local, erros = [];
const uids = {};

const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// Dia (Fortaleza) em que as buscas b1/b2 de exemplo terminam: 1–2 min antes do teste.
const diaDasBuscas = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 90000));
const EXTREMOZ = "2403608", NATAL = "2408102", MICRO_NATAL = "24018";
const lead = (x) => ({
  nome: "", categoria: "Clínica", telefone: "", whatsapp_link: "", email: "", site: "", instagram: "", endereco: "Rua Fictícia, 1",
  bairro: "", cidade: "", nota: null, qtd_avaliacoes: null, link_maps: "https://maps.google.com/?cid=1", termo_que_encontrou: "clínica",
  cidade_buscada: "Natal RN", cidade_confere: "sim", id_lugar: "", ...x,
});

before(async () => {
  await fetch(`http://${FS}/emulator/v1/projects/demo-mapaleads/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH}/emulator/v1/projects/demo-mapaleads/accounts`, { method: "DELETE" });
  const { auth, db } = firebase();
  const breno = await auth.createUser({ email: "breno@x.example", password: "senha-forte-1" });
  await auth.setCustomUserClaims(breno.uid, { admin: true });
  const ana = await auth.createUser({ email: "ana@x.example", password: "senha-forte-2" });
  uids.ana = ana.uid;
  const agora = Date.now();
  // Duas buscas concluídas hoje (com um lead repetido entre elas, id_lugar "p1") e uma de 10 dias atrás.
  await db.doc("buscas/b1").set({ tipo: "comum", lista: true, dono_uid: ana.uid, dono_email: "ana@x.example", status: "concluida",
    criada_em: new Date(agora - 3600000), finalizada_em: new Date(agora - 120000), parametros: { termos: ["clínica"], cidades: ["Natal RN"] }, qtd_lotes: 1,
    resumo: { total: 3, com_telefone: 2, com_email: 0, com_site: 1, com_whatsapp: 1, na_cidade_buscada: 2 } });
  await db.doc("buscas/b1/lotes/0").set({ dono_uid: ana.uid, leads: [
    lead({ nome: "Clínica Alfa", telefone: "(84) 99999-0001", whatsapp_link: "https://wa.me/5584999990001", bairro: "Tirol", cidade: "Natal", nota: 4.8, qtd_avaliacoes: 120, id_lugar: "p1", latitude: -5.79, longitude: -35.2 }),
    lead({ nome: "Clínica Beta", telefone: "(84) 3333-0002", site: "https://beta.example", bairro: "Centro", cidade: "Natal", nota: 3.9, qtd_avaliacoes: 8, id_lugar: "p2" }),
    lead({ nome: "Clínica Gama", cidade: "Parnamirim", cidade_confere: "nao", id_lugar: "p3" }),
  ] });
  await db.doc("buscas/b2").set({ tipo: "comum", lista: true, dono_uid: ana.uid, dono_email: "ana@x.example", status: "concluida",
    criada_em: new Date(agora - 1800000), finalizada_em: new Date(agora - 60000), parametros: { termos: ["clínica"], cidades: ["Extremoz RN"] }, qtd_lotes: 1,
    resumo: { total: 4, com_telefone: 2, com_email: 0, com_site: 1, com_whatsapp: 2, na_cidade_buscada: 2 } });
  await db.doc("buscas/b2/lotes/0").set({ dono_uid: ana.uid, leads: [
    lead({ nome: "Clínica Alfa", telefone: "(84) 99999-0001", whatsapp_link: "https://wa.me/5584999990001", cidade: "Natal", id_lugar: "p1", termo_que_encontrou: "consultório", cidade_buscada: "Extremoz RN", cidade_confere: "nao" }),
    lead({ nome: "Clínica Delta; & <b>", telefone: "(84) 99999-0004", whatsapp_link: "https://wa.me/5584999990004", cidade: "Extremoz", cidade_buscada: "Extremoz RN", id_lugar: "p4",
      link_maps: "https://www.google.com/maps/place/x/data=!3d-5.705!4d-35.3" }),
    // Google devolveu algo "parecido": fora do segmento (marcado, não apagado)
    lead({ nome: "Loja Exemplo Construções", categoria: "Loja de materiais de construção", site: "https://loja.example", cidade: "Extremoz", cidade_buscada: "Extremoz RN", id_lugar: "p5" }),
    // Sem cidade no endereço: escondido por padrão com "Só da cidade pedida"
    lead({ nome: "Clínica Sem Endereço", cidade: "", endereco: "", cidade_buscada: "Extremoz RN", cidade_confere: "indefinido", id_lugar: "p6" }),
  ] });
  await db.doc("buscas/b3").set({ tipo: "comum", lista: true, dono_uid: ana.uid, dono_email: "ana@x.example", status: "concluida",
    criada_em: new Date(agora - 10 * 86400000), finalizada_em: new Date(agora - 10 * 86400000 + 600000), parametros: { termos: ["clínica"], cidades: ["Natal RN"] }, qtd_lotes: 1,
    resumo: { total: 1, com_telefone: 0, com_email: 0, com_site: 0, com_whatsapp: 0, na_cidade_buscada: 1 } });
  await db.doc("buscas/b3/lotes/0").set({ dono_uid: ana.uid, leads: [lead({ nome: "Clínica Antiga", cidade: "Natal", id_lugar: "p7" })] });
  // Uma busca de outra pessoa (a Ana não pode ver).
  await db.doc("buscas/outra").set({ tipo: "comum", lista: true, dono_uid: breno.uid, status: "concluida", criada_em: new Date(agora), finalizada_em: new Date(agora),
    parametros: { termos: ["segredo"], cidades: ["Natal RN"] }, qtd_lotes: 1, resumo: { total: 1 } });
  await db.doc("buscas/outra/lotes/0").set({ dono_uid: breno.uid, leads: [lead({ nome: "Lead Do Admin", categoria: "Segredo", cidade: "Natal", termo_que_encontrou: "segredo", id_lugar: "adm" })] });
  await db.doc(`estatisticas/${hoje}__${ana.uid}`).set({ dono_uid: ana.uid, buscas: 2, leads: 7, com_whatsapp: 3, com_telefone: 4, dia: hoje });
  await db.doc(`estatisticas/${hoje}__geral`).set({ buscas: 9, leads: 50, com_whatsapp: 10, dia: hoje });
  await db.doc(`usuarios/${ana.uid}`).set({ email: "ana@x.example", nome: "Ana Souza", dia: hoje, contagem_dia: 2, limite_diario: 5 });

  local = await iniciarServidor();
  // MOTOR=webkit: mesmo teste no motor do Safari (iPhone), instalado no CI.
  navegador = process.env.MOTOR === "webkit" ? await webkit.launch() : await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium" });
});

after(async () => {
  await navegador?.close();
  local?.servidor.close();
  rmSync(pasta, { recursive: true, force: true });
});

async function abrir(email, senha, viewport = { width: 1366, height: 768 }) {
  const contexto = await navegador.newContext({ acceptDownloads: true, locale: "pt-BR", viewport, hasTouch: viewport.width < 500 });
  await rotearCdn(contexto);
  // Sem o tour do primeiro acesso (testado à parte).
  await contexto.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
  const p = await contexto.newPage();
  erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Clínicas Natal" : undefined));
  await p.goto(`${local.url}/?emulador=1`);
  await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 })
    .catch((e) => { throw new Error(`${e.message}\nErros da página: ${erros.join(" | ") || "nenhum"}`); });
  await p.fill("#le", email);
  await p.fill("#ls", senha);
  await p.click("#entrar");
  await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)");
  return p;
}
const texto = (p, s) => p.textContent(s);
async function esperarTexto(p, sel, re) {
  try { await p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), [sel, re.source], { timeout: 15000 }); }
  catch { throw new Error(`${sel} não chegou a ${re}: "${(await p.textContent(sel).catch(() => "?"))?.replace(/\s+/g, " ").slice(0, 300)}" · erros: ${erros.join(" | ")}`); }
}
const esperarHash = (p, h) => p.waitForFunction((x) => decodeURIComponent(location.hash) === x, h, { timeout: 15000 });

test("Início: cartões, barra do gráfico e busca levam ao detalhe filtrado", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2");
  // Saudação com o NOME do cadastro (não o e-mail)
  await esperarTexto(p, "#saudacao", /^Olá, Ana$/);
  // Padrão "No segmento": só do segmento e da cidade pedida (Alfa, Beta, Delta e Antiga; a loja, a Gama e a sem cidade não contam)
  await esperarTexto(p, "#kpis", /Leads da semana\s*i?3/);
  assert.match(await texto(p, "#kpis"), /Leads no segmento\s*i?4\s*de 7 coletados/);
  assert.match(await texto(p, "#kpis"), /Com WhatsApp\s*i?50%/); // 2 de 4
  assert.match(await texto(p, "#kpis"), /Cota de hoje\s*i?2\/5/);
  // Gráfico: só 2 dias com busca → mostra só esses 2 (sem 30 colunas vazias), com o valor em cima
  assert.equal(await p.locator("#grafico-dias [data-dia]").count(), 2);
  assert.match(await texto(p, "#grafico-dias-nota"), /só os dias com busca/);
  assert.equal(await p.isVisible("#selo"), false);
  assert.equal(await p.locator("#menu [data-ir=admin]").count(), 0);
  assert.equal(await p.locator("#ultimas .busca-item").count(), 3);
  assert.ok(!(await texto(p, "#ultimas")).includes("segredo"));
  // Cartão com cursor de clique e seta
  assert.equal(await p.locator("#kpis [data-detalhe=semana]").evaluate((e) => getComputedStyle(e).cursor), "pointer");
  assert.equal(await p.locator("#kpis [data-detalhe=semana] .seta").count(), 1);

  // "Leads da semana" → Meus leads só das buscas dos últimos 7 dias (b1 + b2, sem repetidos), com o mesmo número
  await p.click("#kpis [data-detalhe=semana]");
  await esperarTexto(p, "#conta", /^3 de 6 leads$/);
  assert.equal(await p.isChecked("#f-segmento"), true);
  assert.match(await texto(p, "#chips"), /Últimos 7 dias/);
  assert.match(await texto(p, "#trilha-leads"), /Início\s*›\s*Leads da semana/);
  assert.ok(!(await texto(p, "#tabela-leads")).includes("Clínica Antiga"));
  // Trilha de volta
  await p.click("#trilha-leads a");
  await esperarHash(p, "#inicio");

  // "% com WhatsApp" → todas as buscas, só com WhatsApp
  await p.click("#kpis [data-detalhe=whats]");
  await esperarTexto(p, "#conta", /^2 de 7 leads$/);
  assert.match(await texto(p, "#chips"), /Tem WhatsApp/);

  // Barra do dia em que as buscas terminaram (1–2 min antes do teste; perto da meia-noite pode ser "ontem")
  const hoje = diaDasBuscas;
  await p.click("[data-ir=inicio]");
  await p.waitForSelector(`#grafico-dias [data-dia="${hoje}"]`);
  assert.equal((await p.locator(`#grafico-dias [data-dia="${hoje}"] .valor-barra`).textContent()).trim(), "3");
  await p.click(`#grafico-dias [data-dia="${hoje}"]`);
  await esperarTexto(p, "#conta", /^3 de 6 leads$/);
  assert.match(await texto(p, "#chips"), /Dia \d\d\/\d\d/);
  // "Ver total": todos os leads, sem repetidos; o detalhe abre com os filtros desligados
  await p.click("[data-ir=inicio]");
  await p.click("#inicio-modo [data-modo=total]");
  await esperarTexto(p, "#kpis", /Leads coletados\s*i?7/);
  assert.match(await texto(p, "#kpis"), /Leads da semana\s*i?6/);
  assert.match(await texto(p, "#kpis"), /Com WhatsApp\s*i?29%/); // 2 de 7
  await p.click("#kpis [data-detalhe=semana]");
  await esperarTexto(p, "#conta", /^6 de 6 leads$/);
  assert.equal(await p.isChecked("#f-segmento"), false);
  await p.click("[data-ir=inicio]");
  await p.click("#inicio-modo [data-modo=segmento]");
  await esperarTexto(p, "#kpis", /Leads no segmento/);

  // Uma busca da lista → leads dela (filtros padrão) + trilha
  await p.click("[data-ir=inicio]");
  await p.click("#ultimas .busca-item[data-ver-busca=b1] >> text=Natal RN");
  await esperarTexto(p, "#conta", /^2 de 3 leads$/);
  assert.match(await texto(p, "#trilha-leads"), /Início\s*›\s*clínica · Natal RN/);
  // "Ver no mapa" da busca → mapa só com ela
  await p.click("[data-ir=inicio]");
  await p.click("#ultimas [data-mapa-busca=b2]");
  await esperarHash(p, "#mapa");
  await esperarTexto(p, "#mapa-painel", /Rio Grande do Norte/);
  assert.match(await texto(p, "#mapa-painel"), /1 de 167 município\(s\) pesquisado\(s\)/);
  assert.deepEqual(erros, []);
  await p.context().close();
});

test("Mapa: aprofunda RN › microrregião › município pelo painel; categoria e ficha levam ao detalhe", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2");
  await p.click("#ultimas [data-mapa-busca=b2]");
  await p.waitForSelector(`#mapa-painel [data-ir-micro="${MICRO_NATAL}"]`);
  assert.match(await texto(p, "#migalhas"), /^RN$/);
  // Barra da microrregião → mapa nela
  await p.click(`#mapa-painel [data-ir-micro="${MICRO_NATAL}"]`);
  await esperarHash(p, "#mapa/natal");
  await esperarTexto(p, "#migalhas", /RN\s*›\s*Natal/);
  assert.match(await texto(p, "#mapa-painel"), /Microrregião\s*Natal/);
  // Barra do município → mapa nele, com painel
  await p.click(`#mapa-painel [data-ir-mun="${EXTREMOZ}"]`);
  await esperarHash(p, "#mapa/natal/extremoz");
  await esperarTexto(p, "#migalhas", /RN\s*›\s*Natal\s*›\s*Extremoz/);
  assert.match(await texto(p, "#mapa-painel"), /Município\s*Extremoz/);
  assert.match(await texto(p, "#mapa-painel"), /Censo 2022/); // fonte e ano
  assert.match(await texto(p, "#mapa-legenda"), /sem busca/);
  // Esc volta um nível
  await p.keyboard.press("Escape");
  await esperarHash(p, "#mapa/natal");
  // "← Voltar" na microrregião volta ao RN inteiro (bug visto pelo Breno em "RN › Seridó Oriental")
  await p.click("#mapa-voltar");
  await esperarHash(p, "#mapa");
  await esperarTexto(p, "#migalhas", /^RN$/);
  assert.match(await texto(p, "#mapa-painel"), /Estado\s*Rio Grande do Norte/);
  // E "RN" na trilha também
  await p.click(`#mapa-painel [data-ir-micro="${MICRO_NATAL}"]`);
  await esperarHash(p, "#mapa/natal");
  await p.click("#migalhas a[href='#mapa']");
  await esperarTexto(p, "#migalhas", /^RN$/);
  await p.click(`#mapa-painel [data-ir-micro="${MICRO_NATAL}"]`);
  await esperarHash(p, "#mapa/natal");
  await p.click(`#mapa-painel [data-ir-mun="${EXTREMOZ}"]`);
  await esperarHash(p, "#mapa/natal/extremoz");
  // Categoria do painel → exatamente esses leads na tabela
  const cat = p.locator("#mapa-painel [data-categoria='Clínica']");
  const n = (await cat.locator(".num").textContent()).trim();
  await cat.click();
  await esperarHash(p, "#leads");
  await esperarTexto(p, "#conta", new RegExp(`^${n} de 4 leads$`));
  assert.match(await texto(p, "#chips"), /Categoria: Clínica/);
  assert.match(await texto(p, "#chips"), /Extremoz/);
  assert.match(await texto(p, "#trilha-leads"), /Mapa\s*›\s*Natal › Extremoz › Clínica/);
  // Ficha: a cidade leva ao mapa nela
  await p.click("#tabela-leads tbody tr >> text=Clínica Delta");
  await p.waitForSelector("#ficha:not(.oculto)");
  await p.click("#ficha a[href='#mapa/natal/extremoz']");
  await esperarHash(p, "#mapa/natal/extremoz");
  await p.waitForSelector("#ficha", { state: "hidden" });
  // Tela cheia e painel recolhível
  await p.click("#mapa-cheio-btn");
  assert.ok(await p.locator("#mapa-area.mapa-cheio").isVisible());
  await p.keyboard.press("Escape");
  assert.equal(await p.locator("#mapa-area.mapa-cheio").count(), 0);
  await p.click("#mapa-painel-btn");
  assert.equal(await p.isVisible("#mapa-painel"), false);
  await p.click("#mapa-painel-btn");
  // Abrir o mapa direto pelo link (página recarregada): redesenha quando as buscas chegam
  await p.reload();
  await esperarTexto(p, "#mapa-painel", /Município\s*Extremoz[\s\S]*1 de 1 município\(s\) pesquisado\(s\)/);
  assert.match(await texto(p, "#mapa-origem"), /Segmento: clínica/);
  assert.deepEqual(erros, []);
  await p.context().close();
});

test("Mercado: cartões, ranking e gráfico levam ao mapa/ranking; cinza = sem busca", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2");
  await p.click("#ultimas [data-mapa-busca=b2]");
  await esperarHash(p, "#mapa");
  await p.click("[data-ir=mercado]");
  await p.waitForSelector("#ranking tbody tr");
  assert.match(await texto(p, "#legenda-mercado"), /sem busca/);
  assert.match(await texto(p, "#fontes-mercado"), /IBGE/);
  // Cartão "População" → ranking por população (Natal primeiro)
  await p.click("#kpis-mercado [data-mk-kpi=pop]");
  await esperarTexto(p, "#ranking tbody tr:first-child", /Natal/);
  assert.match(await texto(p, "#ranking thead"), /População 2022 ↓/);
  // Município no mapa do Mercado → detalhe com indicadores e "sem busca"
  await p.click(`#mapa-mercado path[data-cod="${NATAL}"]`, { force: true });
  await esperarTexto(p, "#mercado-detalhe", /Natal/);
  assert.match(await texto(p, "#mercado-detalhe"), /Sem busca aqui ainda/);
  assert.match(await texto(p, "#mercado-detalhe"), /PIB per capita 2022/);
  // Cidade do ranking → mapa nela
  await p.click(`#ranking tr[data-cod="${EXTREMOZ}"]`);
  await esperarHash(p, "#mapa/natal/extremoz");
  await esperarTexto(p, "#mapa-painel", /Município\s*Extremoz/);
  // Barra do gráfico (microrregião) → mapa na microrregião
  await p.click("[data-ir=mercado]");
  await p.waitForFunction(() => window.Chart?.getChart(document.querySelector("#graf-micro"))?.data.labels.length > 0);
  await p.locator("#graf-micro").scrollIntoViewIfNeeded();
  await p.waitForTimeout(400); // animação do Chart.js
  const ponto = await p.evaluate(() => {
    const c = window.Chart.getChart(document.querySelector("#graf-micro")), b = c.getDatasetMeta(0).data[0], r = c.canvas.getBoundingClientRect();
    return { x: r.left + (b.x + b.base) / 2, y: r.top + b.y, rot: c.data.labels[0] };
  });
  assert.equal(ponto.rot, "Natal");
  await p.mouse.click(ponto.x, ponto.y);
  await esperarHash(p, "#mapa/natal");
  assert.deepEqual(erros, []);
  await p.context().close();
});

test("Nova busca (assistente) + Meus leads: sinônimos, regiões, perfil, filtros, categorias, ficha e exportação", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2");
  await p.click("[data-ir=nova]");
  // Passo 1: termos em chips e sinônimos sugeridos e editáveis
  await p.fill("#termo-input", "home care");
  await p.press("#termo-input", "Enter");
  await p.waitForSelector("#caixa-sinonimos:not(.oculto)");
  assert.ok((await texto(p, "#sinonimos")).includes("casa de repouso"));
  await p.click("#sinonimos [aria-label='Tirar casa de repouso']");
  assert.ok(!(await texto(p, "#sinonimos")).includes("casa de repouso"));
  await p.click("#sin-restaurar");
  assert.ok((await texto(p, "#sinonimos")).includes("casa de repouso"));
  await p.click("#termos-chips [aria-label='Tirar home care']");
  await p.fill("#termo-input", "clínica");
  await p.press("#termo-input", "Enter");
  assert.match(await texto(p, "#sinonimos"), /Sem sugestões/);
  // Passo 2: microrregião Natal (Extremoz, Natal, Parnamirim), desmarca Extremoz
  await p.click("[data-passo-conteudo='1'] [data-ir-passo='2']");
  await p.check(`#regioes input[data-regiao='${MICRO_NATAL}']`);
  assert.equal(await p.locator("#lista-cidades input:checked").count(), 3);
  await p.uncheck("#lista-cidades input[data-cidade='Extremoz']");
  assert.match(await texto(p, "#qtd-cidades"), /^2 de 40 cidades$/);
  assert.equal(await p.locator(`#mapa-escolha path.mun[data-cod="${NATAL}"]`).getAttribute("fill"), "var(--brand)");
  // Etiquetas de população: dentro da linha, nada flutua nem sai da caixa (bug visto pelo Breno)
  const linhasCidades = p.locator("#lista-cidades label");
  for (let i = 0; i < 5; i++) await linhasCidades.nth(i * 7).hover();
  await p.$eval("#lista-cidades", (e) => { e.scrollTop = 400; });
  await p.mouse.move(5, 5);
  const etiquetas = await p.evaluate(() => {
    const caixa = document.querySelector("#lista-cidades").getBoundingClientRect();
    const fora = [];
    for (const h of document.querySelectorAll("#lista-cidades .hab")) {
      if (getComputedStyle(h).position !== "static") fora.push("flutuando");
      const r = h.getBoundingClientRect();
      const visivel = r.bottom > caixa.top && r.top < caixa.bottom;
      if (visivel && (r.right > caixa.right + 1 || r.left < caixa.left - 1)) fora.push(h.textContent);
    }
    const balao = document.querySelector("#balao");
    return { fora, balaoVisivel: !!balao.offsetParent, total: document.querySelectorAll("#lista-cidades .hab").length };
  });
  assert.equal(etiquetas.total, 167);
  assert.deepEqual(etiquetas.fora, []);
  assert.equal(etiquetas.balaoVisivel, false);
  assert.match(await p.locator("#lista-cidades label", { hasText: "Natal" }).first().textContent(), /Natal.*751\.300 hab\./);
  await p.click("#tipo-regiao [data-tipo=imediata]");
  assert.equal(await p.locator("#regioes input").count(), 11);
  await p.click("#tipo-regiao [data-tipo=micro]");
  assert.equal(await p.locator("#regioes input").count(), 19);
  // Passo 3: profundidade e estimativa pelo servidor
  await p.click("[data-passo-conteudo='2'] [data-ir-passo='3']");
  await p.check("input[name=prof][value=rapida]");
  await esperarTexto(p, "#r-consultas", /^2$/);
  // Perfil salvo no servidor e recarregado
  await p.click("#passos [data-passo='1']");
  await p.click("#perfil-salvar");
  await p.waitForFunction(() => document.querySelector("#perfil-sel").value !== "");
  const idPerfil = await p.inputValue("#perfil-sel");
  await p.click("#termos-chips [aria-label='Tirar clínica']");
  await p.click("#passos [data-passo='1']");
  await p.selectOption("#perfil-sel", "");
  await p.selectOption("#perfil-sel", idPerfil);
  assert.match(await texto(p, "#termos-chips"), /clínica/);
  await p.click("[data-passo-conteudo='1'] [data-ir-passo='2']");
  assert.equal(await p.locator("#lista-cidades input:checked").count(), 2);
  // Buscar de verdade (emulador): cria a busca e conta no limite
  await p.click("[data-passo-conteudo='2'] [data-ir-passo='3']");
  await p.click("#buscar");
  await esperarHash(p, "#inicio");
  await esperarTexto(p, "#toasts", /Busca criada! Te aviso quando os leads chegarem.[\s\S]*ainda pode fazer 2 hoje/);
  const { db } = firebase();
  const naFila = (await db.collection("buscas").where("dono_uid", "==", uids.ana).where("status", "==", "na_fila").get()).docs.map((d) => d.data());
  const criadas = naFila.filter((b) => b.tipo === "comum");
  assert.equal(criadas.length, 1);
  assert.deepEqual(criadas[0].parametros.cidades, ["Natal RN", "Parnamirim RN"]);
  assert.deepEqual(criadas[0].parametros.sinonimos, []);
  // 2 cidades → 2 partes, uma por máquina (paralelismo)
  assert.equal(criadas[0].partes_total, 2);
  assert.deepEqual(naFila.filter((b) => b.tipo === "parte").map((b) => b.cidades).sort(), [["Natal RN"], ["Parnamirim RN"]]);

  // ---- Meus leads: juntar b1 + b2 pelo seletor de buscas
  await p.click("[data-ir=leads]");
  await p.click("#abrir-buscas");
  for (const id of ["b1", "b2"]) await p.check(`#caixa-buscas [data-abrir=${id}]`);
  await p.uncheck("#caixa-buscas [data-abrir=b3]").catch(() => {});
  await p.click("#aplicar-buscas");
  // 7 leads - 1 repetido = 6. "Só do segmento" esconde a loja; "Só da cidade pedida" esconde a Gama e a sem endereço.
  await esperarTexto(p, "#conta", /^3 de 6 leads$/);
  assert.match(await texto(p, "#segmento-info"), /Segmento: clínica.*1 lead\(s\) fora do segmento escondido\(s\) – ver/);
  const alfa = p.locator("#tabela-leads tbody tr", { hasText: "Clínica Alfa" });
  assert.match(await alfa.textContent(), /Natal/);
  assert.match(await alfa.textContent(), /Tirol/);
  assert.equal(await alfa.locator("a[aria-label=WhatsApp]").getAttribute("href"), "https://wa.me/5584999990001");
  assert.equal(await p.locator("#tabela-leads .nome-lead", { hasText: "Clínica Delta; & <b>" }).count(), 1); // HTML vira texto
  await p.uncheck("#f-pedida");
  await esperarTexto(p, "#conta", /^5 de 6 leads$/);
  await p.check("#f-pedida");
  await p.click("#abrir-filtros");
  await p.check("#gaveta-filtros [data-f=semcidade]");
  await esperarTexto(p, "#conta", /^4 de 6 leads$/);
  await p.uncheck("#gaveta-filtros [data-f=semcidade]");
  // Categorias do Google com contagem, marcar/desmarcar
  assert.deepEqual((await p.locator("#f-cat-lista label").allTextContents()).map((t) => t.trim().replace(/\s+/g, " ")), ["✓ Clínica3", "Loja de materiais de construção1"]);
  await p.uncheck("#f-cat-lista input[data-cat='Clínica']");
  await esperarTexto(p, "#conta", /^0 de 6 leads$/);
  await p.click("#gaveta-filtros [data-cats=seg]");
  await esperarTexto(p, "#conta", /^3 de 6 leads$/);
  await p.check("#gaveta-filtros [data-f=whats]");
  await esperarTexto(p, "#conta", /^2 de 6 leads$/);
  await p.uncheck("#gaveta-filtros [data-f=whats]");
  await p.check("#gaveta-filtros [data-f=semsite]");
  await esperarTexto(p, "#conta", /^2 de 6 leads$/);
  await p.uncheck("#gaveta-filtros [data-f=semsite]");
  await p.$eval("#f-nota", (e) => { e.value = "4"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await esperarTexto(p, "#conta", /^1 de 6 leads$/);
  await p.$eval("#f-nota", (e) => { e.value = "0"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.click("#gaveta-filtros [data-cats=todas]");
  await p.click("#gaveta-filtros [data-fechar]");
  await p.click("#ver-fora");
  assert.equal(await p.isChecked("#f-segmento"), false);
  await esperarTexto(p, "#conta", /^4 de 6 leads$/);
  assert.match(await p.locator("#tabela-leads tbody tr", { hasText: "Loja Exemplo" }).textContent(), /fora do segmento/);
  await p.check("#f-segmento");
  assert.deepEqual(await p.locator("#f-cidade option").allTextContents(), ["Todas as cidades", "Natal (2)", "Extremoz (1)"]);
  assert.deepEqual(await p.locator("#f-micro option").allTextContents(), ["Todas as microrregiões", "Natal (3)"]);
  // Densidade compacto/confortável
  await p.click("#densidade [data-dens=confortavel]");
  assert.ok(await p.locator("#tabela-leads.confortavel").count());
  await p.click("#densidade [data-dens=compacto]");
  // Ficha do lead
  await alfa.locator("td").nth(1).click();
  await p.waitForSelector("#ficha:not(.oculto)");
  const ficha = await texto(p, "#ficha");
  assert.match(ficha, /Microrregião\s*Natal/);
  assert.match(ficha, /Região imediata\s*Natal/);
  assert.match(ficha, /clínica, consultório|consultório, clínica/); // termos juntados
  await p.click("#ficha [data-fechar]");

  // ---- Exportar .csv com os filtros: 1 cidade -> segmento-cidade-data
  await p.selectOption("#f-cidade", "Natal");
  const [csv] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-csv")]);
  assert.equal(csv.suggestedFilename(), `clinica-natal-${hoje}.csv`);
  const conteudo = readFileSync(await csv.path(), "utf8");
  const linhas = conteudo.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(linhas.length, 3); // cabeçalho + 2 leads de Natal
  assert.ok(linhas[0].startsWith("nome;categoria;telefone;whatsapp_link;email;") && linhas[0].includes("microrregiao;regiao_imediata") && linhas[0].endsWith("cidade_confere;categorias;no_segmento"));
  assert.ok(linhas[1].endsWith(";sim"));
  assert.ok(!linhas[0].includes("id_lugar"));
  assert.ok(conteudo.includes(";4,8;")); // nota com vírgula
  await p.selectOption("#f-cidade", "");
  const [csv2] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-csv")]);
  assert.equal(csv2.suggestedFilename(), `clinica-varias-cidades-${hoje}.csv`);
  await conferirPlanilha(p);
  assert.deepEqual(erros, []);
  await p.context().close();
});

test("celular (360/390/414 px): nada passa da largura da tela, toques ≥ 44 px e cartões clicáveis", async () => {
  for (const largura of [390, 360, 414]) {
    const p = await abrir("ana@x.example", "senha-forte-2", { width: largura, height: 844 });
    await esperarTexto(p, "#kpis", /Leads da semana\s*i?3/);
    for (const pag of ["inicio", "nova", "leads", "mapa", "mercado", "sobre"]) {
      await p.evaluate((h) => { location.hash = h; }, `#${pag}`);
      await p.waitForSelector(`[data-pagina=${pag}]:not(.oculto)`);
      if (pag === "leads") await p.waitForSelector("#cartoes .cartao-lead");
      if (pag === "mapa") await p.waitForSelector("#mapa-painel h2");
      if (pag === "mercado") await p.waitForSelector("#ranking tbody tr");
      await p.waitForTimeout(300);
      const m = await medirLargura(p);
      assert.equal(m.rolagem, m.largura, `${largura}px #${pag}: página mais larga que a tela (${m.rolagem} > ${m.largura}); fora: ${m.fora.join(", ")}`);
      assert.deepEqual(m.fora, [], `${largura}px #${pag}: elementos fora da tela`);
      // Alvos de toque de no mínimo 44 px (botões, campos, alternadores, chips, barra inferior)
      const pequenos = await p.evaluate(() => [...document.querySelectorAll(".btn, select, input[type=text], input[type=search], input[type=email], .alternar, .segmentado button, .chip, .barra-inferior a, .passo")]
        .filter((e) => e.offsetParent && e.getBoundingClientRect().height > 0 && !e.closest(".oculto"))
        .filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().height)}px`));
      assert.deepEqual(pequenos, [], `${largura}px #${pag}: alvos de toque menores que 44 px`);
    }
    if (largura === 390) {
      // Tabela vira cartões; ranking vira cartões
      await p.evaluate(() => { location.hash = "#leads"; });
      assert.equal(await p.isVisible("#tabela-leads"), false);
      assert.ok(await p.locator("#cartoes .cartao-lead").count() > 0);
      // Chips de filtro numa linha que rola só por dentro
      assert.equal(await p.$eval("#chips", (e) => getComputedStyle(e).flexWrap), "nowrap");
      // Cartão do Início clicável também no celular (toque)
      await p.evaluate(() => { location.hash = "#inicio"; });
      await p.tap("#kpis [data-detalhe=whats]");
      await esperarTexto(p, "#conta", /^2 de 7 leads$/);
      await p.evaluate(() => { location.hash = "#mercado"; });
      await p.waitForSelector("#ranking tbody tr");
      assert.equal(await p.$eval("#ranking thead", (e) => getComputedStyle(e).display), "none");
      await p.tap(`#ranking tr[data-cod="${EXTREMOZ}"]`);
      await esperarHash(p, "#mapa/natal/extremoz");
      await esperarTexto(p, "#migalhas", /Extremoz/);
      assert.ok(await p.isVisible("#migalhas"));
    }
    assert.deepEqual(erros, []);
    await p.context().close();
  }
});

test("admin: Admin com saúde do motor, usuários e Estado inteiro; sair e entrar como comum na mesma aba não vaza nada", async () => {
  const p = await abrir("breno@x.example", "senha-forte-1");
  await p.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await esperarTexto(p, "#saudacao", /^Olá!$/); // sem nome no cadastro: nunca o começo do e-mail
  await p.click("#menu [data-ir=admin]");
  await esperarTexto(p, "#saude", /Últimas execuções|Token do GitHub/);
  assert.match(await texto(p, "#saude"), /Token do GitHub não configurado/);
  await p.waitForSelector("#u-tabela tr >> text=ana@x.example");
  // Nome editável no cadastro (vai para a saudação)
  await p.fill(`#u-tabela [data-nome="${uids.ana}"]`, "Aninha Teste");
  await p.press(`#u-tabela [data-nome="${uids.ana}"]`, "Tab");
  await esperarTexto(p, "#toasts", /Nome atualizado/);
  await p.fill("#rn-termos", "dentista");
  await p.click("#rn-estimar");
  await esperarTexto(p, "#msg-rn", /249 consultas/);
  // Admin no celular: nada passa da largura da tela
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  const m = await medirLargura(p);
  assert.equal(m.rolagem, m.largura, `390px #admin: ${m.fora.join(", ")}`);
  assert.deepEqual(m.fora, []);
  await p.setViewportSize({ width: 1366, height: 768 });
  // Admin vê as buscas de todos e abre a própria
  await p.click("[data-ir=inicio]");
  await esperarTexto(p, "#ultimas", /segredo/);
  await p.click("#ultimas [data-ver-busca=outra] >> text=segredo");
  await esperarTexto(p, "#tabela-leads", /Lead Do Admin/);

  // BUG DE SEGURANÇA (corrigido no PR 11): sair e entrar com usuário comum NA MESMA ABA, sem F5.
  await p.click("#avatar");
  await p.click("#sair");
  await p.waitForSelector("#tela-login:not(.oculto) #entrar:not([disabled])", { timeout: 30000 });
  await p.fill("#le", "ana@x.example"); await p.fill("#ls", "senha-forte-2"); await p.click("#entrar");
  await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)");
  await esperarTexto(p, "#cota-txt", /\d de 5/);
  assert.equal(await p.isVisible("#selo"), false, "selo admin não pode aparecer");
  assert.equal(await p.locator("#menu [data-ir=admin]").count(), 0, "menu Admin não pode aparecer");
  await p.waitForSelector("#ultimas .busca-item");
  await esperarTexto(p, "#ultimas", /Natal RN/);
  assert.ok(!(await texto(p, "body")).includes("Lead Do Admin"), "lead do admin não pode aparecer");
  assert.ok(!(await texto(p, "#ultimas")).includes("segredo"), "busca do admin não pode aparecer");
  // Admin por URL também não abre
  await p.evaluate(() => { location.hash = "#admin"; });
  await p.waitForSelector("[data-pagina=inicio]:not(.oculto)");
  assert.equal(await p.textContent("#menu-email"), "ana@x.example");
  assert.equal(await p.textContent("#saudacao"), "Olá, Aninha");
  assert.deepEqual(erros, []);
  await p.context().close();
});

test("config-publica instável: tenta de novo; se não voltar, mostra 'Tentar de novo' (nunca fica em Carregando…)", async () => {
  for (const falhas of [1, 99]) {
    const ctx = await navegador.newContext({ locale: "pt-BR" });
    await rotearCdn(ctx);
    let chamadas = 0;
    await ctx.route(`${local.url}/api/config-publica`, (rota) => (++chamadas <= falhas ? rota.fulfill({ status: 500, body: "{}" }) : rota.continue()));
    const p = await ctx.newPage();
    await p.goto(`${local.url}/?emulador=1`);
    if (falhas === 1) {
      await p.waitForSelector("#entrar:not([disabled])", { timeout: 20000 });
      assert.equal(chamadas, 2);
    } else {
      await p.waitForFunction(() => /Não foi possível conectar/.test(document.querySelector("#msg-login")?.textContent || ""), null, { timeout: 20000 });
      assert.ok(await p.isVisible("#msg-login button"));
      assert.equal(chamadas, 3);
    }
    await ctx.close();
  }
});

test("tema: abre claro mesmo com o aparelho em modo escuro; no celular o botão troca e fica salvo", async () => {
  // Aparelho em modo escuro → a tela continua clara
  const ctx = await navegador.newContext({ locale: "pt-BR", colorScheme: "dark", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await rotearCdn(ctx);
  await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
  const p = await ctx.newPage();
  erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  await p.goto(`${local.url}/?emulador=1`);
  await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
  const fundo = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g).slice(0, 3).reduce((t, v) => t + Number(v), 0));
  assert.equal(await p.evaluate(() => document.documentElement.dataset.tema), "claro");
  assert.ok(await fundo() > 600, "fundo claro com o sistema em modo escuro");
  assert.equal(await p.getAttribute('meta[name="color-scheme"]', "content"), "only light");
  await p.fill("#le", "ana@x.example"); await p.fill("#ls", "senha-forte-2"); await p.tap("#entrar");
  await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)");
  // Menu fixo embaixo: Início, Nova busca, Leads e Mapa
  await p.waitForFunction(() => document.querySelectorAll("#barra-inferior a").length === 4);
  assert.deepEqual((await p.locator("#barra-inferior a").allTextContents()).map((t) => t.trim()), ["Início", "Nova busca", "Leads", "Mapa"]);
  // Botão do topo troca o tema no celular (toque)
  await p.tap("#tema-btn");
  assert.equal(await p.evaluate(() => document.documentElement.dataset.tema), "escuro");
  await p.waitForTimeout(400); // transições de cor dos cartões
  assert.ok(await fundo() < 200, "fundo escuro depois do toque");
  const cartao = await p.$eval("#kpis .kpi", (e) => getComputedStyle(e).backgroundColor.match(/\d+/g).slice(0, 3).reduce((t, v) => t + Number(v), 0));
  assert.ok(cartao < 200, "cartões também escurecem");
  // Mapa e barra de baixo também mudam
  await p.tap("#barra-inferior a[data-ir=mapa]");
  await p.waitForSelector("#mapa-painel h2");
  assert.ok(await p.$eval(".leaflet-tile-pane", (e) => getComputedStyle(e).filter.includes("invert")), "mapa escurecido");
  assert.ok(await p.$eval("#barra-inferior", (e) => getComputedStyle(e).backgroundColor.match(/\d+/g).slice(0, 3).reduce((t, v) => t + Number(v), 0)) < 200);
  // Fica salvo depois de recarregar
  await p.reload();
  await p.waitForSelector("#tela-app:not(.oculto)");
  assert.equal(await p.evaluate(() => document.documentElement.dataset.tema), "escuro");
  assert.ok(await fundo() < 200);
  // E volta ao claro pelo mesmo botão
  await p.tap("#tema-btn");
  assert.equal(await p.evaluate(() => document.documentElement.dataset.tema), "claro");
  assert.ok(await fundo() > 600);
  // WebKit: ao recarregar, a conexão de escuta do Firestore (emulador) é cortada e o navegador registra
  // "Firestore/Listen/channel ... due to access control checks". É ruído do recarregamento, não erro da tela.
  assert.deepEqual(erros.filter((e) => !/Firestore\/Listen\/channel.*access control checks/.test(e)), []);
  await ctx.close();
});

test("celular 360/390 (vendedor): Buscar sempre visível, cartões com WhatsApp/Ligar, ficha em tela cheia com Fechar embaixo", async () => {
  for (const largura of [390, 360]) {
    const p = await abrir("ana@x.example", "senha-forte-2", { width: largura, height: 780 });
    // Nova busca: as 3 etapas sem rolagem lateral e a ação do passo sempre visível embaixo
    await p.tap("#barra-inferior a[data-ir=nova]");
    await p.fill("#termo-input", "clínica"); await p.press("#termo-input", "Enter");
    const visivelEmbaixo = (sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); const barra = document.querySelector("#barra-inferior").getBoundingClientRect(); return r.top >= 0 && r.bottom <= barra.top + 1 && r.height >= 44; });
    assert.ok(await visivelEmbaixo("[data-passo-conteudo='1'] [data-ir-passo='2']"), "Próximo visível no passo 1");
    await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
    await p.$eval(`#regioes input[data-regiao='${MICRO_NATAL}']`, (e) => e.closest("label").scrollIntoView({ block: "center", inline: "center" }));
    await p.check(`#regioes input[data-regiao='${MICRO_NATAL}']`);
    let m = await medirLargura(p); assert.equal(m.rolagem, m.largura, `passo 2: ${m.fora.join(", ")}`);
    assert.ok(await visivelEmbaixo("[data-passo-conteudo='2'] [data-ir-passo='3']"), "Próximo visível no passo 2 (sem rolar)");
    await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
    m = await medirLargura(p); assert.equal(m.rolagem, m.largura, `passo 3: ${m.fora.join(", ")}`);
    assert.ok(await visivelEmbaixo("#buscar"), "Buscar visível embaixo no passo 3");
    await p.evaluate(() => scrollTo(0, 0));
    assert.ok(await visivelEmbaixo("#buscar"), "Buscar continua visível com a página no topo");
    // Meus leads: cartões com nome, cidade e botões grandes
    await p.tap("#barra-inferior a[data-ir=leads]");
    // (abre a busca mais recente: Extremoz)
    const cartao = p.locator("#cartoes .cartao-lead", { hasText: "Clínica Delta" }).first();
    await cartao.waitFor();
    assert.match(await cartao.locator(".cidade-lead").textContent(), /Extremoz/);
    assert.equal(await cartao.locator("a.btn-whats").getAttribute("href"), "https://wa.me/5584999990004");
    assert.equal(await cartao.locator("a[href^='tel:']").getAttribute("href"), "tel:84999990004");
    assert.ok((await cartao.locator("a.btn-whats").boundingBox()).height >= 48);
    // Ficha em tela cheia, "Fechar" embaixo ao alcance do polegar
    await cartao.locator(".nome-lead").tap();
    await p.waitForSelector("#ficha:not(.oculto)");
    const f = await p.$eval("#ficha", (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, W: innerWidth, H: innerHeight }; });
    assert.equal(Math.round(f.w), f.W); assert.equal(Math.round(f.h), f.H);
    const fechar = await p.locator("#ficha .fechar-baixo").boundingBox();
    assert.ok(fechar.y > f.H / 2 && fechar.height >= 44, "Fechar na metade de baixo, com 44 px ou mais");
    await p.tap("#ficha .fechar-baixo");
    await p.waitForSelector("#ficha", { state: "hidden" });
    assert.deepEqual(erros, []);
    await p.context().close();
  }
});

// Toca em cada (i) visível da página: o texto aparece dentro da tela e some ao tocar de novo; um só aberto por vez.
async function conferirAjudas(p, onde) {
  await p.waitForTimeout(1000); // dados chegando redesenham os cartões
  const icones = p.locator("[data-ajuda]:visible");
  const n = await icones.count();
  let conferidos = 0;
  for (let i = 0; i < n; i++) {
    const b = icones.nth(i);
    if (!(await b.isVisible())) continue;
    await b.scrollIntoViewIfNeeded();
    const esperado = await b.getAttribute("data-ajuda");
    await b.tap();
    await p.waitForSelector("#balao:not(.oculto)", { timeout: 3000 }).catch(() => { throw new Error(`${onde}: (i) nº ${i} não abriu`); });
    assert.equal(await p.textContent("#balao"), esperado, `${onde}: texto do (i) nº ${i}`);
    const r = await p.$eval("#balao", (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, W: innerWidth, H: innerHeight }; });
    assert.ok(r.l >= 0 && r.r <= r.W && r.t >= 0 && r.b <= r.H, `${onde}: balão do (i) nº ${i} saiu da tela ${JSON.stringify(r)}`);
    assert.equal(await p.locator('[data-ajuda][aria-expanded="true"]').count(), 1, `${onde}: um só aberto`);
    await b.tap();
    await p.waitForSelector("#balao.oculto", { state: "attached", timeout: 3000 }).catch(() => { throw new Error(`${onde}: (i) nº ${i} não fechou no 2º toque`); });
    conferidos++;
  }
  // tocar fora também fecha
  if (conferidos) {
    await icones.first().scrollIntoViewIfNeeded(); await icones.first().tap();
    await p.waitForSelector("#balao:not(.oculto)");
    await p.tap("#titulo-pagina");
    await p.waitForSelector("#balao.oculto", { state: "attached", timeout: 3000 });
  }
  return conferidos;
}

test("ícones (i) em 390 px: cada um abre com um toque, mostra o texto dentro da tela e some ao tocar de novo", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2", { width: 390, height: 844 });
  const total = {};
  await p.waitForSelector("#kpis .kpi");
  total.inicio = await conferirAjudas(p, "Início");
  // Os dados chegam depois e o Início se redesenha com o balão aberto: o 2º toque ainda fecha.
  await p.locator("#kpis .kpi [data-ajuda]").first().tap();
  await p.waitForSelector("#balao:not(.oculto)");
  await firebase().db.doc("buscas/b1").update({ toque_teste: Date.now() });
  await p.waitForFunction(() => !document.querySelector('#kpis [aria-expanded="true"]'), null, { timeout: 5000 }); // cartões redesenhados
  assert.ok(await p.isVisible("#balao"), "balão continua aberto depois do redesenho");
  await p.locator("#kpis .kpi [data-ajuda]").first().tap();
  await p.waitForSelector("#balao.oculto", { state: "attached", timeout: 3000 });
  await p.tap("#barra-inferior a[data-ir=nova]");
  await p.fill("#termo-input", "clínica"); await p.press("#termo-input", "Enter");
  total.nova1 = await conferirAjudas(p, "Nova busca 1");
  await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
  total.nova2 = await conferirAjudas(p, "Nova busca 2");
  await p.$eval(`#regioes input[data-regiao='${MICRO_NATAL}']`, (e) => e.closest("label").scrollIntoView({ block: "center", inline: "center" }));
  await p.check(`#regioes input[data-regiao='${MICRO_NATAL}']`);
  await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  total.nova3 = await conferirAjudas(p, "Nova busca 3");
  // o (i) dentro de "Extrair e-mail" não marca a caixa
  assert.equal(await p.isChecked("#email-sn"), false);
  await p.tap("#barra-inferior a[data-ir=mapa]");
  await p.waitForSelector("#mapa-painel h2");
  total.mapa = await conferirAjudas(p, "Mapa");
  await p.evaluate(() => { location.hash = "#mercado"; });
  await p.waitForSelector("#kpis-mercado .kpi");
  total.mercado = await conferirAjudas(p, "Mercado");
  // o (i) do cartão não abre o cartão
  assert.equal(decodeURIComponent(await p.evaluate(() => location.hash)), "#mercado");
  for (const [k, v] of Object.entries(total)) assert.ok(v > 0, `${k}: nenhum (i) conferido`);
  assert.deepEqual(erros, []);
  await p.context().close();
  // Admin
  const a = await abrir("breno@x.example", "senha-forte-1", { width: 390, height: 844 });
  await a.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await a.evaluate(() => { location.hash = "#admin"; });
  await esperarTexto(a, "#saude", /Últimas execuções|Token do GitHub/);
  assert.ok(await conferirAjudas(a, "Admin") >= 5);
  assert.deepEqual(erros, []);
  await a.context().close();
  // Computador: abre ao passar o mouse (e fecha ao sair); clicado fica aberto até clicar de novo
  const d = await abrir("ana@x.example", "senha-forte-2");
  await d.waitForSelector("#kpis .kpi [data-ajuda]"); await d.waitForTimeout(1000);
  const ic = d.locator("#kpis .kpi [data-ajuda]").first();
  await ic.hover();
  await d.waitForSelector("#balao:not(.oculto)");
  await d.mouse.move(5, 400);
  await d.waitForSelector("#balao.oculto", { state: "attached" });
  await ic.click();
  await d.mouse.move(5, 400);
  await d.waitForTimeout(200);
  assert.ok(await d.isVisible("#balao"), "clicado continua aberto");
  assert.equal(await d.evaluate(() => location.hash), "", "o (i) não abre o cartão");
  await ic.click();
  await d.waitForSelector("#balao.oculto", { state: "attached" });
  assert.deepEqual(erros, []);
  await d.context().close();
});

test("apagar busca: vendedor apaga a própria em dois passos (celular); em andamento só cancela; admin apaga a de qualquer um", async () => {
  const { db } = firebase();
  await db.doc("buscas/b-fila").set({ tipo: "comum", lista: true, dono_uid: uids.ana, dono_email: "ana@x.example", status: "na_fila", criada_em: new Date(),
    parametros: { termos: ["clínica"], cidades: ["Macau RN"] } });
  const p = await abrir("ana@x.example", "senha-forte-2", { width: 390, height: 844 });
  await p.tap("#barra-inferior a[data-ir=leads]");
  await p.tap("#abrir-buscas");
  await p.waitForSelector("#caixa-buscas:not(.oculto) [data-apagar=b3]");
  // em andamento: não tem "Apagar", só "Cancelar"
  assert.equal(await p.locator("#caixa-buscas [data-apagar=b-fila]").count(), 0);
  assert.equal(await p.locator("#caixa-buscas [data-cancelar=b-fila]").count(), 1);
  const botao = p.locator("#caixa-buscas [data-apagar=b3]");
  assert.ok((await botao.boundingBox()).height >= 44, "Apagar com 44 px ou mais");
  // 1º toque: só pergunta; "Voltar" não apaga
  await botao.tap();
  await p.waitForSelector("#confirmacao:not(.oculto)");
  assert.match(await p.textContent("#conf-texto"), /^Apagar a busca .+ com 1 lead\? Isso não pode ser desfeito\.$/);
  assert.equal(await p.textContent("#conf-sim"), "Sim, apagar");
  assert.ok((await p.locator("#conf-sim").boundingBox()).height >= 44);
  await p.tap("#conf-nao");
  await p.waitForSelector("#confirmacao", { state: "hidden" });
  assert.equal((await db.doc("buscas/b3").get()).exists, true);
  // 2º passo: "Sim, apagar" apaga a busca e os leads (a lista continua aberta depois do "Voltar")
  await p.locator("#caixa-buscas [data-apagar=b3]").tap();
  await p.tap("#conf-sim");
  await esperarTexto(p, "#toasts", /Busca apagada/);
  assert.equal((await db.doc("buscas/b3").get()).exists, false);
  assert.equal((await db.collection("buscas/b3/lotes").get()).size, 0);
  await p.waitForFunction(() => !document.querySelector("#caixa-buscas [data-abrir=b3]"));
  assert.deepEqual(erros, []);
  await p.context().close();

  // Admin: lista de buscas de todos, apaga a da Ana
  const a = await abrir("breno@x.example", "senha-forte-1");
  await a.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await a.click("#menu [data-ir=admin]");
  await a.waitForSelector("#buscas-admin [data-apagar=b1]");
  assert.equal(await a.locator("#buscas-admin [data-cancelar=b-fila]").count(), 1);
  await a.click("#buscas-admin [data-apagar=b1]");
  await a.click("#conf-sim");
  await a.waitForFunction(() => !document.querySelector("#buscas-admin [data-apagar=b1]"));
  assert.equal((await db.doc("buscas/b1").get()).exists, false);
  assert.deepEqual(erros, []);
  await a.context().close();
  await db.doc("buscas/b-fila").delete();
});

test("comemoração: ao criar a busca, logos saltam por ~2 s (canvas) com a mensagem; com 'reduzir movimento' só a mensagem", async () => {
  const criar = async (p) => {
    await p.tap("#barra-inferior a[data-ir=nova]");
    await p.fill("#termo-input", "pet shop"); await p.press("#termo-input", "Enter");
    await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
    await p.$eval(`#regioes input[data-regiao='${MICRO_NATAL}']`, (e) => e.closest("label").scrollIntoView({ block: "center", inline: "center" }));
    await p.check(`#regioes input[data-regiao='${MICRO_NATAL}']`);
    await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
    await p.tap("#buscar");
  };
  const p = await abrir("ana@x.example", "senha-forte-2", { width: 390, height: 844 });
  await criar(p);
  await p.waitForSelector("#comemoracao", { state: "attached", timeout: 10000 });
  await esperarTexto(p, "#toasts", /Busca criada! Te aviso quando os leads chegarem\./);
  const c = await p.$eval("#comemoracao", (e) => ({ pe: getComputedStyle(e).pointerEvents, w: e.getBoundingClientRect().width }));
  assert.deepEqual(c, { pe: "none", w: 390 }); // não bloqueia os toques
  await p.waitForSelector("#comemoracao", { state: "detached", timeout: 4000 }); // some sozinho (~2 s)
  assert.deepEqual(erros, []);
  await p.context().close();

  // Reduzir movimento: só a mensagem
  const ctx = await navegador.newContext({ locale: "pt-BR", viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  await rotearCdn(ctx);
  await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
  const r = await ctx.newPage();
  erros = []; r.on("pageerror", (e) => erros.push(e.message));
  await r.goto(`${local.url}/?emulador=1`);
  await r.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
  await r.fill("#le", "ana@x.example"); await r.fill("#ls", "senha-forte-2"); await r.tap("#entrar");
  await r.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)");
  await criar(r);
  await esperarTexto(r, "#toasts", /Busca criada! Te aviso quando os leads chegarem\./);
  assert.equal(await r.locator("#comemoracao").count(), 0, "sem animação com reduzir movimento");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("paralelismo: busca rodando mostra 'X de Y cidades prontas' e os leads já prontos; aviso de cidades pequenas na Nova busca", async () => {
  const { db } = firebase();
  // Busca dividida em 2 partes (2 máquinas): 1 de 3 cidades pronta, com o lote parcial da parte 0.
  await db.doc("buscas/bp").set({ tipo: "comum", lista: true, dono_uid: uids.ana, dono_email: "ana@x.example", status: "rodando",
    criada_em: new Date(), iniciada_em: new Date(), parametros: { termos: ["clínica"], cidades: ["Macaíba RN", "São José de Mipibu RN", "Nísia Floresta RN"] },
    partes_total: 2, cidades_total: 3, cidades_prontas: 1, consultas_feitas: 1, total_consultas: 3, parciais: { bp_p0: 1 } });
  await db.doc("buscas/bp_p0").set({ tipo: "parte", mae_id: "bp", dono_uid: uids.ana, status: "rodando", cidades: ["Macaíba RN", "Nísia Floresta RN"], qtd_lotes: 1 });
  await db.doc("buscas/bp_p0/lotes/0").set({ dono_uid: uids.ana, leads: [
    lead({ nome: "Clínica Parcial Macaíba", telefone: "(84) 99999-0077", whatsapp_link: "https://wa.me/5584999990077", cidade: "Macaíba", cidade_buscada: "Macaíba RN", id_lugar: "par1" })] });

  const p = await abrir("ana@x.example", "senha-forte-2", { width: 390, height: 844 });
  await esperarTexto(p, "#ultimas", /1 de 3\s*cidades prontas/);
  assert.match(await texto(p, "#ultimas"), /os leads delas já estão disponíveis · 2 máquinas em paralelo/);
  assert.match(await texto(p, "#ultimas"), /Rodando \(1 de 3 cidades prontas\)/);
  await p.locator("#ultimas [data-ver-busca=bp] >> text=Ver leads já prontos").tap();
  await p.waitForSelector("#cartoes .cartao-lead >> text=Clínica Parcial Macaíba");
  // Chegou mais uma cidade: a lista de buscas mostra 2 de 3 sem recarregar
  await db.doc("buscas/bp").update({ cidades_prontas: 2 });
  await p.tap("#abrir-buscas");
  await esperarTexto(p, "#caixa-buscas", /2 de 3 cidades prontas/);
  await p.tap("#titulo-pagina"); // tocar fora fecha a lista

  // Nova busca: 1 cidade pequena (Água Nova, 2.946 hab.) entre 2 → aviso com a economia e botão para tirar
  await p.tap("#barra-inferior a[data-ir=nova]");
  await p.fill("#termo-input", "farmácia"); await p.press("#termo-input", "Enter");
  await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
  for (const nome of ["Água Nova", "Natal"]) {
    await p.fill("#busca-cidade", nome);
    await p.locator(`#lista-cidades input[data-cidade="${nome}"]`).check();
  }
  await p.fill("#busca-cidade", "");
  await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  await p.waitForSelector("#aviso-pequenas:not(.oculto)");
  assert.match(await texto(p, "#aviso-pequenas-txt"), /^1 de 2 cidades têm menos de 5 mil habitantes \(IBGE, Censo 2022\).*Tirá-las economiza \d+ consultas/);
  assert.ok((await p.locator("#remover-pequenas").boundingBox()).height >= 44);
  await p.tap("#remover-pequenas");
  await p.waitForSelector("#aviso-pequenas.oculto", { state: "attached" });
  await esperarTexto(p, "#r-resumo", /em 1 cidade\(s\)/);
  assert.equal(await p.evaluate(() => [...document.querySelectorAll("#lista-cidades input:checked")].map((i) => i.dataset.cidade).join()), "Natal");
  assert.deepEqual(erros, []);
  await p.context().close();
  for (const id of ["bp_p0/lotes/0", "bp_p0", "bp"]) await db.doc(`buscas/${id}`).delete();
});

// Campos de digitação visíveis com fonte menor que 16 px (o Safari do iPhone dá zoom ao tocar neles).
async function camposComFontePequena(p, onde) {
  return p.evaluate((onde) => {
    const vistos = [...document.querySelectorAll("input, select, textarea")].filter((e) => {
      if (["checkbox", "radio", "range", "hidden", "file", "color", "button", "submit"].includes(e.type)) return false;
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    });
    const pequenos = vistos.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16)
      .map((e) => `${onde}: ${e.id || e.getAttribute("aria-label") || e.tagName.toLowerCase()} (${getComputedStyle(e).fontSize})`);
    return { vistos: vistos.length, pequenos };
  }, onde);
}

test("iPhone (390 px): todo campo de digitação visível tem fonte de 16 px ou mais (sem zoom ao tocar), e o zoom do usuário continua liberado", async () => {
  const ctx = await navegador.newContext({ locale: "pt-BR", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await rotearCdn(ctx);
  await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
  const p = await ctx.newPage();
  erros = []; p.on("pageerror", (e) => erros.push(e.message));
  await p.goto(`${local.url}/?emulador=1`);
  await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
  // Zoom do usuário liberado: sem maximum-scale nem user-scalable=no
  const viewport = await p.getAttribute('meta[name="viewport"]', "content");
  assert.doesNotMatch(viewport, /maximum-scale|user-scalable/);
  const problemas = [], contagem = {};
  const conferir = async (onde) => { const r = await camposComFontePequena(p, onde); contagem[onde] = r.vistos; problemas.push(...r.pequenos); };
  await conferir("login");
  await p.fill("#le", "ana@x.example"); await p.fill("#ls", "senha-forte-2"); await p.tap("#entrar");
  await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)");
  // Nova busca: termos e sinônimos, depois cidades/outras cidades, depois o passo 3
  await p.tap("#barra-inferior a[data-ir=nova]");
  await p.fill("#termo-input", "clínica"); await p.press("#termo-input", "Enter");
  await conferir("nova-1");
  await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
  await conferir("nova-2");
  await p.$eval(`#regioes input[data-regiao='${MICRO_NATAL}']`, (e) => e.closest("label").scrollIntoView({ block: "center", inline: "center" }));
  await p.check(`#regioes input[data-regiao='${MICRO_NATAL}']`);
  await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  await conferir("nova-3");
  // Meus leads: busca, filtros, lista de buscas e gaveta "Mais filtros"
  await p.tap("#barra-inferior a[data-ir=leads]");
  await p.waitForSelector("#leads-painel:not(.oculto)");
  await conferir("leads");
  await p.tap("#abrir-buscas"); await conferir("leads-buscas"); await p.tap("#titulo-pagina");
  await p.tap("#abrir-filtros"); await p.waitForSelector("#gaveta-filtros:not(.oculto)"); await conferir("leads-mais-filtros");
  await p.keyboard.press("Escape");
  // Mapa (camadas) e Mercado
  await p.tap("#barra-inferior a[data-ir=mapa]"); await p.waitForSelector("#mapa-painel h2");
  await p.tap("#mapa-camadas-btn"); await conferir("mapa");
  await p.evaluate(() => { location.hash = "#mercado"; }); await p.waitForSelector("#kpis-mercado .kpi");
  await conferir("mercado");
  await ctx.close();
  // Admin (e-mail, senha, nome, limite, nomes na tabela de usuários, Estado inteiro)
  const a = await abrir("breno@x.example", "senha-forte-1", { width: 390, height: 844 });
  await a.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await a.evaluate(() => { location.hash = "#admin"; });
  await a.waitForSelector("#u-tabela [data-nome]");
  const r = await camposComFontePequena(a, "admin"); contagem.admin = r.vistos; problemas.push(...r.pequenos);
  await a.context().close();

  assert.deepEqual(problemas, [], `campos com fonte < 16 px: ${problemas.join(" | ")}`);
  // Conferiu campos de verdade em cada tela
  for (const onde of ["login", "nova-1", "nova-2", "leads", "leads-mais-filtros", "mapa", "mercado", "admin"]) assert.ok(contagem[onde] > 0, `${onde}: nenhum campo visível`);
  assert.deepEqual(erros, []);
});

// Planilha .xlsx pronta para usar (pedido do Breno, 24/09): gera pela tela e confere o arquivo de verdade.
const COLUNAS_XLSX = ["Nome", "Categoria", "Cidade", "Microrregião", "Bairro", "Endereço", "Telefone", "WhatsApp", "Site", "E-mail",
  "Nota", "Avaliações", "No segmento", "Link do Google Maps", "Busca (termo)", "Data da coleta", "Status", "Próximo contato", "Última anotação", "Vendedor"];
async function conferirPlanilha(p) {
  const visiveis = Number((await texto(p, "#conta")).match(/^([\d.]+)/)[1].replace(".", ""));
  await p.click("#baixar-xlsx");
  await p.waitForSelector("#confirmacao:not(.oculto)");
  assert.match(await texto(p, "#conf-texto"), new RegExp(`^Vão sair ${visiveis} leads? — os que os filtros da tela mostram agora`));
  const [arquivo] = await Promise.all([p.waitForEvent("download"), p.click("#conf-sim")]);
  const [a, m, d] = hoje.split("-");
  assert.equal(arquivo.suggestedFilename(), `MapaLeads_clinica_varias-cidades_${d}-${m}-${a}.xlsx`);
  const destino = join(pasta, "planilha.xlsx");
  await arquivo.saveAs(destino);
  const livro = new ExcelJS.Workbook();
  await livro.xlsx.readFile(destino);
  assert.deepEqual(livro.worksheets.map((w) => w.name), ["Leads", "Resumo"]);
  const ws = livro.getWorksheet("Leads");
  // Colunas na ordem pedida; cabeçalho negrito, branco sobre o azul da marca
  assert.deepEqual(ws.getRow(1).values.slice(1), COLUNAS_XLSX);
  const h = ws.getCell("A1");
  assert.equal(h.font.bold, true);
  assert.equal(h.font.color.argb, "FFFFFFFF");
  assert.equal(h.fill.fgColor.argb, "FF1F5FD6");
  // Cabeçalho travado e filtro automático em todas as colunas
  assert.equal(ws.views[0].state, "frozen");
  assert.equal(ws.views[0].ySplit, 1);
  assert.equal(ws.autoFilter, `A1:T${visiveis + 1}`);
  // Nome interno do filtro (o Excel grava; sem ele o LibreOffice não mostra as setas)
  assert.match(execFileSync("unzip", ["-p", destino, "xl/workbook.xml"], { encoding: "utf8" }),
    new RegExp(`<definedName name="_xlnm._FilterDatabase" localSheetId="0">&apos;Leads&apos;!\\$A\\$1:\\$T\\$${visiveis + 1}</definedName>`));
  // Uma linha por lead (os mesmos da tela), sem duplicados, ordenadas por Cidade e depois Nome
  const linhas = [];
  for (let r = 2; r <= ws.rowCount; r++) linhas.push(ws.getRow(r));
  assert.equal(linhas.length, visiveis);
  const chave = (r) => [String(r.getCell(3).value || "\uffff"), String(r.getCell(1).value)];
  const ordenadas = [...linhas].sort((x, y) => chave(x)[0].localeCompare(chave(y)[0], "pt-BR") || chave(x)[1].localeCompare(chave(y)[1], "pt-BR"));
  assert.deepEqual(linhas.map((r) => r.getCell(1).value), ordenadas.map((r) => r.getCell(1).value));
  assert.equal(new Set(linhas.map((r) => `${r.getCell(1).value}|${r.getCell(7).value}`)).size, linhas.length);
  // Links curtos e clicáveis; telefone padronizado; WhatsApp só para celular
  const alfa = linhas.find((r) => r.getCell(1).value === "Clínica Alfa");
  assert.equal(alfa.getCell(7).value, "(84) 99999-0001");
  assert.deepEqual(alfa.getCell(8).value, { text: "Abrir WhatsApp", hyperlink: "https://wa.me/5584999990001" });
  assert.equal(alfa.getCell(14).value.text, "Ver no mapa");
  assert.match(alfa.getCell(14).value.hyperlink, /^https:\/\/maps\.google\.com/);
  assert.equal(alfa.getCell(11).value, 4.8);
  assert.equal(ws.getColumn(11).numFmt, "0.0");
  assert.equal(alfa.getCell(12).value, 120);
  assert.ok(alfa.getCell(16).value instanceof Date);
  assert.equal(ws.getColumn(16).numFmt, "dd/mm/yyyy");
  assert.equal(alfa.getCell(13).value, "Sim");
  const beta = linhas.find((r) => r.getCell(1).value === "Clínica Beta");
  if (beta) {
    assert.equal(beta.getCell(7).value, "(84) 3333-0002");
    assert.ok(!beta.getCell(8).value, "fixo não tem WhatsApp");
    assert.deepEqual(beta.getCell(9).value, { text: "Abrir site", hyperlink: "https://beta.example" });
  }
  // Nada técnico: sem id do lugar, coordenadas ou place_id; larguras com limite
  const tudo = linhas.flatMap((r) => r.values.map((v) => JSON.stringify(v ?? ""))).join(" ");
  assert.ok(!/"p\d"|-5\.79|place_id|id_lugar/.test(tudo));
  assert.ok(ws.getColumn(6).width <= 45);
  // Aba Resumo: termo, data, totais e tabela por cidade
  const rs = livro.getWorksheet("Resumo");
  const valores = [];
  rs.eachRow((r) => valores.push(r.values.slice(1)));
  assert.deepEqual(valores[0], ["Termo buscado", "clínica"]);
  assert.deepEqual(valores[1], ["Data", `${d}/${m}/${a}`]);
  assert.deepEqual(valores[2], ["Total de leads", visiveis]);
  assert.equal(valores[3][0], "No segmento");
  assert.equal(valores[4][0], "Com WhatsApp");
  const cab = valores.findIndex((v) => v[0] === "Cidade");
  assert.deepEqual(valores[cab], ["Cidade", "Leads", "No segmento", "Com WhatsApp"]);
  const soma = valores.slice(cab + 1).filter((v) => typeof v[1] === "number").reduce((t, v) => t + v[1], 0);
  assert.equal(soma, visiveis);
  return destino;
}

test("limite do vendedor (390 px): sem 'Selecionar todas' no estado, contador 'X de 40 cidades' fica vermelho e o Buscar trava; admin sem limite", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2", { width: 390, height: 844 });
  await p.tap("#barra-inferior a[data-ir=nova]");
  await p.fill("#termo-input", "farmácia"); await p.press("#termo-input", "Enter");
  await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
  // "Selecionar todas" some no estado inteiro; com a procura filtrando, volta
  assert.equal(await p.isVisible("#marcar-filtradas"), false);
  await p.fill("#busca-cidade", "São"); assert.equal(await p.isVisible("#marcar-filtradas"), true);
  await p.fill("#busca-cidade", "");
  await esperarTexto(p, "#qtd-cidades", /^0 de 40 cidades$/);
  // Marca regiões até passar de 40 cidades
  const regioes = p.locator("#regioes input[data-regiao]");
  for (let i = 0; i < await regioes.count(); i++) {
    await regioes.nth(i).evaluate((e) => e.closest("label").scrollIntoView({ block: "center", inline: "center" }));
    await regioes.nth(i).check();
    if (Number((await texto(p, "#qtd-cidades")).split(" ")[0]) > 40) break;
  }
  const marcadas = Number((await texto(p, "#qtd-cidades")).split(" ")[0]);
  assert.ok(marcadas > 40);
  assert.match(await texto(p, "#qtd-cidades"), new RegExp(`^${marcadas} de 40 cidades$`));
  assert.ok(await p.$eval("#qtd-cidades", (e) => e.classList.contains("passou-limite")));
  const vermelho = await p.$eval("#qtd-cidades", (e) => getComputedStyle(e).color.match(/\d+/g).map(Number));
  assert.ok(vermelho[0] > 150 && vermelho[1] < 100, `cor ${vermelho}`);
  // Passo 3: Buscar travado, com a mensagem
  await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  assert.equal(await p.isDisabled("#buscar"), true);
  await p.waitForSelector("#aviso-limite:not(.oculto)");
  assert.match(await texto(p, "#aviso-limite"), new RegExp(`^Busca grande demais para vendedor \\(${marcadas} cidades / ${marcadas} consultas\\)\\. Máximo: 40 cidades ou 120 consultas\\.`));
  // Voltando para até 40, destrava
  await p.tap("[data-passo-conteudo='3'] [data-ir-passo='2']");
  await p.tap("#limpar-cidades");
  await p.$eval(`#regioes input[data-regiao='${MICRO_NATAL}']`, (e) => e.closest("label").scrollIntoView({ block: "center", inline: "center" }));
  await p.check(`#regioes input[data-regiao='${MICRO_NATAL}']`);
  assert.ok(!(await p.$eval("#qtd-cidades", (e) => e.classList.contains("passou-limite"))));
  await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  assert.equal(await p.isDisabled("#buscar"), false);
  assert.equal(await p.isVisible("#aviso-limite"), false);
  assert.deepEqual(erros, []);
  await p.context().close();

  // Admin: "Selecionar todas" visível, sem contador de limite
  const a = await abrir("breno@x.example", "senha-forte-1", { width: 390, height: 844 });
  await a.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await a.tap("#barra-inferior a[data-ir=nova]");
  await a.fill("#termo-input", "farmácia"); await a.press("#termo-input", "Enter");
  await a.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
  assert.equal(await a.isVisible("#marcar-filtradas"), true);
  await a.tap("#marcar-filtradas");
  await esperarTexto(a, "#qtd-cidades", /^167 cidades marcada\(s\)$/);
  await a.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  assert.equal(await a.isDisabled("#buscar"), false);
  // Admin › Configurações mostra os números valendo
  await a.evaluate(() => { location.hash = "#admin"; });
  await a.waitForFunction(() => document.querySelector("#cfg-cidades")?.value === "40");
  assert.equal(await a.inputValue("#cfg-consultas"), "120");
  assert.equal(await a.inputValue("#cfg-consultas-dia"), "300");
  assert.deepEqual(erros, []);
  await a.context().close();
});

test("liberar busca (390 px): admin libera dividindo sem repetir; vendedor vê 'Liberada por admin' sem Apagar; revogar tira na hora", async () => {
  const { auth, db } = firebase();
  const lia = await auth.createUser({ email: "lia@x.example", password: "senha-forte-l", displayName: "Lia" });
  const rui = await auth.createUser({ email: "rui@x.example", password: "senha-forte-r", displayName: "Rui" });
  const breno = await auth.getUserByEmail("breno@x.example");
  // Lista do admin: 3 leads em Natal, 2 em Mossoró e 1 em Caicó.
  await db.doc("buscas/lib").set({ tipo: "comum", lista: true, dono_uid: breno.uid, dono_email: "breno@x.example", status: "concluida",
    criada_em: new Date(Date.now() - 5000), finalizada_em: new Date(), parametros: { termos: ["clínica"], cidades: ["Natal RN", "Mossoró RN", "Caicó RN"] }, qtd_lotes: 1,
    resumo: { total: 6 } });
  await db.doc("buscas/lib/lotes/0").set({ dono_uid: breno.uid, leads: [
    lead({ nome: "Lib Natal 1", cidade: "Natal", id_lugar: "q1", telefone: "(84) 99999-1001", whatsapp_link: "https://wa.me/5584999991001" }),
    lead({ nome: "Lib Natal 2", cidade: "Natal", id_lugar: "q2" }), lead({ nome: "Lib Natal 3", cidade: "Natal", id_lugar: "q3" }),
    lead({ nome: "Lib Mossoró 1", cidade: "Mossoró", cidade_buscada: "Mossoró RN", id_lugar: "q4" }), lead({ nome: "Lib Mossoró 2", cidade: "Mossoró", cidade_buscada: "Mossoró RN", id_lugar: "q5" }),
    lead({ nome: "Lib Caicó 1", cidade: "Caicó", cidade_buscada: "Caicó RN", id_lugar: "q6" }),
  ] });
  const tel = { width: 390, height: 844 };

  // ---- Admin (celular): Meus leads › Liberar para vendedor › Lia + Rui, dividir
  const a = await abrir("breno@x.example", "senha-forte-1", tel);
  await a.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await a.tap("#barra-inferior a[data-ir=leads]");
  await a.tap("#abrir-buscas");
  await a.locator("#caixa-buscas [data-liberar=lib]").tap();
  await a.waitForSelector(`#painel-liberar:not(.oculto) [data-lib-vend="${lia.uid}"]`);
  // O dono (admin) não aparece como vendedor; a Ana, a Lia e o Rui sim.
  assert.equal(await a.locator(`[data-lib-vend="${breno.uid}"]`).count(), 0);
  assert.equal(await a.locator(`[data-lib-vend="${uids.ana}"]`).count(), 1);
  assert.equal(await a.locator("#lib-confirmar").isDisabled(), true);
  await a.locator(`[data-lib-vend="${lia.uid}"]`).check();
  await a.locator(`[data-lib-vend="${rui.uid}"]`).check();
  await a.locator("#lib-dividir").check();
  // Prévia antes de confirmar: quantos leads cada um recebe (3 + 3, cidades diferentes).
  await esperarTexto(a, "#lib-previa", /Lia: 3 leads · 1 cidade/);
  assert.match(await a.textContent("#lib-previa"), /Rui: 3 leads · 2 cidade/);
  let m = await medirLargura(a); assert.equal(m.rolagem, m.largura, `painel: ${m.fora.join(", ")}`);
  const conf = a.locator("#lib-confirmar");
  assert.ok((await conf.boundingBox()).height >= 44);
  // "Só estas cidades/regiões": regiões e cidades com contagem (prévia muda; volta para a lista inteira depois)
  await a.locator("input[name=lib-modo][value=cidades]").check();
  await a.waitForSelector("#lib-cidades [data-lib-cidade='Mossoró']");
  await esperarTexto(a, "#lib-previa", /Marque pelo menos uma cidade/);
  await a.locator("#lib-cidades [data-lib-cidade='Mossoró']").check();
  await a.locator("#lib-cidades [data-lib-cidade='Caicó']").check();
  await esperarTexto(a, "#lib-previa", /Lia: 2 leads · 1 cidade/);
  m = await medirLargura(a); assert.equal(m.rolagem, m.largura, `painel (cidades): ${m.fora.join(", ")}`);
  await a.locator("input[name=lib-modo][value=inteira]").check();
  await esperarTexto(a, "#lib-previa", /Lia: 3 leads · 1 cidade/);
  await conf.tap();
  await esperarTexto(a, "#toasts", /liberada para 2 vendedor/);
  let b = (await db.doc("buscas/lib").get()).data();
  assert.deepEqual([...b.liberada_para].sort(), [lia.uid, rui.uid].sort());
  const copia = async (uid) => (await db.doc(`buscas/lib/liberacoes/${uid}/lotes/0`).get()).data().leads.map((l) => l.id_lugar);
  const [il, ir] = [await copia(lia.uid), await copia(rui.uid)];
  assert.deepEqual([...il, ...ir].sort(), ["q1", "q2", "q3", "q4", "q5", "q6"]); // todos, nenhum repetido
  // Lista inteira para a Ana também.
  await a.tap("#abrir-buscas");
  await a.locator("#caixa-buscas [data-liberar=lib]").tap();
  await a.locator(`[data-lib-vend="${uids.ana}"]`).check();
  await esperarTexto(a, "#lib-previa", /: 6 leads · lista inteira/);
  await a.locator("#lib-confirmar").tap();
  await esperarTexto(a, "#toasts", /liberada para 1 vendedor/);
  // Chips "Liberada para" com revogar
  await a.tap("#abrir-buscas");
  await a.waitForSelector(`#caixa-buscas [data-revogar=lib][data-uid="${lia.uid}"]`);
  await a.keyboard.press("Escape");
  assert.deepEqual(erros, []);

  // ---- Lia (celular): vê a lista com a etiqueta, só os leads das cidades dela, sem Apagar/Liberar
  const l = await abrir("lia@x.example", "senha-forte-l", tel);
  await l.tap("#barra-inferior a[data-ir=leads]");
  await l.tap("#abrir-buscas");
  const linha = l.locator("#caixa-buscas .linha-busca[data-busca=lib]");
  await linha.waitFor();
  assert.match(await linha.textContent(), /Liberada por admin/);
  assert.match(await linha.textContent(), /3 leads/);
  assert.equal(await linha.locator("[data-apagar], [data-liberar], [data-cancelar]").count(), 0);
  await linha.locator("[data-abrir=lib]").check();
  await l.tap("#aplicar-buscas");
  await l.locator("#cartoes .cartao-lead", { hasText: "Lib Natal 1" }).waitFor();
  const nomes = await l.$$eval("#cartoes .cartao-lead .nome-lead", (xs) => xs.map((x) => x.textContent.trim()));
  assert.deepEqual(nomes.filter((n) => n.startsWith("Lib")).sort(), ["Lib Natal 1", "Lib Natal 2", "Lib Natal 3"]);
  const cartao = l.locator("#cartoes .cartao-lead", { hasText: "Lib Natal 1" });
  assert.equal(await cartao.locator("a.btn-whats").getAttribute("href"), "https://wa.me/5584999991001");
  assert.equal(await cartao.locator("a[href^='tel:']").getAttribute("href"), "tel:84999991001");
  m = await medirLargura(l); assert.equal(m.rolagem, m.largura, `Meus leads (liberada): ${m.fora.join(", ")}`);
  // Não conta na cota: o documento de uso da Lia nem existe.
  assert.equal((await db.doc(`usuarios/${lia.uid}`).get()).exists, false);

  // ---- Admin revoga a Lia (no Admin); a lista some da tela dela na hora
  await a.evaluate(() => { location.hash = "#admin"; });
  const rev = a.locator(`#buscas-admin [data-revogar=lib][data-uid="${lia.uid}"]`);
  await rev.waitFor();
  m = await medirLargura(a); assert.equal(m.rolagem, m.largura, `Admin: ${m.fora.join(", ")}`);
  assert.ok((await rev.boundingBox()).height >= 28);
  await rev.tap();
  await a.waitForSelector("#confirmacao:not(.oculto)");
  assert.match(await a.textContent("#conf-texto"), /Tirar esta lista de Lia\?/);
  await a.tap("#conf-sim");
  await esperarTexto(a, "#toasts", /Liberação revogada/);
  b = (await db.doc("buscas/lib").get()).data();
  assert.ok(!b.liberada_para.includes(lia.uid));
  assert.equal((await db.doc(`buscas/lib/liberacoes/${lia.uid}/lotes/0`).get()).exists, false);
  await l.waitForFunction(() => !document.querySelector("#caixa-buscas [data-busca=lib]"), null, { timeout: 15000 });
  await l.waitForFunction(() => ![...document.querySelectorAll("#cartoes .cartao-lead .nome-lead")].some((e) => e.offsetParent && e.textContent.startsWith("Lib")), null, { timeout: 15000 })
    .catch(async (e) => { throw new Error(`${e.message} — ${await l.evaluate(() => document.querySelector("#leads-painel")?.innerText.slice(0, 300))}`); });
  assert.deepEqual(erros, []);
  await l.context().close();
  await a.context().close();

  // Ana (lista inteira) continua vendo os 6.
  const n = await abrir("ana@x.example", "senha-forte-2", tel);
  await n.tap("#barra-inferior a[data-ir=leads]");
  await n.tap("#abrir-buscas");
  const la = n.locator("#caixa-buscas .linha-busca[data-busca=lib]");
  await la.waitFor();
  assert.match(await la.textContent(), /Liberada por admin[\s\S]*6 leads/);
  await n.context().close();
  // Limpeza: a busca de teste sai (para não mexer nos outros testes).
  await db.doc("buscas/lib/lotes/0").delete();
  for (const uid of [rui.uid]) await db.doc(`buscas/lib/liberacoes/${uid}/lotes/0`).delete();
  await db.doc("buscas/lib").delete();
});

test("mini-CRM e carteira (390 px): status em um toque, 'Como foi?', histórico, Para hoje; B vê 'Na carteira de A' sem botões; prazo; admin transfere; exportação", async () => {
  const { auth, db } = firebase();
  const beto = await auth.createUser({ email: "beto@x.example", password: "senha-forte-b", displayName: "Beto" });
  const breno = await auth.getUserByEmail("breno@x.example");
  const agora = Date.now();
  const alfa = lead({ nome: "CRM Alfa", cidade: "Natal", id_lugar: "cr1", telefone: "(84) 99999-2001", whatsapp_link: "https://wa.me/5584999992001" });
  const beta = lead({ nome: "CRM Beta", cidade: "Natal", id_lugar: "cr2", telefone: "(84) 99999-2002", whatsapp_link: "https://wa.me/5584999992002" });
  for (const [id, dono, leads, idade] of [["crmA", uids.ana, [alfa, beta], 1000], ["crmB", beto.uid, [alfa], 2000]]) {
    await db.doc(`buscas/${id}`).set({ tipo: "comum", lista: true, dono_uid: dono, status: "concluida", criada_em: new Date(agora - idade), finalizada_em: new Date(agora - idade),
      parametros: { termos: ["clínica"], cidades: ["Natal RN"] }, qtd_lotes: 1, resumo: { total: leads.length } });
    await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono, leads });
  }
  const tel = { width: 390, height: 844 };
  const abrirSo = async (p, id) => {
    await p.tap("#barra-inferior a[data-ir=leads]");
    await p.tap("#abrir-buscas");
    await p.waitForSelector(`#caixa-buscas [data-abrir=${id}]`);
    for (const c of await p.$$("#caixa-buscas [data-abrir]:checked")) await c.uncheck();
    await p.check(`#caixa-buscas [data-abrir=${id}]`);
    await p.tap("#aplicar-buscas");
  };
  const cartaoDe = (p, nome) => p.locator("#cartoes .cartao-lead", { hasText: nome }).first();

  // ---- Ana (vendedora A): Contatado em um toque
  const a = await abrir("ana@x.example", "senha-forte-2", tel);
  await a.context().route("https://wa.me/**", (r) => r.fulfill({ body: "ok" }));
  await abrirSo(a, "crmA");
  let c = cartaoDe(a, "CRM Alfa");
  await c.waitFor();
  const botoes = c.locator(".status-lead button");
  assert.deepEqual(await botoes.allTextContents(), ["Novo", "Contatado", "Negociando", "Cliente", "Descartado"]);
  for (const b of await botoes.all()) assert.ok((await b.boundingBox()).height >= 44, "status com 44 px ou mais");
  await c.locator("[data-status=contatado]").tap();
  await esperarTexto(a, "#toasts", /Contatado — salvo/);
  await a.waitForFunction(() => document.querySelector("#cartoes .cartao-lead [data-status=contatado][aria-pressed=true]"));
  const { fatiaDe } = await import("../netlify/lib/logica.mjs");
  const refCrm = db.doc(`crm/${uids.ana}__${fatiaDe("p_cr1")}`);
  assert.equal((await refCrm.get()).data().leads.p_cr1.s, "contatado");
  // WhatsApp → "Como foi?" com os status em botões; anotação + próximo contato (hoje) → Negociando
  c = cartaoDe(a, "CRM Alfa");
  await c.locator("a.btn-whats").tap();
  await a.waitForSelector("#folha-crm:not(.oculto)");
  assert.match(await a.textContent("#folha-titulo"), /Como foi\?/);
  assert.deepEqual(await a.locator("#folha-crm [data-folha-status]").allTextContents(), ["Contatado", "Negociando", "Cliente", "Descartado"]);
  let m = await medirLargura(a); assert.equal(m.rolagem, m.largura, `Como foi?: ${m.fora.join(", ")}`);
  await a.fill("#folha-nota", "ligar sexta");
  await a.fill("#folha-proximo", hoje);
  await a.locator("#folha-crm [data-folha-status=negociando]").tap();
  await esperarTexto(a, "#toasts", /Negociando — salvo/);
  const reg = (await refCrm.get()).data().leads.p_cr1;
  assert.deepEqual([reg.s, reg.n, reg.p], ["negociando", "ligar sexta", hoje]);
  assert.deepEqual(reg.h.map((h) => h.s), ["negociando", "contatado"]);
  // Descartado pede o motivo (CRM Beta)
  await cartaoDe(a, "CRM Beta").locator("[data-status=descartado]").tap();
  await a.waitForSelector("#folha-crm:not(.oculto) [data-motivo=numero_errado]");
  await a.locator("#folha-crm [data-motivo=numero_errado]").tap();
  await esperarTexto(a, "#toasts", /Descartado · Número errado — salvo/);
  // Contador por status + aba "Para hoje" (só o Alfa: próximo contato hoje)
  await a.waitForFunction(() => /Negociando\s*1/.test(document.querySelector("#crm-barra").textContent) && /Descartado\s*1/.test(document.querySelector("#crm-barra").textContent));
  await a.tap("#crm-barra [data-crm-hoje]");
  await a.waitForFunction(() => [...document.querySelectorAll("#cartoes .cartao-lead .nome-lead")].map((e) => e.textContent.trim()).join("|") === "CRM Alfa");
  assert.match(await cartaoDe(a, "CRM Alfa").textContent(), /Próximo: \d\d\/\d\d\/\d{4}.*ligar sexta/);
  m = await medirLargura(a); assert.equal(m.rolagem, m.largura, `Para hoje: ${m.fora.join(", ")}`);
  // Ficha: histórico "dd/mm · nome · status · anotação"
  await cartaoDe(a, "CRM Alfa").locator(".nome-lead").tap();
  await a.waitForSelector("#ficha:not(.oculto) .historico li");
  assert.match(await a.textContent("#ficha .historico li"), /^\d\d\/\d\d · .+ · Negociando · ligar sexta · próximo \d\d\/\d\d\/\d{4}$/);
  await a.tap("#ficha .fechar-baixo");
  // Início: "Para hoje: 1 contato" abre a lista
  await a.tap("#barra-inferior a[data-ir=inicio]");
  await esperarTexto(a, "#para-hoje", /1 contato/);
  await a.tap("#para-hoje");
  await a.waitForFunction(() => location.hash === "#leads" && /Para hoje/.test(document.querySelector("#chips").textContent));
  // Exportação com as colunas do CRM
  await a.evaluate(() => { document.querySelector("#baixar-xlsx").scrollIntoView(); });
  await a.click("#baixar-xlsx");
  await a.waitForSelector("#confirmacao:not(.oculto)");
  const [arquivo] = await Promise.all([a.waitForEvent("download"), a.click("#conf-sim")]);
  const destino = join(pasta, "crm.xlsx"); await arquivo.saveAs(destino);
  const livro = new ExcelJS.Workbook(); await livro.xlsx.readFile(destino);
  const ws = livro.getWorksheet("Leads");
  assert.deepEqual(ws.getRow(1).values.slice(17), ["Status", "Próximo contato", "Última anotação", "Vendedor"]);
  const linha = ws.getRow(2);
  assert.equal(linha.getCell(1).value, "CRM Alfa");
  assert.equal(linha.getCell(17).value, "Negociando");
  assert.ok(linha.getCell(18).value instanceof Date);
  assert.equal(linha.getCell(19).value, "ligar sexta");
  assert.ok(String(linha.getCell(20).value).length > 0);
  assert.deepEqual(erros, []);

  // ---- Beto (vendedor B): o mesmo lugar numa busca dele → "Na carteira de <Ana>", sem WhatsApp/Ligar/status, fora do Para hoje
  const b = await abrir("beto@x.example", "senha-forte-b", tel);
  await abrirSo(b, "crmB");
  const cb = cartaoDe(b, "CRM Alfa");
  await cb.waitFor();
  await b.waitForFunction(() => /Na carteira de/.test(document.querySelector("#cartoes .cartao-lead")?.textContent || ""));
  const nomeDaAna = (await db.doc(`carteira/${fatiaDe("p_cr1")}`).get()).data().leads.p_cr1.nome;
  assert.match(await cb.textContent(), new RegExp(`Na carteira de ${nomeDaAna}`));
  assert.equal(await cb.locator("a.btn-whats, a[href^='tel:'], .status-lead").count(), 0);
  assert.match(await b.textContent("#crm-barra [data-crm-hoje]"), /Para hoje\s*0/);
  await b.context().close();
  // Prazo: sem contato há 61 dias (padrão 60) → volta a ficar livre para o Beto
  const refCart = db.doc(`carteira/${fatiaDe("p_cr1")}`);
  await refCart.set({ leads: { p_cr1: { ultimo: agora - 61 * 86400000 } } }, { merge: true });
  const b2 = await abrir("beto@x.example", "senha-forte-b", tel);
  await abrirSo(b2, "crmB");
  await b2.waitForSelector("#cartoes .cartao-lead .status-lead [data-status=contatado]");
  assert.equal(await cartaoDe(b2, "CRM Alfa").locator("a.btn-whats").count(), 1);
  await b2.context().close();
  await a.context().close();

  // ---- Admin transfere o lead para o Beto (ficha) e vê o painel Carteiras
  await refCart.set({ leads: { p_cr1: { ultimo: agora } } }, { merge: true });
  const ad = await abrir("breno@x.example", "senha-forte-1", tel);
  await ad.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await abrirSo(ad, "crmA");
  await cartaoDe(ad, "CRM Alfa").locator(".nome-lead").tap();
  await ad.waitForSelector(`#transferir-para option[value="${beto.uid}"]`, { state: "attached" });
  await ad.selectOption("#transferir-para", beto.uid);
  await ad.tap("#transferir-btn");
  await ad.tap("#conf-sim");
  await esperarTexto(ad, "#toasts", /transferido para Beto/);
  assert.equal((await refCart.get()).data().leads.p_cr1.uid, beto.uid);
  await ad.evaluate(() => { location.hash = "#admin"; });
  await ad.waitForSelector(`#carteiras-tabela [data-carteira-uid="${beto.uid}"]`);
  assert.match(await ad.textContent(`#carteiras-tabela [data-carteira-uid="${beto.uid}"]`), /Beto/);
  m = await medirLargura(ad); assert.equal(m.rolagem, m.largura, `Admin (carteiras): ${m.fora.join(", ")}`);
  assert.deepEqual(erros, []);
  await ad.context().close();
  for (const id of ["crmA", "crmB"]) { await db.doc(`buscas/${id}/lotes/0`).delete(); await db.doc(`buscas/${id}`).delete(); }
  void breno;
});

test("PB (390 px): Nova busca na Paraíba manda as cidades com 'PB'; Mapa PB com aprofundamento até os leads; Mercado PB; Estado inteiro PB estima", async () => {
  const { db } = firebase();
  const breno = (await firebase().auth.getUserByEmail("breno@x.example")).uid;
  // Uma busca fictícia em João Pessoa (PB) com um lead
  await db.doc("buscas/pbA").set({ tipo: "comum", lista: true, dono_uid: uids.ana, status: "concluida", criada_em: new Date(), finalizada_em: new Date(),
    parametros: { termos: ["clínica"], cidades: ["João Pessoa PB"] }, qtd_lotes: 1, resumo: { total: 1 } });
  await db.doc("buscas/pbA/lotes/0").set({ dono_uid: uids.ana, leads: [lead({ nome: "Clínica Paraibana", cidade: "João Pessoa", uf: "PB", cidade_buscada: "João Pessoa PB", id_lugar: "pb1",
    latitude: -7.115, longitude: -34.86 })] });
  const tel = { width: 390, height: 844 };
  const esperarPB = (pg, fn) => pg.waitForFunction(fn, null, { timeout: 15000 }).catch(async (e) => {
    throw new Error(`${e.message} [${String(fn).slice(6, 70)}] — hash ${await pg.evaluate(() => location.hash)} · painel: ${await pg.evaluate(() => (document.querySelector("#mapa-painel")?.innerText || "").replace(/\s+/g, " ").slice(0, 400))} · erros: ${erros.join(" | ")}`); });
  const p = await abrir("ana@x.example", "senha-forte-2", tel);
  // ---- Nova busca: seletor de estado com RN e PB; ao trocar, regiões e cidades da PB
  await p.tap("#barra-inferior a[data-ir=nova]");
  assert.deepEqual(await p.$$eval("#uf option", (o) => o.map((x) => x.textContent)), ["Rio Grande do Norte", "Paraíba"]);
  await p.fill("#termo-input", "clínica"); await p.press("#termo-input", "Enter");
  await p.tap("[data-passo-conteudo='1'] [data-ir-passo='2']");
  await p.selectOption("#uf", "PB");
  await p.waitForSelector("#regioes input[data-regiao='25022']", { state: "attached" }); // microrregião de João Pessoa
  assert.match(await p.textContent("#lista-cidades"), /Campina Grande/);
  assert.doesNotMatch(await p.textContent("#lista-cidades"), /Mossoró/);
  assert.equal(await p.locator("#lista-cidades input[data-cidade]").count(), 223);
  assert.match(await p.textContent("#outras-rot"), /fora da PB/);
  await p.$eval("#regioes input[data-regiao='25022']", (e) => e.closest("label").scrollIntoView({ block: "center" }));
  await p.check("#regioes input[data-regiao='25022']");
  await esperarTexto(p, "#qtd-cidades", /^6 de 40 cidades$/);
  let m = await medirLargura(p); assert.equal(m.rolagem, m.largura, `Nova busca PB: ${m.fora.join(", ")}`);
  await p.tap("[data-passo-conteudo='2'] [data-ir-passo='3']");
  const [pedidoSim] = await Promise.all([p.waitForRequest((r) => r.url().includes("/api/criar-busca") && JSON.parse(r.postData() || "{}").simular === true)]);
  const cidadesSim = JSON.parse(pedidoSim.postData()).cidades.split(",");
  assert.deepEqual(cidadesSim, ["Bayeux PB", "Cabedelo PB", "Conde PB", "João Pessoa PB", "Lucena PB", "Santa Rita PB"]);
  // O servidor recebe e grava as consultas com "PB"
  const [resp] = await Promise.all([p.waitForResponse((r) => r.url().includes("/api/criar-busca") && JSON.parse(r.request().postData() || "{}").simular !== true), p.tap("#buscar")]);
  const criada = await resp.json();
  const b = (await db.doc(`buscas/${criada.id}`).get()).data();
  assert.ok(b.parametros.cidades.every((c) => / PB$/.test(c)));
  // ---- Mapa da PB: estado › microrregião › município › leads
  await p.evaluate(() => { location.hash = "#mapa/pb"; });
  await esperarPB(p, () => /Paraíba/.test(document.querySelector("#mapa-painel h2")?.textContent || ""));
  assert.equal(await p.$eval("#uf-mapa", (e) => e.value), "PB");
  assert.match(await p.textContent("#migalhas"), /^PB/);
  await p.locator("#mapa-painel [data-ir-micro='25022']").tap();
  await esperarPB(p, () => location.hash === "#mapa/pb/joao-pessoa");
  await p.locator("#mapa-painel [data-ir-mun='2507507']").tap();
  await esperarPB(p, () => location.hash === "#mapa/pb/joao-pessoa/joao-pessoa");
  await esperarPB(p, () => /^PB›JoãoPessoa›JoãoPessoa$/.test(document.querySelector("#migalhas").textContent.replace(/\s+/g, "")));
  await esperarPB(p, () => /Leads do segmento\s*i?\s*1\s/.test(document.querySelector("#mapa-painel")?.innerText || ""));
  m = await medirLargura(p); assert.equal(m.rolagem, m.largura, `Mapa PB: ${m.fora.join(", ")}`);
  await p.tap("#mapa-ver-tabela");
  await p.locator("#cartoes .cartao-lead", { hasText: "Clínica Paraibana" }).waitFor();
  // Voltar ao Mapa do RN continua como sempre
  await p.evaluate(() => { location.hash = "#mapa/rn"; });
  await esperarPB(p, () => /Rio Grande do Norte/.test(document.querySelector("#mapa-painel h2")?.textContent || ""));
  // ---- Mercado da PB: números do estado (IBGE)
  await p.tap("#barra-inferior a[data-ir=mercado]").catch(() => p.evaluate(() => { location.hash = "#mercado"; }));
  await p.evaluate(() => { location.hash = "#mercado"; });
  await p.waitForSelector("#uf-mercado");
  await p.selectOption("#uf-mercado", "PB");
  await esperarTexto(p, "#kpis-mercado", /População da PB\s*i?\s*3\.974\.687/);
  assert.match(await p.textContent("#kpis-mercado"), /PIB per capita \(PB\)\s*i?\s*R\$\s*21\.66\d/);
  assert.match(await p.textContent("#kpis-mercado"), /Empresas \(CEMPRE · PB\)\s*i?\s*127\.114/);
  assert.match(await p.textContent("#kpis-mercado"), /de 223 municípios pesquisados/);
  m = await medirLargura(p); assert.equal(m.rolagem, m.largura, `Mercado PB: ${m.fora.join(", ")}`);
  assert.deepEqual(erros, []);
  await p.context().close();
  // ---- Estado inteiro (admin): PB estima 345 consultas
  const a = await abrir("breno@x.example", "senha-forte-1", tel);
  await a.waitForSelector("#selo:not(.oculto)", { timeout: 15000 });
  await a.evaluate(() => { location.hash = "#admin"; });
  await a.waitForSelector("#rn-uf");
  assert.match(await a.textContent("#estados"), /✓ Paraíba/);
  assert.match(await a.textContent("#estados"), /Pernambuco · em breve/);
  await a.selectOption("#rn-uf", "PB");
  await a.fill("#rn-termos", "dentista");
  await a.tap("#rn-estimar");
  await esperarTexto(a, "#msg-rn", /^345 consultas em \d+ lotes · tempo estimado ~[\d,]+ h/);
  assert.match(await a.textContent("#rn-confirmar"), /Estado inteiro \(PB\)/);
  assert.deepEqual(erros, []);
  await a.context().close();
  for (const id of [criada.id]) for (const d of (await db.collection("buscas").where("mae_id", "==", id).get()).docs) await d.ref.delete();
  await db.doc(`buscas/${criada.id}`).delete();
  await db.doc("buscas/pbA/lotes/0").delete(); await db.doc("buscas/pbA").delete();
  void breno;
});
