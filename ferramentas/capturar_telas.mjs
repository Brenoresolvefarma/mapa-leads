// Capturas de tela da tela nova (desktop 1440, tablet 768, celular 390/360, claro e escuro).
//
// Dois modos:
//  - LOCAL (EMULADOR=1, dentro de `firebase emulators:exec`): serve publico/ com testes/servidor-local.mjs;
//    usado só para conferência durante o desenvolvimento.
//  - REAL (padrão, no GitHub Actions): abre o SITE informado (ex.: deploy preview) com um login TEMPORÁRIO
//    (apagado no fim). Padrão = usuário comum sem buscas (estados vazios + dados do IBGE): pode ir para o PR.
//    PAPEL=admin + SEM_TARJA=1 = vê as buscas reais sem tarja: SÓ para o Breno, nunca para o repositório
//    (o workflow criptografa essas imagens antes de sair do runner).
// Log público: só nomes dos arquivos gerados.
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";

const PASTA = process.env.PASTA_CAPTURAS || "docs/capturas/etapa0";
const PAGINA = process.env.PAGINA_CAPTURA || "prototipo.html";
mkdirSync(PASTA, { recursive: true });
const local = process.env.EMULADOR === "1";

let site, limpar = async () => {}, email, senha;
if (local) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: "demo-mapaleads", FIREBASE_CLIENT_EMAIL: "t@demo-mapaleads.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }), FIREBASE_WEB_API_KEY: "falsa",
  });
  const { iniciarServidor } = await import("../testes/servidor-local.mjs");
  const { firebase } = await import("../netlify/lib/servidor.mjs");
  const { auth } = firebase();
  email = "captura@x.example"; senha = "senha-forte-9";
  const u = await auth.createUser({ email, password: senha }).catch(() => auth.getUserByEmail(email));
  if (process.env.SEMEAR === "1") {
    // Só para conferência LOCAL do layout (emulador): leads fictícios, nunca publicados.
    const { db } = firebase();
    const nomes = ["Clínica Exemplo", "Home Care Exemplo", "Cuidar Exemplo", "Vida Exemplo", "Saúde Exemplo", "Lar Exemplo"];
    const cidades = [["Natal", "Tirol"], ["Natal", "Lagoa Nova"], ["Parnamirim", "Nova Parnamirim"], ["Mossoró", "Centro"], ["Caicó", "Centro"], ["Natal", "Ponta Negra"]];
    const leadsF = nomes.map((n, i) => ({ nome: n, categoria: "Serviço de saúde", telefone: `(84) 90000-000${i}`, whatsapp_link: i % 2 ? "" : "https://wa.me/5584900000000",
      site: i % 3 ? "" : "https://example.com", endereco: "Rua Exemplo, 1", bairro: cidades[i][1], cidade: cidades[i][0], nota: 4 + (i % 10) / 10, qtd_avaliacoes: 10 * i + 3,
      link_maps: "https://maps.google.com", termo_que_encontrou: "home care", cidade_buscada: "Natal RN", cidade_confere: i === 2 ? "nao" : "sim", id_lugar: `x${i}` }));
    await db.doc("buscas/exemplo1").set({ tipo: "comum", lista: true, dono_uid: u.uid, status: "concluida", criada_em: new Date(), qtd_lotes: 1,
      parametros: { termos: ["home care"], cidades: ["Natal RN"] }, resumo: { total: 6, com_whatsapp: 3 } });
    await db.doc("buscas/exemplo1/lotes/0").set({ dono_uid: u.uid, leads: leadsF });
    await db.doc("buscas/exemplo2").set({ tipo: "comum", lista: true, dono_uid: u.uid, status: "rodando", progresso: "2/4", criada_em: new Date(), parametros: { termos: ["clínica"], cidades: ["Mossoró RN"] } });
  }
  const srv = await iniciarServidor();
  site = srv.url;
  limpar = async () => srv.servidor.close();
} else {
  site = (process.argv[2] || "").replace(/\/$/, "");
  const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth(initializeApp({ credential: cert(conta) }, "capturas"));
  email = `captura-${randomBytes(4).toString("hex")}@example.com`;
  senha = randomBytes(12).toString("base64url");
  const { uid } = await auth.createUser({ email, password: senha });
  // PAPEL=admin só para as capturas PRIVADAS (vê as buscas reais); o padrão é usuário comum sem dados.
  if (process.env.PAPEL === "admin") await auth.setCustomUserClaims(uid, { admin: true });
  limpar = async () => { await auth.deleteUser(uid).catch(() => {}); console.log("login temporário apagado."); };
}

const navegador = await chromium.launch({ executablePath: process.env.NAVEGADOR || "/opt/pw-browsers/chromium" });
const erros = [];
try {
  const telas = [
    // [arquivo, largura, altura, tema, hash, acao]
    ["01-login-desktop", 1440, 900, "claro", null],
    ["02-inicio-desktop", 1440, 1000, "claro", "inicio"],
    ["03-leads-desktop", 1440, 1000, "claro", "leads"],
    ["04-ficha-desktop", 1440, 1000, "claro", "leads", "ficha"],
    ["05-mercado-desktop", 1440, 1000, "claro", "mercado"],
    ["06-mercado-escuro", 1440, 1000, "escuro", "mercado"],
    ["07-inicio-escuro", 1440, 1000, "escuro", "inicio"],
    ["08-leads-celular-390", 390, 844, "claro", "leads"],
    ["09-ficha-celular-390", 390, 844, "claro", "leads", "ficha"],
    ["10-inicio-celular-360", 360, 780, "claro", "inicio"],
    ["11-mercado-celular-escuro", 390, 844, "escuro", "mercado"],
    ["12-login-celular", 390, 844, "claro", null],
    ["13-leads-tablet-768", 768, 1024, "claro", "leads"],
  ];
  for (const [arquivo, largura, altura, tema, hash, acao] of telas) {
    const ctx = await navegador.newContext({ viewport: { width: largura, height: altura }, deviceScaleFactor: 1, locale: "pt-BR",
      colorScheme: tema === "escuro" ? "dark" : "light" });
    if (local) {
      await ctx.route("https://www.gstatic.com/firebasejs/**", (r) =>
        r.fulfill({ path: `node_modules/firebase/${new URL(r.request().url()).pathname.split("/").pop()}`, contentType: "text/javascript" }));
    }
    // Bloqueia a barra de colaboração que o Netlify injeta só nos deploy previews.
    await ctx.route(/netlify-cdp|netlify\.js|app\.netlify\.com\/.*drawer/i, (r) => r.abort());
    const p = await ctx.newPage();
    p.on("pageerror", (e) => erros.push(`${arquivo}: ${e.message}`));
    const mascara = process.env.SEM_TARJA === "1" ? "" : "captura=1";
    const url = `${site}/${PAGINA}?${mascara}${local ? "&emulador=1" : ""}`;
    await p.goto(url);
    // Esconde a barra de colaboração que o Netlify injeta só nos deploy previews.
    await p.addStyleTag({ content: "netlify-drawer, #netlify-drawer, iframe[id*='netlify'], div[id*='netlify-drawer'] { display:none !important; }" }).catch(() => {});
    await p.waitForSelector("#entrar:not([disabled])", { timeout: 30000 });
    if (hash) {
      await p.fill("#le", email); await p.fill("#ls", senha); await p.click("#entrar");
      await p.waitForSelector("#tela-app:not(.oculto)", { timeout: 30000 });
      await p.evaluate((h) => { location.hash = h; }, hash);
      await p.waitForTimeout(3500); // dados, fontes e mapa
      if (acao === "ficha") {
        const alvo = p.locator(largura < 760 ? "#cartoes [data-i]" : "#tbody tr[data-i]").first();
        if (await alvo.count()) { await alvo.click(); await p.waitForTimeout(500); }
      }
    } else {
      await p.waitForTimeout(1500);
    }
    await p.evaluate(() => document.querySelectorAll("*").forEach((el) => { if (/netlify/i.test(el.tagName) || /netlify-drawer/i.test(el.id)) el.remove(); }));
    await p.screenshot({ path: `${PASTA}/${arquivo}.png`, fullPage: !acao && largura > 760 });
    // Sem rolagem horizontal em nenhuma largura.
    const rolaLado = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    console.log(`${arquivo}.png${rolaLado ? "  (AVISO: rolagem horizontal)" : ""}`);
    await ctx.close();
  }
} finally {
  await navegador.close();
  await limpar();
}
console.log(erros.length ? `Erros de JavaScript: ${erros.length}` : "Sem erros de JavaScript.");
if (local) for (const e of erros) console.log(" -", e.slice(0, 200));
process.exit(erros.length ? 1 : 0);
