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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const SITE = (process.argv[2] || "https://mapaleads-rn.netlify.app").replace(/\/$/, "");
const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!conta.private_key) { console.log("ERRO: secret FIREBASE_SERVICE_ACCOUNT ausente."); process.exit(1); }
const app = initializeApp({ credential: cert(conta) }, "teste-tela");
const API_LOCAL = process.env.API_LOCAL === "1";
const PRODUCAO = "https://mapaleads-rn.netlify.app";
let funcoesLocais = null;
if (API_LOCAL) {
  // Mesmas variáveis que o Netlify usa (a chave com "\n" literal, como colada lá).
  process.env.FIREBASE_PROJECT_ID = conta.project_id;
  process.env.FIREBASE_CLIENT_EMAIL = conta.client_email;
  process.env.FIREBASE_PRIVATE_KEY = conta.private_key.replace(/\n/g, "\\n");
  funcoesLocais = {};
  for (const nome of ["criar-busca", "cancelar-busca", "admin-usuarios", "perfis", "saude-motor"]) {
    const caminho = resolve(".netlify/teste-empacotamento", nome, "netlify/functions", `${nome}.mjs`);
    funcoesLocais[`/api/${nome}`] = (await import(pathToFileURL(caminho).href)).default;
  }
}
const auth = getAuth(app);
const db = getFirestore(app);
const sufixo = randomBytes(4).toString("hex");
const usuarios = {
  comum: { email: `teste-tela-${sufixo}@example.com`, senha: randomBytes(12).toString("base64url") },
  admin: { email: `teste-tela-adm-${sufixo}@example.com`, senha: randomBytes(12).toString("base64url") },
};
const BUSCA = `teste-tela-${sufixo}`;
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
  const lead = (x) => ({ nome: "", categoria: "Teste", telefone: "", whatsapp_link: "", email: "", site: "", instagram: "", endereco: "Endereço fictício",
    bairro: "", cidade: "", nota: null, qtd_avaliacoes: null, link_maps: "", termo_que_encontrou: "teste tela", cidade_buscada: "Natal RN",
    cidade_confere: "sim", id_lugar: "", ...x });
  await db.doc(`buscas/${BUSCA}`).set({ tipo: "comum", lista: true, dono_uid: usuarios.comum.uid, dono_email: usuarios.comum.email, status: "concluida",
    criada_em: new Date(), parametros: { termos: ["teste tela"], cidades: ["Natal RN"] }, qtd_lotes: 1,
    resumo: { total: 3, com_telefone: 2, com_email: 0, com_site: 1, com_whatsapp: 1, na_cidade_buscada: 2 } });
  await db.doc(`buscas/${BUSCA}/lotes/0`).set({ dono_uid: usuarios.comum.uid, leads: [
    lead({ nome: "Fictício A", telefone: "(84) 90000-0001", whatsapp_link: "https://wa.me/5584900000001", cidade: "Natal", bairro: "Tirol", nota: 4.5, qtd_avaliacoes: 10, id_lugar: "fa" }),
    lead({ nome: "Fictício B", telefone: "(84) 3000-0002", site: "https://example.com", cidade: "Natal", id_lugar: "fb" }),
    lead({ nome: "Fictício C", cidade: "Parnamirim", cidade_confere: "nao", id_lugar: "fc" }),
  ] });
  await db.doc(`estatisticas/${hoje}__${usuarios.comum.uid}`).set({ dono_uid: usuarios.comum.uid, buscas: 1, leads: 3, com_whatsapp: 1, dia: hoje });

  navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/usr/bin/google-chrome" });
  const abrir = async (u) => {
    const ctx = await navegador.newContext({ acceptDownloads: true, locale: "pt-BR" });
    if (API_LOCAL) {
      await ctx.route(`${SITE}/api/**`, async (rota) => {
        const req = rota.request();
        const caminho = new URL(req.url()).pathname;
        if (caminho === "/api/config-publica") {
          const r = await fetch(`${PRODUCAO}/api/config-publica`);
          return rota.fulfill({ status: r.status, contentType: "application/json", body: await r.text() });
        }
        const fn = funcoesLocais[caminho];
        if (!fn) return rota.fulfill({ status: 404, body: "{}" });
        const resposta = await fn(new Request(`http://local${caminho}`, {
          method: req.method(), headers: await req.allHeaders(), body: req.method() === "POST" ? req.postData() : undefined,
        }));
        return rota.fulfill({ status: resposta.status, contentType: "application/json", body: await resposta.text() });
      });
    }
    const p = await ctx.newPage();
    p.erros = [];
    p.console = [];
    p.on("pageerror", (e) => p.erros.push(e.message));
    p.on("console", (m) => { if (m.type() === "error") p.console.push(m.text()); });
    p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Perfil de teste" : undefined));
    await p.goto(SITE);
    await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
    await p.fill("#le", u.email); await p.fill("#ls", u.senha); await p.click("#entrar");
    try {
      await p.waitForSelector("#tela-hoje:not(.oculto)", { timeout: 30000 });
    } catch {
      // Diagnóstico sem dados: mensagem da tela + códigos de erro do Firebase (ex.: auth/...).
      const codigos = [...new Set(p.console.join(" ").match(/(auth|firestore)\/[a-z-]+|HTTP \d{3}|status of \d{3}/g) || [])];
      throw new Error(`login não abriu o painel; tela: "${(await p.textContent("#msg-login")) || ""}"; ` +
        `erros JS: ${p.erros.length}; códigos: ${codigos.join(", ") || "nenhum"}`);
    }
    return p;
  };

  // ---------- usuário comum
  const p = await abrir(usuarios.comum);
  await etapa("login e painel Hoje (cota)", async () => {
    await p.waitForFunction(() => document.querySelector("#h-cota").textContent !== "–", null, { timeout: 15000 });
    confere(/^0 \/ \d+$/.test(await p.textContent("#h-cota")), "cota");
    confere(!(await p.isVisible("#aba-admin")), "aba admin visível para comum");
  });
  await etapa("painel Hoje (leads da semana, regra de estatisticas)", async () => {
    await p.waitForFunction(() => document.querySelector("#h-leads").textContent !== "–" || /Não foi possível/.test(document.querySelector("#h-geral").textContent), null, { timeout: 15000 });
    if (/permission-denied/.test(await p.textContent("#h-geral"))) {
      throw new Error("permission-denied: publique o firestore.rules novo no console do Firebase");
    }
    confere(await p.textContent("#h-leads") === "3", "leads da semana");
    confere(await p.textContent("#h-whats") === "33%", "% WhatsApp");
  });
  await etapa("nova busca: região, cidades e estimativa", async () => {
    await p.click("nav [data-aba=nova]");
    await p.check("#regioes input[data-regiao='24018']");
    await p.uncheck("#cidades input[data-cidade='Extremoz']");
    await p.fill("#termos", "teste tela");
    await p.selectOption("#prof", "rapida");
    await p.waitForFunction(() => /Estimativa: 2 consulta/.test(document.querySelector("#estimativa").textContent), null, { timeout: 15000 });
  });
  await etapa("perfil salvo, carregado e apagado", async () => {
    await p.click("#perfil-salvar");
    await p.waitForFunction(() => document.querySelector("#msg-nova").textContent === "Perfil salvo.", null, { timeout: 15000 });
    const id = await p.inputValue("#perfil-sel");
    await p.click("#limpar-cidades");
    await p.selectOption("#perfil-sel", ""); await p.selectOption("#perfil-sel", id);
    confere(await p.locator("#cidades input:checked").count() === 2, "cidades do perfil");
    await p.click("#perfil-apagar");
    await p.waitForFunction(() => document.querySelector("#msg-nova").textContent === "Perfil apagado.", null, { timeout: 15000 });
  });
  await etapa("leads: tabela, filtro padrão e ficha", async () => {
    await p.click("nav [data-aba=buscas]");
    await p.click(`[data-ver='${BUSCA}']`);
    await p.waitForFunction(() => /de 3 leads/.test(document.querySelector("#leads-contagem").textContent), null, { timeout: 15000 });
    confere(await p.textContent("#leads-contagem") === "2 de 3 leads", "filtro 'só da cidade pedida'");
    await p.locator("#tabela-leads tbody tr", { hasText: "Fictício A" }).locator("td").first().click();
    await p.waitForSelector("#ficha[open]");
    confere(/Microrregião\s*Natal/.test(await p.textContent("#ficha-dados")), "ficha");
    await p.click("#ficha-fechar");
  });
  await etapa("download .csv e .xlsx (SheetJS do CDN oficial)", async () => {
    const [csv] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-csv")]);
    confere(csv.suggestedFilename() === `teste-tela-natal-${hoje}.csv`, `nome do csv: ${csv.suggestedFilename().replace(/[^a-z0-9.-]/gi, "")}`);
    confere(readFileSync(await csv.path(), "utf8").trim().split("\r\n").length === 3, "linhas do csv");
    const [xlsx] = await Promise.all([p.waitForEvent("download"), p.click("#baixar-xlsx")]);
    confere(xlsx.suggestedFilename() === `teste-tela-natal-${hoje}.xlsx`, "nome do xlsx");
    await xlsx.saveAs(join(pasta, "t.xlsx"));
    const xml = execFileSync("unzip", ["-p", join(pasta, "t.xlsx")], { encoding: "utf8" });
    confere(xml.includes("cidade_confere") && !xml.includes("id_lugar") && xml.includes("Fictício A"), "conteúdo do xlsx");
  });
  if (process.env.MODO === "criar_e_cancelar") {
    await etapa("Buscar de verdade e cancelar pela tela", async () => {
      await p.click("nav [data-aba=nova]");
      await p.click("#buscar");
      await p.waitForFunction(() => /Busca criada/.test(document.querySelector("#msg-nova").textContent), null, { timeout: 20000 });
      const snap = await db.collection("buscas").where("dono_uid", "==", usuarios.comum.uid).where("status", "in", ["na_fila", "rodando"]).get();
      confere(snap.size === 1, "busca criada no banco");
      criadas.push(snap.docs[0].id);
      await p.click("nav [data-aba=buscas]");
      await p.click(`[data-cancelar='${snap.docs[0].id}']`);
      await new Promise((r) => setTimeout(r, 4000));
      const st = (await db.doc(`buscas/${snap.docs[0].id}`).get()).data();
      confere(st.status === "cancelada" || st.cancelar_solicitado === true, "cancelamento");
    });
  }
  await etapa("sem erros de JavaScript (comum)", async () => confere(!p.erros.length, `${p.erros.length} erro(s)`));

  // ---------- admin temporário
  const a = await abrir(usuarios.admin);
  await etapa("admin: saúde do motor com execuções do GitHub", async () => {
    await a.click("#aba-admin");
    await a.waitForFunction(() => /Últimas execuções/.test(document.querySelector("#saude").textContent), null, { timeout: 20000 });
    const txt = await a.textContent("#saude");
    confere(!/Token do GitHub|GitHub respondeu|Não foi possível consultar/.test(txt), "execuções do GitHub indisponíveis");
    confere(await a.locator("#saude table tr").count() > 1, "lista de execuções vazia");
  });
  await etapa("admin: usuários e estimativa do RN inteiro", async () => {
    await a.waitForSelector("#u-tabela tr:nth-child(2)", { timeout: 15000 });
    await a.fill("#rn-termos", "teste");
    await a.click("#rn-estimar");
    await a.waitForFunction(() => /249 consultas/.test(document.querySelector("#msg-rn").textContent), null, { timeout: 15000 });
  });
  await etapa("sem erros de JavaScript (admin)", async () => confere(!a.erros.length, `${a.erros.length} erro(s)`));
} catch (e) {
  falhas++;
  console.log(`FALHOU  preparação: ${String(e?.message || e).split("\n")[0].slice(0, 160)}`);
} finally {
  // ---------- limpeza: nada do teste fica em produção
  await navegador?.close();
  for (const id of [BUSCA, ...criadas]) {
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
