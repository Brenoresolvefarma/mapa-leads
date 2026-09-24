// Diagnóstico e prova da COMEMORAÇÃO no site publicado (workflow "Capturas da tela", conjunto "comemoracao").
// Abre o site de verdade (Chrome), com 2 logins TEMPORÁRIOS (um vendedor novo e um master), e cria busca pela tela.
// A criação em si é SIMULADA (a rota /api/criar-busca com simular=false é interceptada e responde "criada"): nada entra na
// fila e o motor não roda. As estimativas (simular=true) vão para o servidor real.
// Para cada cenário mede, dentro da página: quando o canvas #comemoracao entrou/saiu, quantos logos foram desenhados,
// quantos quadros e as tarefas longas (tela travada) depois do clique. Log público: SÓ esses números.
// Vídeos (só do vendedor novo, que não tem dado real nenhum) vão para PASTA_CAPTURAS.
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const SITE = (process.argv[2] || "https://mapaleads-rn.netlify.app").replace(/\/$/, "");
const PASTA = process.env.PASTA_CAPTURAS || "capturas-comemoracao";
mkdirSync(PASTA, { recursive: true });
const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!conta.private_key) { console.log("ERRO: secret FIREBASE_SERVICE_ACCOUNT ausente."); process.exit(1); }
const app = initializeApp({ credential: cert(conta) }, "diag-comemoracao");
const auth = getAuth(app), db = getFirestore(app);
const sufixo = randomBytes(4).toString("hex");
const contas = {
  vendedor: { email: `diag-com-v-${sufixo}@example.com`, senha: randomBytes(12).toString("base64url"), nome: "Vendedor Teste" },
  master: { email: `diag-com-m-${sufixo}@example.com`, senha: randomBytes(12).toString("base64url"), nome: "Master Teste" },
};
let falhas = 0;

// Instrumentos dentro da página (antes de qualquer script do site).
const INSTRUMENTOS = () => {
  const t = () => Math.round(performance.now());
  const C = (window.__com = { eventos: [], desenhos: 0, quadros: new Set(), longas: [], clique: 0 });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) C.longas.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
  const orig = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) {
    if (this.canvas && this.canvas.id === "comemoracao") { C.desenhos++; C.quadros.add(Math.round(performance.now() / 8)); }
    return orig.apply(this, a);
  };
  const olhar = () => new MutationObserver((ms) => {
    for (const m of ms) {
      for (const n of m.addedNodes) if (n.id === "comemoracao") C.eventos.push(["entrou", t(), n.dataset.modo || "", n.dataset.pecas || ""]);
      for (const n of m.removedNodes) if (n.id === "comemoracao") C.eventos.push(["saiu", t()]);
    }
  }).observe(document.body, { childList: true, subtree: true });
  if (document.body) olhar(); else document.addEventListener("DOMContentLoaded", olhar);
};

const navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/usr/bin/google-chrome" });
async function abrir(u, { largura, reduzir = false, video = "" }) {
  const cel = largura < 500;
  const viewport = cel ? { width: 390, height: 844 } : { width: 1366, height: 768 };
  const ctx = await navegador.newContext({ locale: "pt-BR", viewport, hasTouch: cel, isMobile: cel, deviceScaleFactor: cel ? 2 : 1,
    reducedMotion: reduzir ? "reduce" : "no-preference", ...(video ? { recordVideo: { dir: PASTA, size: viewport } } : {}) });
  await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
  await ctx.addInitScript(INSTRUMENTOS);
  // Criação simulada: nada vai para a fila.
  await ctx.route("**/api/criar-busca", async (r) => {
    let corpo = {}; try { corpo = r.request().postDataJSON() || {}; } catch {}
    if (corpo.simular) return r.continue();
    await new Promise((ok) => setTimeout(ok, 300));
    return r.fulfill({ json: { ok: true, id: `diag-${sufixo}`, estimativa_seg: 900, restantes_hoje: 19, consultas: 249, lotes: 11, agendada_para: null } });
  });
  const p = await ctx.newPage();
  p.erros = [];
  p.on("pageerror", (e) => p.erros.push(String(e.message).slice(0, 120)));
  await p.goto(SITE);
  await p.waitForSelector("#entrar:not([disabled])", { timeout: 45000 });
  await p.fill("#le", u.email); await p.fill("#ls", u.senha); await p.click("#entrar");
  await p.waitForSelector("#tela-app:not(.oculto) [data-pagina=inicio]:not(.oculto)", { timeout: 45000 });
  await p.waitForTimeout(2500); // dados do Início chegando (como um usuário de verdade)
  return p;
}
const toque = (p, sel) => (p.viewportSize().width < 500 ? p.locator(sel).first().tap() : p.locator(sel).first().click());
async function novaBusca(p) {
  await p.evaluate(() => { location.hash = "#nova"; });
  await p.waitForSelector("#termo-input");
  await p.fill("#termo-input", "pet shop"); await p.press("#termo-input", "Enter");
  await toque(p, "[data-passo-conteudo='1'] [data-ir-passo='2']");
  await p.$eval("#regioes input[data-regiao='24018']", (e) => e.closest("label").scrollIntoView({ block: "center" }));
  await p.check("#regioes input[data-regiao='24018']");
  await toque(p, "[data-passo-conteudo='2'] [data-ir-passo='3']");
  await p.waitForTimeout(1200); // estimativa
  await p.evaluate(() => { window.__com.clique = Math.round(performance.now()); });
  await toque(p, "#buscar");
}
async function estadoInteiro(p, uf) {
  await p.evaluate(() => { location.hash = "#admin"; });
  await p.waitForSelector("#rn-uf");
  await p.selectOption("#rn-uf", uf);
  await p.fill("#rn-termos", "farmácia");
  await toque(p, "#rn-estimar");
  await p.waitForSelector("#rn-confirmar:not([disabled])", { timeout: 20000 });
  await p.evaluate(() => { window.__com.clique = Math.round(performance.now()); });
  await toque(p, "#rn-confirmar");
}
async function medir(nome, p) {
  await p.waitForTimeout(5000);
  const r = await p.evaluate(() => {
    const C = window.__com, depois = (x) => x - C.clique;
    const entrou = C.eventos.find((e) => e[0] === "entrou"), saiu = C.eventos.find((e) => e[0] === "saiu");
    const longas = C.longas.filter(([ini, dur]) => ini + dur >= C.clique);
    return {
      apareceu: !!entrou, entrou_ms: entrou ? depois(entrou[1]) : null, modo: entrou?.[2] || "", pecas: entrou?.[3] || "",
      durou_ms: entrou && saiu ? saiu[1] - entrou[1] : null, desenhos: C.desenhos, quadros: C.quadros.size,
      tarefas_longas: longas.length, maior_trava_ms: Math.max(0, ...longas.map((l) => l[1])), trava_total_ms: longas.reduce((s, l) => s + l[1], 0),
      reduzir: matchMedia("(prefers-reduced-motion: reduce)").matches,
      mensagem: [...document.querySelectorAll("#toasts .toast")].some((t) => /Te aviso quando os leads chegarem/.test(t.textContent)),
    };
  });
  const ok = r.apareceu && r.quadros >= 20;
  if (!ok) falhas++;
  console.log(`${ok ? "OK    " : "FALHOU"} ${nome}: ${JSON.stringify({ ...r, erros: p.erros.length })}`);
  return r;
}
async function fecharComVideo(p, arquivo) {
  const v = p.video();
  await p.context().close();
  if (v && arquivo) { const origem = await v.path(); renameSync(origem, join(PASTA, arquivo)); }
}

try {
  const v = await auth.createUser({ email: contas.vendedor.email, password: contas.vendedor.senha, displayName: contas.vendedor.nome });
  const m = await auth.createUser({ email: contas.master.email, password: contas.master.senha, displayName: contas.master.nome });
  contas.vendedor.uid = v.uid; contas.master.uid = m.uid;
  await auth.setCustomUserClaims(m.uid, { admin: true, papel: "master", equipe_id: "_master" });

  // Vendedor novo (sem dado real): vídeos no PC e no celular.
  for (const [nome, largura, reduzir, video] of [
    ["vendedor 1366 Nova busca", 1366, false, "comemoracao-pc.webm"],
    ["vendedor 390 Nova busca", 390, false, "comemoracao-celular.webm"],
    ["vendedor 390 Nova busca (reduzir movimento)", 390, true, "comemoracao-celular-reduzir-movimento.webm"],
  ]) {
    let p;
    try { p = await abrir(contas.vendedor, { largura, reduzir, video }); await novaBusca(p); await medir(nome, p); }
    catch (e) { falhas++; console.log(`FALHOU ${nome}: ${String(e.message).split("\n")[0].slice(0, 140)}`); }
    if (p) await fecharComVideo(p, video).catch(() => {});
  }
  // Master (vê as buscas de todos — por isso SEM vídeo e SEM captura; só números).
  for (const [nome, largura, fazer] of [
    ["master 1366 Nova busca", 1366, (p) => novaBusca(p)],
    ["master 1366 Estado inteiro RN", 1366, (p) => estadoInteiro(p, "RN")],
    ["master 390 Estado inteiro PB", 390, (p) => estadoInteiro(p, "PB")],
  ]) {
    let p;
    try { p = await abrir(contas.master, { largura }); await fazer(p); await medir(nome, p); }
    catch (e) { falhas++; console.log(`FALHOU ${nome}: ${String(e.message).split("\n")[0].slice(0, 140)}`); }
    if (p) await p.context().close().catch(() => {});
  }
} finally {
  await navegador.close().catch(() => {});
  for (const u of Object.values(contas)) if (u.uid) { await db.doc(`usuarios/${u.uid}`).delete().catch(() => {}); await auth.deleteUser(u.uid).catch(() => {}); }
  console.log("logins temporários apagados.");
}
console.log(falhas ? `${falhas} cenário(s) sem comemoração visível` : "comemoração visível em todos os cenários");
process.exit(falhas ? 1 : 0);
