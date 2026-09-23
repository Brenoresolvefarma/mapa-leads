// Testes de integração das Netlify Functions contra os EMULADORES do Firebase (Auth + Firestore).
// Dados fictícios. Rodar: npm run test:funcoes   (precisa de Java; o CI já tem)
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { before, test } from "node:test";

// Credenciais FALSAS só para o teste (o emulador não confere assinatura).
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_PROJECT_ID = "demo-mapaleads";
process.env.FIREBASE_CLIENT_EMAIL = "teste@demo-mapaleads.iam.gserviceaccount.com";
// Como no Netlify: quebras de linha guardadas como "\n" literal.
process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
delete process.env.MAPALEADS_GITHUB_TOKEN; // sem disparo real do GitHub

const { default: criarBusca } = await import("../netlify/functions/criar-busca.mjs");
const { default: cancelarBusca } = await import("../netlify/functions/cancelar-busca.mjs");
const { default: adminUsuarios } = await import("../netlify/functions/admin-usuarios.mjs");
const { default: configPublica } = await import("../netlify/functions/config-publica.mjs");
const { firebase } = await import("../netlify/lib/servidor.mjs");

const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const tokens = {};

async function entrar(email, senha) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=falsa`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: senha, returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

function pedido(fn, corpo, token, metodo = "POST") {
  const req = new Request("http://localhost/api/x", {
    method: metodo,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: metodo === "POST" ? JSON.stringify(corpo) : undefined,
  });
  return fn(req).then(async (r) => ({ status: r.status, corpo: await r.json() }));
}

before(async () => {
  await fetch(`http://${FS}/emulator/v1/projects/demo-mapaleads/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH}/emulator/v1/projects/demo-mapaleads/accounts`, { method: "DELETE" });
  const { auth } = firebase();
  const breno = await auth.createUser({ email: "breno@x.example", password: "senha-forte-1" });
  await auth.setCustomUserClaims(breno.uid, { admin: true });
  await auth.createUser({ email: "ana@x.example", password: "senha-forte-2" });
  tokens.breno = await entrar("breno@x.example", "senha-forte-1");
  tokens.ana = await entrar("ana@x.example", "senha-forte-2");
});

test("sem login: 401", async () => {
  const r = await pedido(criarBusca, { termos: "x" });
  assert.equal(r.status, 401);
  assert.equal((await pedido(criarBusca, { termos: "x" }, "token-invalido")).status, 401);
});

test("método errado: 405", async () => {
  const r = await pedido(criarBusca, null, tokens.ana, "GET");
  assert.equal(r.status, 405);
});

test("busca comum: simular não cria nada; criar grava busca, contador e fila", async () => {
  const { db } = firebase();
  const sim = await pedido(criarBusca, { termos: "home care", cidades: "Natal RN", profundidade: "rapida", simular: true }, tokens.ana);
  assert.deepEqual(sim, { status: 200, corpo: { consultas: 1, estimativa_seg: 40 } });
  assert.equal((await db.collection("buscas").get()).size, 0);

  const r = await pedido(criarBusca, { termos: "home care, cuidador", cidades: "Natal RN", profundidade: "rapida" }, tokens.ana);
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  assert.equal(r.corpo.restantes_hoje, 19);
  assert.equal(r.corpo.disparado, false);
  const busca = (await db.doc(`buscas/${r.corpo.id}`).get()).data();
  assert.equal(busca.dono_email, "ana@x.example");
  assert.equal(busca.status, "na_fila");
  assert.equal(busca.tipo, "comum");
  assert.equal(busca.lista, true);
  assert.deepEqual(busca.parametros.termos, ["home care", "cuidador"]);
  const fila = (await db.doc("fila/estado").get()).data();
  assert.deepEqual(fila.itens.map((i) => i.id), [r.corpo.id]);
});

test("limite diário por usuário é respeitado no servidor", async () => {
  const { auth, db } = firebase();
  const ana = await auth.getUserByEmail("ana@x.example");
  await db.doc(`usuarios/${ana.uid}`).set({ limite_diario: 2 }, { merge: true });
  const ok = await pedido(criarBusca, { termos: "a", profundidade: "rapida" }, tokens.ana);
  assert.equal(ok.status, 201);
  const bloqueada = await pedido(criarBusca, { termos: "b", profundidade: "rapida" }, tokens.ana);
  assert.equal(bloqueada.status, 429);
  assert.match(bloqueada.corpo.erro, /Limite diário atingido \(2/);
});

test("busca grande demais para uma execução é recusada", async () => {
  const cidades = Array.from({ length: 40 }, (_, i) => `Cidade ${i}`).join(",");
  const r = await pedido(criarBusca, { termos: "a,b,c,d", cidades, profundidade: "completa", extrair_email: true, simular: true }, tokens.breno);
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /grande demais/);
});

test("RN inteiro: usuário comum recebe 403 (bloqueio no servidor)", async () => {
  const r = await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista" }, tokens.ana);
  assert.equal(r.status, 403);
  const { db } = firebase();
  assert.equal((await db.collection("buscas").where("tipo", "==", "rn_mae").get()).size, 0);
});

test("RN inteiro do admin: simular, criar agendado, mãe + lotes", async () => {
  const { db } = firebase();
  const sim = await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista", simular: true }, tokens.breno);
  assert.equal(sim.status, 200);
  assert.equal(sim.corpo.consultas, 249);

  const r = await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista", agendar_noite: true }, tokens.breno);
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  assert.match(r.corpo.agendada_para, /T01:00:00.000Z$/); // 22h em Fortaleza
  const mae = (await db.doc(`buscas/${r.corpo.id}`).get()).data();
  assert.equal(mae.tipo, "rn_mae");
  assert.equal(mae.total_consultas, 249);
  const filhas = await db.collection("buscas").where("mae_id", "==", r.corpo.id).get();
  assert.equal(filhas.size, r.corpo.lotes);
  const todas = filhas.docs.flatMap((f) => f.data().consultas);
  assert.equal(todas.length, 249);
  assert.ok(filhas.docs.every((f) => f.data().agendada_para && f.data().status === "na_fila" && !f.data().lista));
  const fila = (await db.doc("fila/estado").get()).data();
  assert.equal(fila.aguardando.length, r.corpo.lotes);
  tokens.maeId = r.corpo.id;
});

test("cancelar: dono cancela a própria; não vê a de outro; admin cancela o RN", async () => {
  const { db } = firebase();
  const nova = await pedido(criarBusca, { termos: "pet", profundidade: "rapida" }, tokens.breno);
  const deOutro = await pedido(cancelarBusca, { id: nova.corpo.id }, tokens.ana);
  assert.equal(deOutro.status, 404);
  const propria = await pedido(cancelarBusca, { id: nova.corpo.id }, tokens.breno);
  assert.deepEqual(propria, { status: 200, corpo: { resultado: "cancelada" } });
  assert.equal((await db.doc(`buscas/${nova.corpo.id}`).get()).data().status, "cancelada");
  assert.equal((await pedido(cancelarBusca, { id: nova.corpo.id }, tokens.breno)).status, 409);

  const rn = await pedido(cancelarBusca, { id: tokens.maeId }, tokens.breno);
  assert.equal(rn.status, 200);
  const filhas = await db.collection("buscas").where("mae_id", "==", tokens.maeId).get();
  assert.ok(filhas.docs.every((f) => f.data().status === "cancelada"));
  assert.equal((await db.doc(`buscas/${tokens.maeId}`).get()).data().cancelar_solicitado, true);
});

test("cancelar busca rodando: só pede, o motor para depois", async () => {
  const { db } = firebase();
  await db.doc("buscas/rodando1").set({ tipo: "comum", dono_uid: (await firebase().auth.getUserByEmail("breno@x.example")).uid, status: "rodando" });
  const r = await pedido(cancelarBusca, { id: "rodando1" }, tokens.breno);
  assert.deepEqual(r.corpo, { resultado: "cancelamento_solicitado" });
  assert.equal((await db.doc("buscas/rodando1").get()).data().status, "rodando");
});

test("admin-usuarios: só admin; criar, limitar, listar e remover (buscas ficam)", async () => {
  const { db } = firebase();
  assert.equal((await pedido(adminUsuarios, { acao: "listar" }, tokens.ana)).status, 403);
  assert.equal((await pedido(adminUsuarios, { acao: "criar", email: "caio@x.example", senha: "123" }, tokens.breno)).status, 400);

  const criado = await pedido(adminUsuarios, { acao: "criar", email: "caio@x.example", senha: "senha-forte-3", nome: "Caio" }, tokens.breno);
  assert.equal(criado.status, 201);
  const uid = criado.corpo.uid;
  assert.equal((await pedido(adminUsuarios, { acao: "criar", email: "caio@x.example", senha: "senha-forte-3" }, tokens.breno)).status, 409);

  assert.equal((await pedido(adminUsuarios, { acao: "definir_limite", uid, limite_diario: 5 }, tokens.breno)).status, 200);
  assert.equal((await db.doc(`usuarios/${uid}`).get()).data().limite_diario, 5);
  assert.equal((await pedido(adminUsuarios, { acao: "definir_limite", uid, limite_diario: -1 }, tokens.breno)).status, 400);

  const tokenCaio = await entrar("caio@x.example", "senha-forte-3");
  const buscaCaio = await pedido(criarBusca, { termos: "farmácia", profundidade: "rapida" }, tokenCaio);
  assert.equal(buscaCaio.status, 201);

  const lista = await pedido(adminUsuarios, { acao: "listar" }, tokens.breno);
  assert.equal(lista.corpo.limite_padrao, 20);
  const caio = lista.corpo.usuarios.find((u) => u.uid === uid);
  assert.equal(caio.limite_diario, 5);
  assert.equal(caio.buscas_hoje, 1);
  assert.ok(lista.corpo.usuarios.find((u) => u.email === "breno@x.example").admin);

  const brenoUid = (await firebase().auth.getUserByEmail("breno@x.example")).uid;
  assert.equal((await pedido(adminUsuarios, { acao: "remover", uid: brenoUid }, tokens.breno)).status, 400);
  assert.equal((await pedido(adminUsuarios, { acao: "remover", uid }, tokens.breno)).status, 200);

  // Removido: perde acesso na hora, mas a busca continua e aparece como removido.
  assert.equal((await pedido(criarBusca, { termos: "x" }, tokenCaio)).status, 401);
  assert.equal((await db.doc(`buscas/${buscaCaio.corpo.id}`).get()).exists, true);
  const depois = await pedido(adminUsuarios, { acao: "listar" }, tokens.breno);
  assert.deepEqual(depois.corpo.usuarios.find((u) => u.uid === uid), {
    uid, email: "caio@x.example", nome: "Caio", admin: false, removido: true,
  });
});

test("config pública não expõe segredos", async () => {
  process.env.FIREBASE_WEB_API_KEY = "chave-web-publica";
  const r = await pedido(configPublica, null, null, "GET");
  assert.deepEqual(r.corpo, { apiKey: "chave-web-publica", authDomain: "demo-mapaleads.firebaseapp.com", projectId: "demo-mapaleads" });
  assert.ok(!JSON.stringify(r.corpo).includes("PRIVATE"));
});
