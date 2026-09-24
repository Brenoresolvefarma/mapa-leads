// Capturas da tela (Fase 3a v2): desktop 1366 e celular 390/360, claro e escuro.
//
// Dois modos:
//  - LOCAL (EMULADOR=1, dentro de `firebase emulators:exec`): serve publico/ com testes/servidor-local.mjs e as
//    bibliotecas do node_modules; só para conferência durante o desenvolvimento.
//  - REAL (padrão, no GitHub Actions): abre o SITE informado (ex.: deploy preview) com um login TEMPORÁRIO
//    (apagado no fim). Padrão = usuário comum; com SEMEAR=1 ganha uma busca com leads FICTÍCIOS (apagada no fim):
//    pode ir para o PR. PAPEL=admin + SEM_TARJA=1 = vê as buscas reais sem tarja: SÓ para o Breno, nunca para o
//    repositório (o workflow criptografa essas imagens antes de sair do runner).
// Log público: só nomes dos arquivos gerados e avisos de largura.
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { medirLargura, rotearCdn } from "../testes/rotas-cdn.mjs";
import { carregarFuncoesLocais, rotearApiLocal } from "./api_local.mjs";

const PASTA = process.env.PASTA_CAPTURAS || "docs/capturas/fase3a-v2";
mkdirSync(PASTA, { recursive: true });
const local = process.env.EMULADOR === "1";

/** Busca com leads fictícios (nomes "Exemplo", telefones 90000-000x) em várias microrregiões, para as capturas públicas. */
async function semear(db, uid) {
  const L = [
    ["Home Care Exemplo", "Serviço de home care", "Natal", "Tirol", -5.7945, -35.2110, "sim"], ["Cuidar Exemplo", "Serviço de home care", "Natal", "Lagoa Nova", -5.8200, -35.2150, "sim"],
    ["Vida Exemplo", "Casa de repouso para idosos", "Natal", "Ponta Negra", -5.8800, -35.1700, "sim"], ["Lar Exemplo", "Casa de repouso para idosos", "Natal", "Capim Macio", -5.8600, -35.1950, "sim"],
    ["Saúde Exemplo", "Serviço de home care", "Parnamirim", "Nova Parnamirim", -5.8650, -35.2000, "sim"], ["Bem Estar Exemplo", "Enfermagem domiciliar", "Parnamirim", "Centro", -5.9150, -35.2600, "sim"],
    ["Amparo Exemplo", "Serviço de home care", "Mossoró", "Centro", -5.1880, -37.3440, "sim"], ["Acolher Exemplo", "Casa de repouso para idosos", "Mossoró", "Nova Betânia", -5.1950, -37.3300, "sim"],
    ["Seridó Exemplo", "Serviço de home care", "Caicó", "Centro", -6.4580, -37.0970, "sim"], ["Cuidado Exemplo", "Enfermagem domiciliar", "Currais Novos", "Centro", -6.2610, -36.5170, "sim"],
    ["Loja Exemplo", "Loja de materiais de construção", "Natal", "Alecrim", -5.8050, -35.2200, "sim"], ["Clínica Exemplo", "Serviço de home care", "Macaíba", "Centro", -5.8580, -35.3540, "nao"],
  ];
  const leads = L.map(([nome, categoria, cidade, bairro, latitude, longitude, cidade_confere], i) => ({
    nome, categoria, categorias: [categoria], telefone: `(84) 90000-00${String(i).padStart(2, "0")}`, whatsapp_link: i % 3 === 2 ? "" : `https://wa.me/55849000000${String(i).padStart(2, "0")}`,
    email: "", site: i % 4 ? "" : "https://example.com", instagram: "", endereco: "Rua Exemplo, 100", bairro, cidade, nota: 4 + (i % 9) / 10, qtd_avaliacoes: 7 * i + 3,
    link_maps: "https://maps.google.com", termo_que_encontrou: "home care", cidade_buscada: `${cidade} RN`, cidade_confere, id_lugar: `exemplo-${i}`, latitude, longitude }));
  const cidades = ["Caicó RN", "Currais Novos RN", "Mossoró RN", "Natal RN", "Parnamirim RN"];
  const id = `captura-${randomBytes(4).toString("hex")}`;
  const agora = Date.now();
  await db.doc(`buscas/${id}`).set({ tipo: "comum", lista: true, dono_uid: uid, status: "concluida", criada_em: new Date(agora - 3600000), finalizada_em: new Date(agora - 3000000),
    qtd_lotes: 1, parametros: { termos: ["home care"], cidades }, resumo: { total: leads.length, com_whatsapp: leads.filter((l) => l.whatsapp_link).length } });
  await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: uid, leads });
  const dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await db.doc(`estatisticas/${dia}__${uid}`).set({ dono_uid: uid, buscas: 1, leads: leads.length, com_whatsapp: leads.filter((l) => l.whatsapp_link).length, dia });
  return async () => {
    await db.doc(`buscas/${id}/lotes/0`).delete(); await db.doc(`buscas/${id}`).delete();
    await db.doc(`estatisticas/${dia}__${uid}`).delete(); await db.doc(`usuarios/${uid}`).delete().catch(() => {});
  };
}

let site, limpar = async () => {}, email, senha, funcoesLocais = null;
if (local) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: "demo-mapaleads", FIREBASE_CLIENT_EMAIL: "t@demo-mapaleads.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }), FIREBASE_WEB_API_KEY: "falsa",
  });
  const { iniciarServidor } = await import("../testes/servidor-local.mjs");
  const { firebase } = await import("../netlify/lib/servidor.mjs");
  const { auth, db } = firebase();
  email = "captura@x.example"; senha = "senha-forte-9";
  const u = await auth.createUser({ email, password: senha, displayName: "Breno" }).catch(() => auth.getUserByEmail(email));
  if (process.env.PAPEL === "admin") await auth.setCustomUserClaims(u.uid, { admin: true });
  const apagar = process.env.SEMEAR === "1" ? await semear(db, u.uid) : async () => {};
  const srv = await iniciarServidor();
  site = srv.url;
  limpar = async () => { await apagar(); srv.servidor.close(); };
} else {
  site = (process.argv[2] || "").replace(/\/$/, "");
  const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ credential: cert(conta) }, "capturas");
  const auth = getAuth(app);
  if (process.env.API_LOCAL === "1") funcoesLocais = await carregarFuncoesLocais(conta); // deploy preview sem os secrets
  email = `captura-${randomBytes(4).toString("hex")}@example.com`;
  senha = randomBytes(12).toString("base64url");
  const { uid } = await auth.createUser({ email, password: senha, displayName: "Breno" }); // saudação "Olá, Breno"
  // PAPEL=admin só para as capturas PRIVADAS (vê as buscas reais); o padrão é usuário comum.
  if (process.env.PAPEL === "admin") await auth.setCustomUserClaims(uid, { admin: true });
  const apagar = process.env.SEMEAR === "1" ? await semear(getFirestore(app), uid) : async () => {};
  limpar = async () => { await apagar(); await auth.deleteUser(uid).catch(() => {}); console.log("login temporário e dados de exemplo apagados."); };
}

const navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium" });
const erros = [];
const avisos = [];
try {
  const admin = process.env.PAPEL === "admin";
  // CONJUNTO=celular: só o celular (390 e 360), cada tela nos dois temas, com o APARELHO em modo escuro
  // (prova que o tema claro é o padrão e que o escuro só entra pela escolha do usuário).
  const celular = [["login", null], ["inicio", "inicio"], ["nova-busca-o-que", "nova"], ["nova-busca-onde", "nova", "onde"], ["nova-busca-como", "nova", "como"],
    ["leads", "leads"], ["ficha", "leads", "ficha"], ["mapa-rn", "mapa"], ["mapa-municipio", "mapa/natal/natal"], ["mercado", "mercado"], ["menu", "inicio", "menu"],
    ["ajuda-aberta", "inicio", "ajuda"], ["apagar-confirmacao", "leads", "apagar"], ["logos-saltando", "nova", "comemorar"]];
  const telasCelular = ["claro", "escuro"].flatMap((tema, t) => [
    ...celular.map(([nome, hash, acao], i) => [`${t + 1}${String(i + 1).padStart(2, "0")}-${nome}-390-${tema}`, 390, 844, tema, hash, acao]),
    [`${t + 1}90-inicio-360-${tema}`, 360, 780, tema, "inicio"], [`${t + 1}91-leads-360-${tema}`, 360, 780, tema, "leads"],
  ]);
  // CONJUNTO=planilha: só baixa a planilha .xlsx pela tela (Meus leads → .xlsx → "Baixar .xlsx"), com os leads fictícios.
  const telas = process.env.CONJUNTO === "planilha" ? [["planilha", 1366, 768, "claro", "leads", "planilha"]]
    : process.env.CONJUNTO === "celular" ? telasCelular : [
    // [arquivo, largura, altura, tema, hash, acao]
    ["01-login-1366", 1366, 768, "claro", null],
    ["02-inicio-1366", 1366, 768, "claro", "inicio"],
    ["03-nova-busca-onde-1366", 1366, 768, "claro", "nova", "onde"],
    ["04-leads-1366", 1366, 768, "claro", "leads"],
    ["05-ficha-1366", 1366, 768, "claro", "leads", "ficha"],
    ["06-mapa-rn-1366", 1366, 768, "claro", "mapa"],
    ["07-mapa-microrregiao-1366", 1366, 768, "claro", "mapa/natal"],
    ["08-mapa-municipio-1366", 1366, 768, "claro", "mapa/natal/natal"],
    ["09-mapa-tela-cheia-1366", 1366, 768, "claro", "mapa/natal", "cheia"],
    ["10-mercado-1366", 1366, 768, "claro", "mercado"],
    ["11-mercado-escuro-1366", 1366, 768, "escuro", "mercado"],
    ["12-inicio-escuro-1366", 1366, 768, "escuro", "inicio"],
    ...(admin ? [["13-admin-1366", 1366, 768, "claro", "admin"]] : []),
    ["20-login-390", 390, 844, "claro", null],
    ["21-inicio-390", 390, 844, "claro", "inicio"],
    ["22-nova-busca-390", 390, 844, "claro", "nova"],
    ["23-leads-390", 390, 844, "claro", "leads"],
    ["24-ficha-390", 390, 844, "claro", "leads", "ficha"],
    ["25-mapa-municipio-390", 390, 844, "claro", "mapa/natal/natal"],
    ["26-mercado-390", 390, 844, "claro", "mercado"],
    ["27-inicio-360", 360, 780, "claro", "inicio"],
    ["28-mercado-escuro-390", 390, 844, "escuro", "mercado"],
    ...(admin ? [["29-admin-390", 390, 844, "claro", "admin"]] : []),
  ];
  for (const [arquivo, largura, altura, tema, hash, acao] of telas) {
    const ctx = await navegador.newContext({ viewport: { width: largura, height: altura }, deviceScaleFactor: largura < 500 ? 2 : 1, locale: "pt-BR", acceptDownloads: true,
      colorScheme: largura < 500 ? "dark" : "light", hasTouch: largura < 500, isMobile: largura < 500 });
    if (local) await rotearCdn(ctx);
    if (funcoesLocais) await rotearApiLocal(ctx, site, funcoesLocais);
    // Sem o tour do primeiro acesso.
    await ctx.addInitScript(() => { const o = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mapaleads\.tour\./.test(k) ? "true" : o.call(this, k); }; });
    // Bloqueia a barra de colaboração que o Netlify injeta só nos deploy previews.
    await ctx.route(/netlify-cdp|netlify\.js|app\.netlify\.com\/.*drawer/i, (r) => r.abort());
    // "Logos saltando": a criação da busca é SIMULADA aqui (nenhuma busca real vai para a fila nem roda o motor).
    if (acao === "comemorar") {
      await ctx.route(/\/api\/criar-busca$/, async (r) => {
        if (JSON.parse(r.request().postData() || "{}").simular) return r.fallback();
        r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "captura-simulada", estimativa_seg: 840, restantes_hoje: 19, disparado: false }) });
      });
    }
    const p = await ctx.newPage();
    p.on("pageerror", (e) => erros.push(`${arquivo}: ${e.message}`));
    p.on("dialog", (d) => d.dismiss());
    const mascara = process.env.SEM_TARJA === "1" ? "" : "captura=1";
    // O tema escuro entra pela escolha do usuário (aqui, pelo parâmetro ?tema=escuro, que não fica salvo).
    await p.goto(`${site}/?${mascara}${tema === "escuro" ? "&tema=escuro" : ""}${local ? "&emulador=1" : ""}`);
    await p.addStyleTag({ content: "netlify-drawer, #netlify-drawer, iframe[id*='netlify'], div[id*='netlify-drawer'] { display:none !important; }" }).catch(() => {});
    await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
    if (hash) {
      await p.fill("#le", email); await p.fill("#ls", senha); await p.click("#entrar");
      await p.waitForSelector("#tela-app:not(.oculto)", { timeout: 30000 });
      await p.waitForTimeout(1500);
      await p.evaluate((h) => { location.hash = h; }, hash);
      await p.waitForTimeout(3500); // dados, fontes e mapa
      if (acao === "ficha") {
        const alvo = p.locator(largura < 760 ? "#cartoes [data-i]" : "#tabela-leads tbody tr[data-i]").first();
        if (await alvo.count()) { await alvo.click(); await p.waitForTimeout(1500); }
      }
      if (acao === "onde") {
        await p.fill("#termo-input", "home care"); await p.press("#termo-input", "Enter");
        await p.click("[data-passo-conteudo='1'] [data-ir-passo='2']");
        await p.locator("#regioes input").nth(9).check().catch(() => {});
        await p.waitForTimeout(500);
      }
      if (acao === "como") {
        await p.fill("#termo-input", "home care"); await p.press("#termo-input", "Enter");
        await p.click("[data-passo-conteudo='1'] [data-ir-passo='2']");
        await p.locator("#regioes input").nth(9).check().catch(() => {});
        await p.waitForTimeout(300);
        await p.click("[data-passo-conteudo='2'] [data-ir-passo='3']");
        await p.waitForTimeout(1500);
      }
      if (acao === "ajuda") { await p.locator("#kpis .kpi [data-ajuda]").first().tap(); await p.waitForTimeout(300); }
      if (acao === "apagar") { // só a confirmação: "Voltar" (nada é apagado)
        await p.tap("#abrir-buscas"); await p.locator("#caixa-buscas [data-apagar]").first().tap(); await p.waitForTimeout(400);
      }
      if (acao === "comemorar") {
        await p.fill("#termo-input", "home care"); await p.press("#termo-input", "Enter");
        await p.click("[data-passo-conteudo='1'] [data-ir-passo='2']");
        await p.locator("#regioes input").nth(9).check().catch(() => {});
        await p.waitForTimeout(300);
        await p.click("[data-passo-conteudo='2'] [data-ir-passo='3']");
        await p.waitForTimeout(800);
        await p.tap("#buscar");
        await p.waitForSelector("#comemoracao", { state: "attached", timeout: 10000 });
        await p.waitForTimeout(450); // meio do salto
        await p.screenshot({ path: `${PASTA}/${arquivo}.png` });
        console.log(`${arquivo}.png`);
        await ctx.close();
        continue;
      }
      if (acao === "planilha") {
        await p.click("#baixar-xlsx"); await p.waitForSelector("#confirmacao:not(.oculto)");
        const [arquivo] = await Promise.all([p.waitForEvent("download"), p.click("#conf-sim")]);
        await arquivo.saveAs(`${PASTA}/${arquivo.suggestedFilename()}`);
        console.log(arquivo.suggestedFilename());
        await ctx.close();
        continue;
      }
      if (acao === "menu") { await p.click("#avatar"); await p.waitForTimeout(400); }
      if (acao === "cheia") { await p.click("#mapa-cheio-btn"); await p.waitForTimeout(1500); }
    } else {
      await p.waitForTimeout(1500);
    }
    await p.evaluate(() => document.querySelectorAll("*").forEach((el) => { if (/netlify/i.test(el.tagName) || /netlify-drawer/i.test(el.id)) el.remove(); }));
    await p.screenshot({ path: `${PASTA}/${arquivo}.png` });
    const m = await medirLargura(p);
    if (m.rolagem > m.largura || m.fora.length) avisos.push(arquivo);
    console.log(`${arquivo}.png${m.rolagem > m.largura || m.fora.length ? `  (AVISO: passa da largura: ${m.rolagem}px)` : ""}`);
    await ctx.close();
  }
} finally {
  await navegador.close();
  await limpar();
}
console.log(erros.length ? `Erros de JavaScript: ${erros.length}` : "Sem erros de JavaScript.");
if (local) for (const e of erros) console.log(" -", e.slice(0, 200));
process.exit(erros.length || avisos.length ? 1 : 0);
