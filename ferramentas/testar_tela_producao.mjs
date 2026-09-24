// Teste REAL da tela em PRODUÇÃO (roda no GitHub Actions, workflow "Testar tela em produção").
// Abre o site de verdade no Chrome, com Firebase, Functions e CDNs reais.
// Cria 2 logins TEMPORÁRIOS (um comum e um admin) e uma busca com leads FICTÍCIOS;
// tudo é apagado no final, mesmo se o teste falhar.
// Log público: só OK/FALHOU por etapa e códigos — nunca e-mails, senhas, tokens ou dados.
//
// API_LOCAL=1 (para validar um PR ANTES do merge, no deploy preview): a página vem do site
// informado (ex.: deploy preview), com Firebase e CDNs reais, mas as chamadas /api/* são
// atendidas pelas Functions DESTE commit, empacotadas como no Netlify (node testes/empacotar.mjs)
// e rodando no runner com as credenciais reais. Motivo: o deploy preview não recebe as
// variáveis secretas do Netlify. /api/config-publica vem do site de produção (é pública).
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import ExcelJS from "exceljs";
import { medirLargura } from "../testes/rotas-cdn.mjs";
import { carregarFuncoesLocais, rotearApiLocal } from "./api_local.mjs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const SITE = (process.argv[2] || "https://mapaleads-rn.netlify.app").replace(/\/$/, "");
const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!conta.private_key) { console.log("ERRO: secret FIREBASE_SERVICE_ACCOUNT ausente."); process.exit(1); }
const app = initializeApp({ credential: cert(conta) }, "teste-tela");
const API_LOCAL = process.env.API_LOCAL === "1";
const funcoesLocais = API_LOCAL ? await carregarFuncoesLocais(conta) : null;
const auth = getAuth(app);
const db = getFirestore(app);
const sufixo = randomBytes(4).toString("hex");
const usuarios = {
  comum: { email: `teste-tela-${sufixo}@example.com`, senha: randomBytes(12).toString("base64url") },
  admin: { email: `teste-tela-adm-${sufixo}@example.com`, senha: randomBytes(12).toString("base64url") },
};
const BUSCA = `teste-tela-${sufixo}`;
// Buscas fictícias extras para testar o "Apagar busca" (vendedor apaga a própria; admin apaga a de outro; 403).
const APAGAR = { comum: `teste-tela-apagar-${sufixo}`, admin: `teste-tela-apagar-adm-${sufixo}`, doAdmin: `teste-tela-do-adm-${sufixo}` };
const pasta = mkdtempSync(join(tmpdir(), "tela-"));
const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const criadas = [];
let falhas = 0;
const etapa = async (nome, fn) => {
  try { await fn(); console.log(`OK      ${nome}`); }
  catch (e) { falhas++; console.log(`FALHOU  ${nome}: ${String(e?.message || e).split("\n")[0].slice(0, 160)}`); }
};
const confere = (cond, msg) => { if (!cond) throw new Error(msg); };

let navegador;
try {
  // ---------- preparação (Admin SDK)
  for (const [papel, u] of Object.entries(usuarios)) {
    u.uid = (await auth.createUser({ email: u.email, password: u.senha })).uid;
    if (papel === "admin") await auth.setCustomUserClaims(u.uid, { admin: true });
  }
  const lead = (x) => ({ nome: "", categoria: "Serviço de teste tela", telefone: "", whatsapp_link: "", email: "", site: "", instagram: "", endereco: "Endereço fictício",
    bairro: "", cidade: "", nota: null, qtd_avaliacoes: null, link_maps: "", termo_que_encontrou: "teste tela", cidade_buscada: "Natal RN",
    cidade_confere: "sim", id_lugar: "", ...x });
  await db.doc(`buscas/${BUSCA}`).set({ tipo: "comum", lista: true, dono_uid: usuarios.comum.uid, dono_email: usuarios.comum.email, status: "concluida",
    criada_em: new Date(), finalizada_em: new Date(), parametros: { termos: ["teste tela"], cidades: ["Natal RN"] }, qtd_lotes: 1,
    resumo: { total: 3, com_telefone: 2, com_email: 0, com_site: 1, com_whatsapp: 1, na_cidade_buscada: 2 } });
  await db.doc(`buscas/${BUSCA}/lotes/0`).set({ dono_uid: usuarios.comum.uid, leads: [
    lead({ nome: "Fictício A", telefone: "(84) 90000-0001", whatsapp_link: "https://wa.me/5584900000001", cidade: "Natal", bairro: "Tirol", nota: 4.5, qtd_avaliacoes: 10, id_lugar: "fa" }),
    lead({ nome: "Fictício B", telefone: "(84) 3000-0002", site: "https://example.com", cidade: "Natal", id_lugar: "fb" }),
    lead({ nome: "Fictício C", cidade: "Parnamirim", cidade_confere: "nao", id_lugar: "fc" }),
    lead({ nome: "Fictício Fora", categoria: "Loja de materiais de construção", cidade: "Natal", id_lugar: "fd" }),
  ] });
  await db.doc(`estatisticas/${hoje}__${usuarios.comum.uid}`).set({ dono_uid: usuarios.comum.uid, buscas: 1, leads: 3, com_whatsapp: 1, dia: hoje });

  navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/usr/bin/google-chrome" });
  const abrir = async (u, viewport = { width: 1366, height: 768 }) => {
    const ctx = await navegador.newContext({ acceptDownloads: true, locale: "pt-BR", viewport, hasTouch: viewport.width < 500, isMobile: viewport.width < 500,
      colorScheme: viewport.width < 500 ? "dark" : "light" }); // celular com o aparelho em modo escuro: a tela tem que abrir clara
    // Sem o tour do primeiro acesso.
    await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
    if (API_LOCAL) await rotearApiLocal(ctx, SITE, funcoesLocais);
    const p = await ctx.newPage();
    p.erros = [];
    p.console = [];
    p.on("pageerror", (e) => p.erros.push(e.message));
    p.on("console", (m) => { if (m.type() === "error") p.console.push(m.text()); });
    p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Perfil de teste" : undefined));
    await p.goto(SITE);
    await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 }).catch((e) => {
      // Diagnóstico sem dados: só a primeira linha dos erros de JavaScript da página.
      throw new Error(`a tela de login não ficou pronta; erros JS: ${p.erros.map((x) => x.split("\n")[0].slice(0, 120)).join(" | ") || "nenhum"}`);
    });
    await p.fill("#le", u.email); await p.fill("#ls", u.senha); await p.click("#entrar");
    try {
      await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)", { timeout: 30000 });
    } catch {
      // Diagnóstico sem dados: mensagem da tela + códigos de erro do Firebase (ex.: auth/...).
      const codigos = [...new Set(p.console.join(" ").match(/(auth|firestore)\/[a-z-]+|HTTP \d{3}|status of \d{3}/g) || [])];
      throw new Error(`login não abriu o painel; tela: "${(await p.textContent("#msg-login")) || ""}"; ` +
        `erros JS: ${p.erros.length}; códigos: ${codigos.join(", ") || "nenhum"}`);
    }
    return p;
  };
  const esperar = (pg, sel, re, timeout = 15000) => pg.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), [sel, re.source], { timeout });
  const esperarHash = (pg, h) => pg.waitForFunction((x) => decodeURIComponent(location.hash) === x, h, { timeout: 15000 });

  // ---------- usuário comum
  const p = await abrir(usuarios.comum);
  await etapa("login e Início (cota, leads no segmento, % WhatsApp, Ver total)", async () => {
    await esperar(p, "#cota-txt", /^0 de \d+$/);
    confere(!(await p.locator("#menu [data-ir=admin]").count()), "menu admin visível para comum");
    // No segmento e da cidade pedida: A e B (a C é de outra cidade; a loja é fora do segmento)
    await esperar(p, "#kpis", /Leads da semana\s*i?2/);
    confere(/Com WhatsApp\s*i?50%/.test(await p.textContent("#kpis")), "% WhatsApp");
    await p.click("#inicio-modo [data-modo=total]");
    await esperar(p, "#kpis", /Leads coletados\s*i?4/);
    await p.click("#inicio-modo [data-modo=segmento]");
    await esperar(p, "#kpis", /Leads no segmento\s*i?2/);
  });
  await etapa("cartão 'Leads da semana' abre Meus leads filtrado", async () => {
    await p.click("#kpis [data-detalhe=semana]");
    await esperar(p, "#conta", /^2 de 4 leads$/);
    confere(/Últimos 7 dias/.test(await p.textContent("#chips")), "chip do período");
    await p.click("#trilha-leads a");
    await esperarHash(p, "#inicio");
  });
  await etapa("nova busca: região, cidades e estimativa", async () => {
    await p.click("[data-ir=nova]");
    await p.fill("#termo-input", "teste tela"); await p.press("#termo-input", "Enter");
    await p.click("[data-passo-conteudo='1'] [data-ir-passo='2']");
    await p.check("#regioes input[data-regiao='24018']");
    await p.uncheck("#lista-cidades input[data-cidade='Extremoz']");
    await p.click("[data-passo-conteudo='2'] [data-ir-passo='3']");
    await p.check("input[name=prof][value=rapida]");
    await esperar(p, "#r-consultas", /^2$/);
  });
  await etapa("perfil salvo, carregado e apagado", async () => {
    await p.click("#passos [data-passo='1']");
    await p.click("#perfil-salvar");
    await p.waitForFunction(() => document.querySelector("#perfil-sel").value !== "", null, { timeout: 15000 });
    const id = await p.inputValue("#perfil-sel");
    await p.click("#passos [data-passo='2']");
    await p.click("#limpar-cidades");
    await p.click("#passos [data-passo='1']");
    await p.selectOption("#perfil-sel", ""); await p.selectOption("#perfil-sel", id);
    await p.click("#passos [data-passo='2']");
    confere(await p.locator("#lista-cidades input:checked").count() === 2, "cidades do perfil");
    await p.click("#passos [data-passo='1']");
    await p.click("#perfil-apagar");
    await p.waitForFunction(() => document.querySelector("#perfil-sel").value === "", null, { timeout: 15000 });
  });
  await etapa("leads: busca clicada no Início, filtro padrão e ficha", async () => {
    await p.click("[data-ir=inicio]");
    await p.click(`#ultimas .busca-item[data-ver-busca='${BUSCA}'] >> text=Natal RN`);
    await esperar(p, "#conta", /^2 de 4 leads$/);
    confere(/1 lead\(s\) fora do segmento/.test(await p.textContent("#segmento-info")), "contador de fora do segmento");
    await p.locator("#tabela-leads tbody tr", { hasText: "Fictício A" }).locator("td").nth(1).click();
    await p.waitForSelector("#ficha:not(.oculto)");
    confere(/Microrregião\s*Natal/.test(await p.textContent("#ficha")), "ficha");
    await p.click("#ficha [data-fechar]");
  });
  await etapa("download .csv e planilha .xlsx formatada (ExcelJS do cdnjs)", async () => {
    await p.selectOption("#f-cidade", "Natal");
    const [csv] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-csv")]);
    confere(csv.suggestedFilename() === `teste-tela-natal-${hoje}.csv`, `nome do csv: ${csv.suggestedFilename().replace(/[^a-z0-9.-]/gi, "")}`);
    confere(readFileSync(await csv.path(), "utf8").trim().split("\r\n").length === 3, "linhas do csv");
    await p.click("#baixar-xlsx");
    await p.waitForSelector("#confirmacao:not(.oculto)");
    confere(/^Vão sair 2 leads/.test(await p.textContent("#conf-texto")), "aviso de quantas linhas vão sair");
    const [xlsx] = await Promise.all([p.waitForEvent("download"), p.click("#conf-sim")]);
    const [a, m, d] = hoje.split("-");
    confere(xlsx.suggestedFilename() === `MapaLeads_teste-tela_Natal_${d}-${m}-${a}.xlsx`, "nome do xlsx");
    await xlsx.saveAs(join(pasta, "t.xlsx"));
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.readFile(join(pasta, "t.xlsx"));
    const ws = livro.getWorksheet("Leads");
    confere(ws && livro.getWorksheet("Resumo"), "abas Leads e Resumo");
    confere(ws.getRow(1).values.slice(1).join("|") === "Nome|Categoria|Cidade|Microrregião|Bairro|Endereço|Telefone|WhatsApp|Site|E-mail|Nota|Avaliações|No segmento|Link do Google Maps|Busca (termo)|Data da coleta", "colunas do xlsx");
    confere(ws.views[0]?.state === "frozen" && ws.autoFilter === "A1:P3", "cabeçalho travado e filtro");
    confere(ws.getCell("A2").value === "Fictício A" && ws.getCell("H2").value?.hyperlink === "https://wa.me/5584900000001", "linha e link do WhatsApp");
    await p.selectOption("#f-cidade", ""); // o mapa acompanha o filtro da tabela: volta ao RN inteiro
  });
  await etapa("mapa (Leaflet do CDN): RN › Natal › Natal pelo painel e categoria → tabela", async () => {
    await p.click("[data-ir=mapa]");
    await p.waitForSelector("#mapa-painel [data-ir-micro='24018']", { timeout: 20000 });
    await p.click("#mapa-painel [data-ir-micro='24018']");
    await esperarHash(p, "#mapa/natal");
    await p.click("#mapa-painel [data-ir-mun='2408102']");
    await esperarHash(p, "#mapa/natal/natal");
    await esperar(p, "#migalhas", /RN\s*›\s*Natal\s*›\s*Natal/);
    confere(await p.locator("#mapa-leaflet .leaflet-tile-loaded").count() > 0, "mosaicos do mapa de fundo não carregaram");
    const cat = p.locator("#mapa-painel [data-categoria]").first();
    const n = (await cat.locator(".num").textContent()).trim();
    await cat.click();
    await esperar(p, "#conta", new RegExp(`^${n} de 4 leads$`));
  });
  await etapa("mercado (Chart.js do CDN): ranking → mapa e gráfico desenhado", async () => {
    await p.click("[data-ir=mercado]");
    await p.waitForSelector("#ranking tr[data-cod='2408102']", { timeout: 20000 });
    await p.waitForFunction(() => window.Chart?.getChart(document.querySelector("#graf-micro")), null, { timeout: 20000 });
    await p.click("#ranking tr[data-cod='2408102']");
    await esperarHash(p, "#mapa/natal/natal");
  });
  if (process.env.MODO === "criar_e_cancelar") {
    await etapa("Buscar de verdade e cancelar pela tela", async () => {
      await p.click("[data-ir=nova]");
      await p.click("#passos [data-passo='3']");
      await p.click("#buscar");
      await esperarHash(p, "#inicio");
      await esperar(p, "#toasts", /Busca criada! Te aviso quando os leads chegarem\./);
      const todas = await db.collection("buscas").where("dono_uid", "==", usuarios.comum.uid).where("status", "in", ["na_fila", "rodando"]).get();
      // A busca (lista: true) e, com várias cidades, as partes dela (uma por máquina do motor).
      const snap = { docs: todas.docs.filter((d) => d.data().lista === true) };
      confere(snap.docs.length === 1, "busca criada no banco");
      const partes = todas.docs.filter((d) => d.data().tipo === "parte" && d.data().mae_id === snap.docs[0].id).length;
      confere(partes === Number(snap.docs[0].data().partes_total || 0), `partes criadas: ${partes}`);
      criadas.push(snap.docs[0].id);
      await p.click(`#ultimas [data-cancelar='${snap.docs[0].id}']`);
      await p.click("#conf-sim"); // confirmação em dois passos
      await new Promise((r) => setTimeout(r, 4000));
      const st = (await db.doc(`buscas/${snap.docs[0].id}`).get()).data();
      confere(st.status === "cancelada" || st.cancelar_solicitado === true, "cancelamento");
      // cancelada antes de começar → já pode apagar (pela Function)
      if (st.status === "cancelada") {
        await p.click("[data-ir=leads]"); await p.click("#abrir-buscas");
        await p.click(`#caixa-buscas [data-apagar='${snap.docs[0].id}']`); await p.click("#conf-sim");
        await esperar(p, "#toasts", /Busca apagada/);
        confere(!(await db.doc(`buscas/${snap.docs[0].id}`).get()).exists, "busca cancelada não foi apagada");
      }
    });
  }
  await etapa("sem erros de JavaScript (comum)", async () => confere(!p.erros.length, `${p.erros.length} erro(s)`));

  // Buscas fictícias para o "Apagar busca" (criadas só agora para não mudar os números conferidos acima).
  for (const [id, dono] of [[APAGAR.comum, usuarios.comum], [APAGAR.admin, usuarios.comum], [APAGAR.doAdmin, usuarios.admin]]) {
    await db.doc(`buscas/${id}`).set({ tipo: "comum", lista: true, dono_uid: dono.uid, dono_email: dono.email, status: "concluida",
      criada_em: new Date(Date.now() - 60000), finalizada_em: new Date(), parametros: { termos: ["apagar teste"], cidades: ["Macau RN"] }, qtd_lotes: 1, resumo: { total: 1 } });
    await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono.uid, leads: [lead({ nome: "Fictício Apagar", cidade: "Macau", cidade_buscada: "Macau RN", id_lugar: "fx" })] });
  }
  // ---------- celular (390 px): nada passa da largura da tela
  const c = await abrir(usuarios.comum, { width: 390, height: 844 });
  await etapa("celular 390 px: largura da página = largura da tela em todas as telas", async () => {
    for (const pag of ["inicio", "nova", "leads", "mapa", "mercado"]) {
      await c.evaluate((h) => { location.hash = h; }, `#${pag}`);
      await c.waitForSelector(`[data-pagina=${pag}]:not(.oculto)`);
      await c.waitForTimeout(1500);
      const m = await medirLargura(c);
      confere(m.rolagem === m.largura && !m.fora.length, `#${pag}: ${m.rolagem}px > ${m.largura}px`);
    }
  });
  await etapa("celular: abre claro, menu de baixo com 4 atalhos, botão de tema troca e fica salvo", async () => {
    confere(await c.evaluate(() => document.documentElement.dataset.tema) === "claro", "não abriu no tema claro");
    const menu = (await c.locator("#barra-inferior a").allTextContents()).map((t) => t.trim()).join("|");
    confere(menu === "Início|Nova busca|Leads|Mapa", `menu de baixo: ${menu}`);
    await c.tap("#tema-btn");
    confere(await c.evaluate(() => document.documentElement.dataset.tema) === "escuro", "o botão não trocou para escuro");
    await c.reload();
    await c.waitForSelector("#tela-app:not(.oculto)", { timeout: 30000 });
    confere(await c.evaluate(() => document.documentElement.dataset.tema) === "escuro", "a escolha não ficou salva");
    await c.tap("#tema-btn");
  });
  await etapa("celular: cada (i) do Início abre com um toque, fica dentro da tela e some ao tocar de novo", async () => {
    await c.evaluate(() => { location.hash = "#inicio"; });
    await c.waitForSelector("#kpis .kpi [data-ajuda]"); await c.waitForTimeout(3000); // buscas e lotes chegando redesenham o Início
    const n = await c.locator("[data-ajuda]:visible").count();
    confere(n > 0, "nenhum (i) visível");
    for (let i = 0; i < n; i++) {
      const b = c.locator("[data-ajuda]:visible").nth(i);
      await b.scrollIntoViewIfNeeded(); await b.tap();
      await c.waitForSelector("#balao:not(.oculto)", { timeout: 3000 }).catch(() => { throw new Error(`(i) nº ${i} de ${n}: não abriu com o toque`); });
      const r = await c.$eval("#balao", (e) => { const q = e.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth && q.top >= 0 && q.bottom <= innerHeight && e.textContent.length > 10; });
      confere(r, `(i) nº ${i}: balão fora da tela ou sem texto`);
      await b.tap();
      await c.waitForSelector("#balao.oculto", { state: "attached", timeout: 3000 }).catch(() => { throw new Error(`(i) nº ${i} de ${n}: não fechou no 2º toque`); });
    }
  });
  await etapa("celular: vendedor apaga a própria busca em dois passos (Apagar → Sim, apagar)", async () => {
    await c.evaluate(() => { location.hash = "#leads"; });
    await c.waitForSelector("[data-pagina=leads]:not(.oculto)");
    await c.tap("#abrir-buscas");
    await c.locator(`#caixa-buscas [data-apagar='${APAGAR.comum}']`).tap();
    await c.waitForSelector("#confirmacao:not(.oculto)");
    confere(/^Apagar a busca .+ com 1 lead\? Isso não pode ser desfeito\.$/.test(await c.textContent("#conf-texto")), "texto da confirmação");
    await c.tap("#conf-sim");
    await esperar(c, "#toasts", /Busca apagada/);
    confere(!(await db.doc(`buscas/${APAGAR.comum}`).get()).exists, "a busca continua no banco");
    confere(!(await db.collection(`buscas/${APAGAR.comum}/lotes`).get()).size, "os leads continuam no banco");
  });
  await etapa("vendedor tentando apagar a busca de outro recebe 403 (servidor)", async () => {
    const r = await c.evaluate(async (id) => {
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js");
      const token = await getAuth().currentUser.getIdToken();
      const resp = await fetch("/api/apagar-busca", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) });
      return resp.status;
    }, APAGAR.doAdmin);
    confere(r === 403, `status ${r}`);
    confere((await db.doc(`buscas/${APAGAR.doAdmin}`).get()).exists, "a busca do admin sumiu");
  });
  await etapa("sem erros de JavaScript (celular)", async () => confere(!c.erros.length, `${c.erros.length} erro(s)`));

  // ---------- admin temporário
  const a = await abrir(usuarios.admin);
  await etapa("admin: saúde do motor com execuções do GitHub", async () => {
    await a.click("#menu [data-ir=admin]");
    await a.waitForFunction(() => /Últimas execuções|Token do GitHub|Não foi possível/.test(document.querySelector("#saude").textContent), null, { timeout: 20000 });
    const txt = await a.textContent("#saude");
    confere(!/Token do GitHub|GitHub respondeu|Não foi possível consultar/.test(txt), "execuções do GitHub indisponíveis");
    confere(await a.locator("#saude table tr").count() > 1, "lista de execuções vazia");
  });
  await etapa("admin: usuários e estimativa do Estado inteiro", async () => {
    await a.waitForSelector("#u-tabela tbody tr:nth-child(2)", { timeout: 15000 });
    await a.fill("#rn-termos", "teste");
    await a.click("#rn-estimar");
    await esperar(a, "#msg-rn", /249 consultas/);
  });
  await etapa("admin apaga a busca de um vendedor (lista de buscas do Admin)", async () => {
    await a.waitForSelector(`#buscas-admin [data-apagar='${APAGAR.admin}']`, { timeout: 15000 });
    await a.click(`#buscas-admin [data-apagar='${APAGAR.admin}']`);
    await a.click("#conf-sim");
    await esperar(a, "#toasts", /Busca apagada/);
    confere(!(await db.doc(`buscas/${APAGAR.admin}`).get()).exists, "a busca do vendedor continua no banco");
  });
  await etapa("sem erros de JavaScript (admin)", async () => confere(!a.erros.length, `${a.erros.length} erro(s)`));
  await etapa("troca de usuário na mesma aba: admin sai, comum entra, nada do admin aparece", async () => {
    await a.click("#avatar");
    await a.click("#sair");
    await a.waitForSelector("#tela-login:not(.oculto) #entrar:not([disabled])", { timeout: 30000 });
    await a.fill("#le", usuarios.comum.email); await a.fill("#ls", usuarios.comum.senha); await a.click("#entrar");
    await a.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)", { timeout: 30000 });
    await esperar(a, "#cota-txt", /\d de \d+/);
    confere(!(await a.isVisible("#selo")) && !(await a.locator("#menu [data-ir=admin]").count()), "selo/menu admin visível para usuário comum");
    confere((await a.textContent("#menu-email")) === usuarios.comum.email, "usuário errado na tela");
  });
} catch (e) {
  falhas++;
  console.log(`FALHOU  preparação: ${String(e?.message || e).split("\n")[0].slice(0, 160)}`);
} finally {
  // ---------- limpeza: nada do teste fica em produção
  await navegador?.close();
  // Partes (paralelismo) das buscas criadas pelo teste também saem, com os lotes parciais.
  const partesCriadas = [];
  for (const id of criadas) partesCriadas.push(...(await db.collection("buscas").where("mae_id", "==", id).get()).docs.map((d) => d.id));
  for (const id of [BUSCA, ...Object.values(APAGAR), ...criadas, ...partesCriadas]) {
    for (const l of (await db.collection(`buscas/${id}/lotes`).get()).docs) await l.ref.delete();
    await db.doc(`buscas/${id}`).delete();
  }
  for (const u of Object.values(usuarios)) {
    if (!u.uid) continue;
    for (const d of (await db.collection(`usuarios/${u.uid}/perfis`).get()).docs) await d.ref.delete();
    await db.doc(`usuarios/${u.uid}`).delete();
    await db.doc(`estatisticas/${hoje}__${u.uid}`).delete();
    await auth.deleteUser(u.uid).catch(() => {});
  }
  rmSync(pasta, { recursive: true, force: true });
  console.log("Limpeza feita: logins, busca, perfis e estatísticas de teste apagados.");
}
console.log(falhas ? `${falhas} etapa(s) falharam.` : "Tela em produção: tudo OK.");
process.exit(falhas ? 1 : 0);
