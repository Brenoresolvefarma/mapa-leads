// Teste REAL das EQUIPES em PRODUÇÃO (workflow "Testar tela em produção", modo "equipes").
// Cria contas TEMPORÁRIAS — 1 master, 2 gestores e 3 prepostos em 2 equipes de teste — e buscas/CRM/carteira FICTÍCIOS,
// e confere o que cada papel enxerga de verdade:
//  1. regras do Firestore publicadas (leitura direta com o token de cada um, pela API REST do Firestore);
//  2. Functions no ar (403 entre equipes);
//  3. a tela no celular (selo e listas de buscas).
// Tudo é apagado no final, mesmo se falhar. Log público: só OK/FALHOU por etapa (nunca e-mails, uids, senhas ou tokens).
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const SITE = (process.argv[2] || "https://mapaleads-rn.netlify.app").replace(/\/$/, "");
const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!conta.private_key) { console.log("ERRO: secret FIREBASE_SERVICE_ACCOUNT ausente."); process.exit(1); }
const app = initializeApp({ credential: cert(conta) }, "teste-equipes");
const auth = getAuth(app), db = getFirestore(app);
const suf = randomBytes(4).toString("hex");
const EQA = `teste-eqa-${suf}`, EQB = `teste-eqb-${suf}`;
const senha = () => randomBytes(12).toString("base64url");
const U = {
  master: { claims: { admin: true, papel: "master", equipe_id: "resolve-farma" }, equipe: "resolve-farma", papel: "master" },
  gestorA: { claims: { papel: "gestor", equipe_id: EQA }, equipe: EQA, papel: "gestor", nome: "Gestor Teste A" },
  prepA1: { claims: { papel: "vendedor", equipe_id: EQA }, equipe: EQA, papel: "vendedor", nome: "Preposto Teste A1" },
  prepA2: { claims: { papel: "vendedor", equipe_id: EQA }, equipe: EQA, papel: "vendedor", nome: "Preposto Teste A2" },
  gestorB: { claims: { papel: "gestor", equipe_id: EQB }, equipe: EQB, papel: "gestor", nome: "Gestor Teste B" },
  prepB1: { claims: { papel: "vendedor", equipe_id: EQB }, equipe: EQB, papel: "vendedor", nome: "Preposto Teste B1" },
};
const B = { a1: `teste-eq-a1-${suf}`, a2: `teste-eq-a2-${suf}`, b1: `teste-eq-b1-${suf}`, m: `teste-eq-m-${suf}` };
let falhas = 0;
const etapa = async (nome, fn) => {
  try { await fn(); console.log(`OK      ${nome}`); }
  catch (e) { falhas++; console.log(`FALHOU  ${nome}: ${String(e?.message || e).split("\n")[0].slice(0, 180)}`); }
};
const confere = (cond, msg) => { if (!cond) throw new Error(msg); };

let navegador;
try {
  const cfg = await (await fetch(`${SITE}/api/config-publica`)).json();
  confere(cfg.apiKey && cfg.projectId, "config-publica sem apiKey/projectId");
  const FS = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;

  // ---------- preparação (Admin SDK): contas, equipes, buscas, CRM e carteira fictícios
  for (const [k, u] of Object.entries(U)) {
    u.email = `teste-eq-${k.toLowerCase()}-${suf}@example.com`; u.senha = senha();
    u.uid = (await auth.createUser({ email: u.email, password: u.senha, displayName: u.nome })).uid;
    await auth.setCustomUserClaims(u.uid, u.claims);
    await db.doc(`usuarios/${u.uid}`).set({ email: u.email, nome: u.nome || "", papel: u.papel, equipe_id: u.equipe, ativo: true, removido: false });
  }
  for (const [id, nome, g] of [[EQA, "Equipe Teste A", U.gestorA], [EQB, "Equipe Teste B", U.gestorB]]) {
    await db.doc(`equipes/${id}`).set({ nome, ativa: true, gestor_uid: g.uid, cotas: { max_usuarios: 10, buscas_dia: 100, consultas_mes: 6000 }, uso: {}, representadas: [], criada_em: new Date() });
  }
  const busca = async (id, dono, equipe, termo) => {
    await db.doc(`buscas/${id}`).set({ tipo: "comum", lista: true, dono_uid: dono.uid, dono_email: dono.email, equipe_id: equipe, status: "concluida",
      criada_em: new Date(), finalizada_em: new Date(), parametros: { termos: [termo], cidades: ["Natal RN"] }, qtd_lotes: 1, resumo: { total: 1 } });
    await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono.uid, equipe_id: equipe, leads: [{ nome: `Fictício ${termo}`, cidade: "Natal", id_lugar: `x-${id}` }] });
  };
  await busca(B.a1, U.prepA1, EQA, "termo-a1");
  await busca(B.a2, U.prepA2, EQA, "termo-a2");
  await busca(B.b1, U.prepB1, EQB, "termo-b1");
  await busca(B.m, U.master, "_master", "termo-master");
  for (const [u, eq] of [[U.prepA1, EQA], [U.prepB1, EQB]]) {
    await db.doc(`crm/${u.uid}__03`).set({ dono_uid: u.uid, equipe_id: eq, leads: { p_x: { s: "contatado", em: Date.now(), h: [] } } });
    await db.doc(`carteira/${eq}__03`).set({ leads: { p_x: { uid: u.uid, nome: u.nome, s: "contatado", desde: Date.now(), ultimo: Date.now() } } });
  }

  // Tokens de verdade (login e-mail/senha no Firebase Auth de produção, com as claims)
  for (const u of Object.values(U)) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${cfg.apiKey}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.senha, returnSecureToken: true }) });
    u.token = (await r.json()).idToken;
    confere(u.token, "login temporário falhou");
  }
  const ler = async (u, caminho) => (await fetch(`${FS}/${caminho}`, { headers: { authorization: `Bearer ${u.token}` } })).status;
  const consulta = async (u, campo, valor) => (await fetch(`${FS}:runQuery`, { method: "POST", headers: { authorization: `Bearer ${u.token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "buscas" }], where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "lista" }, op: "EQUAL", value: { booleanValue: true } } },
      { fieldFilter: { field: { fieldPath: campo }, op: "EQUAL", value: { stringValue: valor } } }] } }, limit: 10 } }) })).status;
  // Matriz: 200 = lê; 403 = negado pelas regras
  const matriz = async (u, esperado) => {
    const erradas = [];
    for (const [caminho, quer] of Object.entries(esperado)) { const st = await ler(u, caminho); if ((st === 200) !== quer) erradas.push(`${caminho.split("/")[0]}… esperava ${quer ? "ler" : "negado"}, veio ${st}`); }
    confere(!erradas.length, erradas.join("; "));
  };
  const docs = (extra = {}) => ({
    [`buscas/${B.a1}`]: false, [`buscas/${B.a1}/lotes/0`]: false, [`buscas/${B.a2}`]: false, [`buscas/${B.b1}`]: false, [`buscas/${B.b1}/lotes/0`]: false,
    [`buscas/${B.m}`]: false, [`crm/${U.prepA1.uid}__03`]: false, [`crm/${U.prepB1.uid}__03`]: false, [`carteira/${EQA}__03`]: false, [`carteira/${EQB}__03`]: false,
    [`usuarios/${U.prepA1.uid}`]: false, [`usuarios/${U.prepB1.uid}`]: false, [`equipes/${EQA}`]: false, [`equipes/${EQB}`]: false, ...extra });

  // ---------- 1. regras publicadas
  await etapa("regras: master lê tudo (as duas equipes e a área dele)", () => matriz(U.master, Object.fromEntries(Object.keys(docs()).map((k) => [k, true]))));
  await etapa("regras: gestor A lê só a equipe A (buscas dos prepostos, CRM, carteira, usuários); nada da B nem do master", () => matriz(U.gestorA, docs({
    [`buscas/${B.a1}`]: true, [`buscas/${B.a1}/lotes/0`]: true, [`buscas/${B.a2}`]: true, [`crm/${U.prepA1.uid}__03`]: true, [`carteira/${EQA}__03`]: true,
    [`usuarios/${U.prepA1.uid}`]: true, [`equipes/${EQA}`]: true })));
  await etapa("regras: preposto A1 lê só o que é dele (nem a busca do colega da mesma equipe) e a carteira da equipe A", () => matriz(U.prepA1, docs({
    [`buscas/${B.a1}`]: true, [`buscas/${B.a1}/lotes/0`]: true, [`crm/${U.prepA1.uid}__03`]: true, [`carteira/${EQA}__03`]: true,
    [`usuarios/${U.prepA1.uid}`]: true, [`equipes/${EQA}`]: true })));
  await etapa("regras: preposto B1 não vê nada da equipe A (buscas, CRM, carteira) nem do master", () => matriz(U.prepB1, docs({
    [`buscas/${B.b1}`]: true, [`buscas/${B.b1}/lotes/0`]: true, [`crm/${U.prepB1.uid}__03`]: true, [`carteira/${EQB}__03`]: true,
    [`usuarios/${U.prepB1.uid}`]: true, [`equipes/${EQB}`]: true })));
  await etapa("regras: lista de buscas — gestor A consulta a equipe A (200) e é negado na B (403); preposto não lista a equipe", async () => {
    confere(await consulta(U.gestorA, "equipe_id", EQA) === 200, "gestor A não conseguiu listar a equipe A");
    confere(await consulta(U.gestorA, "equipe_id", EQB) === 403, "gestor A listou a equipe B");
    confere(await consulta(U.prepA1, "equipe_id", EQA) === 403, "preposto listou a equipe inteira");
  });
  await etapa("regras: ninguém grava pelo navegador (gestor tentando mudar a carteira da própria equipe)", async () => {
    const r = await fetch(`${FS}/carteira/${EQA}__03?updateMask.fieldPaths=leads`, { method: "PATCH", headers: { authorization: `Bearer ${U.gestorA.token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { leads: { mapValue: { fields: {} } } } }) });
    confere(r.status === 403, `gravação veio ${r.status}`);
  });

  // ---------- 2. Functions no ar
  const api = async (u, fn, corpo) => (await fetch(`${SITE}/api/${fn}`, { method: "POST", headers: { authorization: `Bearer ${u.token}`, "content-type": "application/json" }, body: JSON.stringify(corpo) })).status;
  await etapa("Functions: gestor A abre a própria equipe (200) e recebe 403 na equipe B", async () => {
    confere(await api(U.gestorA, "equipe", { acao: "resumo" }) === 200, "resumo da própria equipe");
    confere(await api(U.gestorA, "equipe", { acao: "resumo", equipe_id: EQB }) === 403, "resumo da equipe B");
    confere(await api(U.gestorA, "equipe", { acao: "editar_preposto", equipe_id: EQB, uid: U.prepB1.uid, nome: "x" }) === 403, "editar preposto da B");
  });
  await etapa("Functions: gestor A não mexe em busca da equipe B (liberar/apagar → 403) nem na aba Equipes", async () => {
    confere(await api(U.gestorA, "liberar-busca", { acao: "simular", id: B.b1 }) === 403, "liberar busca da B");
    confere(await api(U.gestorA, "apagar-busca", { id: B.b1 }) === 403, "apagar busca da B");
    confere(await api(U.gestorA, "equipes", { acao: "listar" }) === 403, "aba Equipes do master");
  });
  await etapa("Functions: preposto não abre 'Minha equipe' (403); master abre qualquer equipe (200)", async () => {
    confere(await api(U.prepA1, "equipe", { acao: "resumo" }) === 403, "preposto abriu Minha equipe");
    confere(await api(U.master, "equipe", { acao: "resumo", equipe_id: EQB }) === 200, "master não abriu a equipe B");
    confere(await api(U.master, "equipes", { acao: "listar" }) === 200, "master não listou as equipes");
  });

  // ---------- 3. tela no celular (390 px)
  navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/usr/bin/google-chrome" });
  const abrir = async (u) => {
    const ctx = await navegador.newContext({ locale: "pt-BR", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
    const p = await ctx.newPage();
    p.erros = []; p.on("pageerror", (e) => p.erros.push(e.message));
    await p.goto(SITE);
    await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
    await p.fill("#le", u.email); await p.fill("#ls", u.senha); await p.click("#entrar");
    await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)", { timeout: 30000 });
    return p;
  };
  const esperar = (pg, sel, re) => pg.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), [sel, re.source], { timeout: 20000 });
  const textoCaixa = async (p) => { await p.evaluate(() => { location.hash = "#leads"; }); await p.click("#abrir-buscas"); await p.waitForSelector("#caixa-buscas:not(.oculto)"); return p.textContent("#caixa-buscas"); };
  await etapa("tela: gestor A vê 'gestor · Equipe Teste A', as buscas dos 2 prepostos dele e nenhuma da equipe B", async () => {
    const p = await abrir(U.gestorA);
    await esperar(p, "#selo-equipe", /^gestor · Equipe Teste A$/);
    confere(await p.locator("#barra-inferior a[data-ir=equipe]").count() === 1, "sem 'Equipe' na barra de baixo");
    const t = await textoCaixa(p);
    confere(/termo-a1/.test(t) && /termo-a2/.test(t), "faltou busca da equipe A");
    confere(!/termo-b1|termo-master/.test(t), "apareceu busca de outra equipe/do master");
    confere(!p.erros.length, `erros de JavaScript: ${p.erros.length}`);
    await p.context().close();
  });
  await etapa("tela: preposto A1 vê 'vendedor · Equipe Teste A' e só a busca dele", async () => {
    const p = await abrir(U.prepA1);
    await esperar(p, "#selo-equipe", /^vendedor · Equipe Teste A$/);
    const t = await textoCaixa(p);
    confere(/termo-a1/.test(t), "faltou a busca dele");
    confere(!/termo-a2|termo-b1|termo-master/.test(t), "apareceu busca que não é dele");
    confere(!(await p.locator("#menu [data-ir=equipes], #menu [data-ir=admin], #barra-inferior a[data-ir=equipe]").count()), "menu de gestor/master visível");
    await p.context().close();
  });
  await etapa("tela: master vê o selo 'master' e as duas equipes na aba Equipes", async () => {
    const p = await abrir(U.master);
    await p.waitForSelector("#selo:not(.oculto)", { timeout: 20000 });
    await p.evaluate(() => { location.hash = "#equipes"; });
    await esperar(p, "#equipes-tabela", /Equipe Teste A[\s\S]*Equipe Teste B|Equipe Teste B[\s\S]*Equipe Teste A/);
    await p.context().close();
  });
} catch (e) {
  falhas++;
  console.log(`FALHOU  preparação: ${String(e?.message || e).split("\n")[0].slice(0, 160)}`);
} finally {
  await navegador?.close().catch(() => {});
  // Limpeza: buscas (com lotes), CRM, carteira, equipes, usuários e contas temporárias.
  for (const id of Object.values(B)) await db.recursiveDelete(db.doc(`buscas/${id}`)).catch(() => {});
  for (const eq of [EQA, EQB]) { await db.doc(`carteira/${eq}__03`).delete().catch(() => {}); await db.doc(`equipes/${eq}`).delete().catch(() => {}); }
  for (const u of Object.values(U)) {
    if (!u.uid) continue;
    await db.doc(`crm/${u.uid}__03`).delete().catch(() => {});
    await db.doc(`usuarios/${u.uid}`).delete().catch(() => {});
    await auth.deleteUser(u.uid).catch(() => {});
  }
  console.log("Limpeza feita: contas, equipes, buscas, CRM e carteira de teste apagados.");
}
console.log(falhas ? `${falhas} etapa(s) falharam.` : "Todas as etapas passaram.");
process.exit(falhas ? 1 : 0);
