// Teste da TELA no Chromium (Playwright) contra os emuladores do Firebase + Functions locais.
// Dados 100% fictícios. Rodar: npm run test:tela   (precisa de Java e de um Chromium)
//  - NAVEGADOR: caminho do Chromium/Chrome (padrão: /opt/pw-browsers/chromium; no CI, o Chrome do runner);
//  - o SDK do Firebase é servido do node_modules (mesma versão do CDN), sem depender da rede;
//  - TESTAR_XLSX=1 testa o .xlsx de verdade com o SheetJS do CDN oficial (o CI tem internet).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

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
let navegador, local, pagina, erros = [];
const uids = {};

const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
  const agora = new Date();
  // Duas buscas concluídas da Ana, com um lead repetido entre elas (id_lugar "p1").
  await db.doc("buscas/b1").set({ tipo: "comum", lista: true, dono_uid: ana.uid, dono_email: "ana@x.example", status: "concluida",
    criada_em: new Date(agora - 3600000), parametros: { termos: ["clínica"], cidades: ["Natal RN"] }, qtd_lotes: 1,
    resumo: { total: 3, com_telefone: 2, com_email: 0, com_site: 1, com_whatsapp: 1, na_cidade_buscada: 2 } });
  await db.doc("buscas/b1/lotes/0").set({ dono_uid: ana.uid, leads: [
    lead({ nome: "Clínica Alfa", telefone: "(84) 99999-0001", whatsapp_link: "https://wa.me/5584999990001", bairro: "Tirol", cidade: "Natal", nota: 4.8, qtd_avaliacoes: 120, id_lugar: "p1" }),
    lead({ nome: "Clínica Beta", telefone: "(84) 3333-0002", site: "https://beta.example", bairro: "Centro", cidade: "Natal", nota: 3.9, qtd_avaliacoes: 8, id_lugar: "p2" }),
    lead({ nome: "Clínica Gama", cidade: "Parnamirim", cidade_confere: "nao", id_lugar: "p3" }),
  ] });
  await db.doc("buscas/b2").set({ tipo: "comum", lista: true, dono_uid: ana.uid, dono_email: "ana@x.example", status: "concluida",
    criada_em: new Date(agora - 1800000), parametros: { termos: ["clínica"], cidades: ["Extremoz RN"] }, qtd_lotes: 1,
    resumo: { total: 2, com_telefone: 1, com_email: 0, com_site: 0, com_whatsapp: 1, na_cidade_buscada: 1 } });
  await db.doc("buscas/b2/lotes/0").set({ dono_uid: ana.uid, leads: [
    lead({ nome: "Clínica Alfa", telefone: "(84) 99999-0001", whatsapp_link: "https://wa.me/5584999990001", cidade: "Natal", id_lugar: "p1", termo_que_encontrou: "consultório", cidade_buscada: "Extremoz RN", cidade_confere: "nao" }),
    lead({ nome: "Clínica Delta; & <b>", telefone: "(84) 99999-0004", whatsapp_link: "https://wa.me/5584999990004", cidade: "Extremoz", cidade_buscada: "Extremoz RN", id_lugar: "p4" }),
    // Google devolveu algo "parecido": fora do segmento (marcado, não apagado)
    lead({ nome: "Loja Exemplo Construções", categoria: "Loja de materiais de construção", site: "https://loja.example", cidade: "Extremoz", cidade_buscada: "Extremoz RN", id_lugar: "p5" }),
    // Sem cidade no endereço: escondido por padrão com "Só da cidade pedida"
    lead({ nome: "Clínica Sem Endereço", cidade: "", endereco: "", cidade_buscada: "Extremoz RN", cidade_confere: "indefinido", id_lugar: "p6" }),
  ] });
  // Uma busca de outra pessoa (a Ana não pode ver).
  await db.doc("buscas/outra").set({ tipo: "comum", lista: true, dono_uid: breno.uid, status: "concluida", criada_em: agora, parametros: { termos: ["segredo"], cidades: ["Natal RN"] }, qtd_lotes: 1 });
  await db.doc("buscas/outra/lotes/0").set({ dono_uid: breno.uid, leads: [lead({ nome: "Lead Do Admin", categoria: "Segredo", cidade: "Natal", termo_que_encontrou: "segredo", id_lugar: "adm" })] });
  await db.doc(`estatisticas/${hoje}__${ana.uid}`).set({ dono_uid: ana.uid, buscas: 2, leads: 5, com_whatsapp: 2, com_telefone: 3, dia: hoje });
  await db.doc(`estatisticas/${hoje}__geral`).set({ buscas: 9, leads: 50, com_whatsapp: 10, dia: hoje });
  await db.doc(`usuarios/${ana.uid}`).set({ email: "ana@x.example", dia: hoje, contagem_dia: 2, limite_diario: 5 });

  local = await iniciarServidor();
  navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium" });
});

after(async () => {
  await navegador?.close();
  local?.servidor.close();
  rmSync(pasta, { recursive: true, force: true });
});

async function abrir(email, senha) {
  const contexto = await navegador.newContext({ acceptDownloads: true, locale: "pt-BR" });
  // SDK do Firebase do node_modules (mesma versão do CDN, arquivos idênticos).
  await contexto.route("https://www.gstatic.com/firebasejs/**", (rota) => {
    const arquivo = new URL(rota.request().url()).pathname.split("/").pop();
    rota.fulfill({ path: `node_modules/firebase/${arquivo}`, contentType: "text/javascript" });
  });
  pagina = await contexto.newPage();
  erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Clínicas Natal" : undefined));
  await pagina.goto(`${local.url}/?emulador=1`);
  await pagina.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
  await pagina.fill("#le", email);
  await pagina.fill("#ls", senha);
  await pagina.click("#entrar");
  await pagina.waitForSelector("#tela-hoje:not(.oculto)");
  return pagina;
}

test("usuário comum: Hoje, nova busca com regiões e perfil, leads juntos, filtros, ficha e exportação", async () => {
  const p = await abrir("ana@x.example", "senha-forte-2");
  // ---- Hoje
  await p.waitForFunction(() => document.querySelector("#h-leads").textContent !== "–");
  assert.equal(await p.textContent("#h-leads"), "5");
  assert.equal(await p.textContent("#h-whats"), "40%");
  assert.equal(await p.textContent("#h-cota"), "2 / 5");
  assert.equal(await p.isVisible("#aba-admin"), false);
  assert.equal(await p.textContent("#h-geral"), ""); // números gerais só para o admin

  // ---- Nova busca: microrregião Natal (Extremoz, Natal, Parnamirim), desmarca Extremoz
  await p.click("nav [data-aba=nova]");
  await p.check("#regioes input[data-regiao='24018']");
  assert.equal(await p.locator("#cidades input:checked").count(), 3);
  await p.uncheck("#cidades input[data-cidade='Extremoz']");
  assert.match(await p.textContent("#qtd-cidades"), /2 de 3/);
  // Sinônimos sugeridos e editáveis (confirmados antes de buscar)
  await p.fill("#termos", "home care");
  await p.waitForSelector("#caixa-sinonimos:not(.oculto)");
  assert.ok((await p.textContent("#sinonimos")).includes("casa de repouso"));
  await p.click("#sinonimos [aria-label='Tirar casa de repouso']");
  assert.ok(!(await p.textContent("#sinonimos")).includes("casa de repouso"));
  await p.click("#sin-restaurar");
  assert.ok((await p.textContent("#sinonimos")).includes("casa de repouso"));
  await p.fill("#termos", "clínica");
  assert.match(await p.textContent("#sinonimos"), /Sem sugestões/);
  await p.selectOption("#prof", "rapida");
  await p.waitForFunction(() => /Estimativa: 2 consulta/.test(document.querySelector("#estimativa").textContent));
  // Regiões imediatas: 11 opções
  await p.check("input[name=tipo-regiao][value=imediata]");
  assert.equal(await p.locator("#regioes .chip").count(), 11);
  await p.check("input[name=tipo-regiao][value=micro]");
  assert.equal(await p.locator("#regioes .chip").count(), 19);
  await p.check("#regioes input[data-regiao='24018']");
  await p.uncheck("#cidades input[data-cidade='Extremoz']");
  // Perfil salvo no servidor e recarregado
  await p.click("#perfil-salvar");
  await p.waitForFunction(() => document.querySelector("#msg-nova").textContent === "Perfil salvo.");
  await p.click("#limpar-cidades");
  await p.fill("#termos", "");
  const idPerfil = await p.inputValue("#perfil-sel");
  await p.selectOption("#perfil-sel", "");
  await p.selectOption("#perfil-sel", idPerfil);
  assert.equal(await p.inputValue("#termos"), "clínica");
  assert.equal(await p.locator("#cidades input:checked").count(), 2);
  assert.equal(await p.locator("#cidades input").count(), 3); // Extremoz volta desmarcada
  // Buscar de verdade (emulador): cria a busca e conta no limite
  await p.click("#buscar");
  await p.waitForFunction(() => /Busca criada/.test(document.querySelector("#msg-nova").textContent));
  assert.match(await p.textContent("#msg-nova"), /ainda pode fazer 2 hoje/);
  const { db } = firebase();
  const criadas = await db.collection("buscas").where("dono_uid", "==", uids.ana).where("status", "==", "na_fila").get();
  assert.equal(criadas.size, 1);
  assert.deepEqual(criadas.docs[0].data().parametros.cidades, ["Natal RN", "Parnamirim RN"]);
  assert.deepEqual(criadas.docs[0].data().parametros.sinonimos, []);

  // ---- Buscas: só as próprias; juntar duas buscas
  await p.click("nav [data-aba=buscas]");
  await p.waitForSelector("#lista .busca");
  assert.equal(await p.locator("#lista .busca").count(), 3);
  assert.ok(!(await p.textContent("#lista")).includes("segredo"));
  await p.check("[data-selecionar=b1]");
  await p.check("[data-selecionar=b2]");
  await p.click("#abrir-selecionadas");
  await p.waitForFunction(() => /de 6 leads/.test(document.querySelector("#leads-contagem").textContent));
  // 7 leads - 1 repetido = 6. Por padrão: "só do segmento" esconde a loja; "só da cidade pedida" esconde a
  // Gama (Parnamirim, não confere) e a sem endereço.
  assert.equal(await p.textContent("#leads-contagem"), "3 de 6 leads");
  assert.match(await p.textContent("#segmento-info"), /Segmento: clínica.*1 lead\(s\) fora do segmento escondido\(s\) – ver/);
  const alfa = p.locator("#tabela-leads tbody tr", { hasText: "Clínica Alfa" });
  assert.match(await alfa.textContent(), /Natal/);
  assert.match(await alfa.textContent(), /Tirol/);
  assert.equal(await alfa.locator("a.wa").getAttribute("href"), "https://wa.me/5584999990001");
  // Nome com HTML aparece como texto (sem injeção)
  assert.equal(await p.locator("#tabela-leads tbody b", { hasText: "Clínica Delta; & <b>" }).count(), 1);
  // Filtros
  await p.uncheck("#f-pedida");
  assert.equal(await p.textContent("#leads-contagem"), "5 de 6 leads");
  await p.check("#f-pedida");
  await p.check("#f-semcidade");
  assert.equal(await p.textContent("#leads-contagem"), "4 de 6 leads");
  await p.uncheck("#f-semcidade");
  await p.click("#ver-fora"); // "ver" os fora do segmento
  assert.equal(await p.isChecked("#f-segmento"), false);
  assert.equal(await p.textContent("#leads-contagem"), "4 de 6 leads");
  assert.match(await p.locator("#tabela-leads tbody tr", { hasText: "Loja Exemplo" }).textContent(), /fora do segmento/);
  await p.check("#f-segmento");
  // Categorias do Google com contagem, marcar/desmarcar
  await p.click("#caixa-categorias summary");
  assert.deepEqual((await p.locator("#f-cat-lista label").allTextContents()).map((t) => t.trim()), ["✓ Clínica (3)", "Loja de materiais de construção (1)"]);
  await p.uncheck("#f-cat-lista input[data-cat='Clínica']");
  assert.equal(await p.textContent("#leads-contagem"), "0 de 6 leads");
  await p.click("#cat-segmento");
  assert.equal(await p.textContent("#leads-contagem"), "3 de 6 leads");
  await p.check("#f-whats");
  assert.equal(await p.textContent("#leads-contagem"), "2 de 6 leads");
  await p.uncheck("#f-whats");
  await p.check("#f-semsite");
  assert.equal(await p.textContent("#leads-contagem"), "2 de 6 leads");
  await p.uncheck("#f-semsite");
  await p.selectOption("#f-nota", "4");
  assert.equal(await p.textContent("#leads-contagem"), "1 de 6 leads");
  await p.selectOption("#f-nota", "");
  const opcoesCidade = await p.locator("#f-cidade option").allTextContents();
  assert.deepEqual(opcoesCidade, ["Todas", "Natal (2)", "Extremoz (1)"]);
  const opcoesRegiao = await p.locator("#f-regiao option").allTextContents();
  assert.deepEqual(opcoesRegiao, ["Todas", "Natal (3)"]);
  // Ficha do lead
  await alfa.locator("td").first().click();
  await p.waitForSelector("#ficha[open]");
  const ficha = await p.textContent("#ficha-dados");
  assert.match(ficha, /Microrregião\s*Natal/);
  assert.match(ficha, /Região imediata\s*Natal/);
  assert.match(ficha, /clínica, consultório/); // termos juntados
  await p.click("#ficha-fechar");

  // ---- Exportar .csv com os filtros: 1 cidade -> segmento-cidade-data
  await p.selectOption("#f-cidade", "Natal");
  const [csv] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-csv")]);
  assert.equal(csv.suggestedFilename(), `clinica-natal-${hoje}.csv`);
  const conteudo = readFileSync(await csv.path(), "utf8");
  const linhas = conteudo.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(linhas.length, 3); // cabeçalho + 2 leads de Natal
  assert.ok(linhas[0].startsWith("nome;categoria;") && linhas[0].includes("microrregiao;regiao_imediata") && linhas[0].endsWith("cidade_confere;categorias;no_segmento"));
  assert.ok(linhas[1].endsWith(";sim"));
  assert.ok(!linhas[0].includes("id_lugar"));
  assert.ok(conteudo.includes(";4,8;")); // nota com vírgula
  // Sem filtro de cidade, 2 buscas (Natal + Extremoz) -> várias cidades
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
    assert.ok(xml.includes("Clínica Alfa"));
  }
  assert.deepEqual(erros, []);
  await p.context().close();
});

test("admin: aba Admin com saúde do motor, usuários e RN inteiro", async () => {
  const p = await abrir("breno@x.example", "senha-forte-1");
  await p.waitForFunction(() => /Todos os usuários/.test(document.querySelector("#h-geral").textContent));
  assert.match(await p.textContent("#h-geral"), /50 leads em 9 busca/);
  await p.click("#aba-admin");
  await p.waitForFunction(() => /Últimas execuções/.test(document.querySelector("#saude").textContent));
  assert.match(await p.textContent("#saude"), /Token do GitHub não configurado/);
  await p.waitForSelector("#u-tabela tr >> text=ana@x.example");
  await p.fill("#rn-termos", "dentista");
  await p.click("#rn-estimar");
  await p.waitForFunction(() => /249 consultas/.test(document.querySelector("#msg-rn").textContent));
  // Admin vê as buscas de todos e abre os leads da própria busca
  await p.click("nav [data-aba=buscas]");
  await p.waitForFunction(() => /segredo/.test(document.querySelector("#lista").textContent));
  await p.click("[data-ver='outra']");
  await p.waitForFunction(() => /Lead Do Admin/.test(document.querySelector("#tabela-leads").textContent));

  // BUG DE SEGURANÇA (corrigido): sair e entrar com usuário comum NA MESMA ABA, sem F5.
  await p.click("#sair");
  await p.waitForFunction(() => !document.querySelector("#tabela-leads")?.textContent.includes("Lead Do Admin"), null, { timeout: 30000 });
  await p.waitForSelector("#login:not(.oculto) #entrar:not([disabled])", { timeout: 30000 });
  await p.fill("#le", "ana@x.example"); await p.fill("#ls", "senha-forte-2"); await p.click("#entrar");
  await p.waitForSelector("#tela-hoje:not(.oculto)");
  await p.waitForFunction(() => document.querySelector("#h-cota").textContent !== "–");
  assert.equal(await p.isVisible("#selo"), false, "selo admin não pode aparecer");
  assert.equal(await p.isVisible("#aba-admin"), false, "menu Admin não pode aparecer");
  const corpo = await p.textContent("body");
  assert.ok(!corpo.includes("Lead Do Admin"), "lead do admin não pode aparecer");
  assert.equal(await p.textContent("#tabela-leads tbody"), "");
  await p.click("nav [data-aba=buscas]");
  await p.waitForSelector("#lista .busca");
  assert.ok(!(await p.textContent("#lista")).includes("segredo"), "busca do admin não pode aparecer");
  assert.equal(await p.textContent("#email"), "ana@x.example");
  assert.deepEqual(erros, []);
  await p.context().close();
});
