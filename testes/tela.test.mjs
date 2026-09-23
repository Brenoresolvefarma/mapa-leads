// Teste da TELA (v2) no Chromium (Playwright) contra os emuladores do Firebase + Functions locais.
// Dados 100% fictícios. Rodar: npm run test:tela   (precisa de Java e de um Chromium)
//  - NAVEGADOR: caminho do Chromium/Chrome (padrão: /opt/pw-browsers/chromium; no CI, o Chrome do runner);
//  - bibliotecas do CDN servidas do node_modules (testes/rotas-cdn.mjs), sem depender da rede;
//  - TESTAR_XLSX=1 testa o .xlsx de verdade com o SheetJS do CDN oficial (o CI tem internet).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { medirLargura, rotearCdn } from "./rotas-cdn.mjs";

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
    criada_em: new Date(agora - 3600000), finalizada_em: new Date(agora - 3500000), parametros: { termos: ["clínica"], cidades: ["Natal RN"] }, qtd_lotes: 1,
    resumo: { total: 3, com_telefone: 2, com_email: 0, com_site: 1, com_whatsapp: 1, na_cidade_buscada: 2 } });
  await db.doc("buscas/b1/lotes/0").set({ dono_uid: ana.uid, leads: [
    lead({ nome: "Clínica Alfa", telefone: "(84) 99999-0001", whatsapp_link: "https://wa.me/5584999990001", bairro: "Tirol", cidade: "Natal", nota: 4.8, qtd_avaliacoes: 120, id_lugar: "p1", latitude: -5.79, longitude: -35.2 }),
    lead({ nome: "Clínica Beta", telefone: "(84) 3333-0002", site: "https://beta.example", bairro: "Centro", cidade: "Natal", nota: 3.9, qtd_avaliacoes: 8, id_lugar: "p2" }),
    lead({ nome: "Clínica Gama", cidade: "Parnamirim", cidade_confere: "nao", id_lugar: "p3" }),
  ] });
  await db.doc("buscas/b2").set({ tipo: "comum", lista: true, dono_uid: ana.uid, dono_email: "ana@x.example", status: "concluida",
    criada_em: new Date(agora - 1800000), finalizada_em: new Date(agora - 1700000), parametros: { termos: ["clínica"], cidades: ["Extremoz RN"] }, qtd_lotes: 1,
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
  navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium" });
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
  await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
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

  // Barra do dia de hoje no gráfico → leads das buscas que terminaram hoje (mesmo número da barra)
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
  assert.match(await texto(p, "#qtd-cidades"), /^2 cidades/);
  assert.equal(await p.locator(`#mapa-escolha path.mun[data-cod="${NATAL}"]`).getAttribute("fill"), "var(--brand)");
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
  await esperarTexto(p, "#toasts", /ainda pode fazer 2 hoje/);
  const { db } = firebase();
  const criadas = await db.collection("buscas").where("dono_uid", "==", uids.ana).where("status", "==", "na_fila").get();
  assert.equal(criadas.size, 1);
  assert.deepEqual(criadas.docs[0].data().parametros.cidades, ["Natal RN", "Parnamirim RN"]);
  assert.deepEqual(criadas.docs[0].data().parametros.sinonimos, []);

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
  if (process.env.TESTAR_XLSX === "1") {
    const [xlsx] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-xlsx")]);
    assert.equal(xlsx.suggestedFilename(), `clinica-varias-cidades-${hoje}.xlsx`);
    const destino = join(pasta, "planilha.xlsx");
    await xlsx.saveAs(destino);
    const xml = execFileSync("unzip", ["-p", destino], { encoding: "utf8" });
    assert.ok(xml.includes("cidade_confere") && xml.includes("regiao_imediata") && !xml.includes("id_lugar"));
    assert.ok(xml.includes("Clínica Alfa") && xml.includes("Resolve Farma")); // assinatura na aba Resumo
  }
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
  assert.ok(await p.isVisible("#selo"));
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
