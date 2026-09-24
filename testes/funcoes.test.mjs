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

// Com FUNCOES_EMPACOTADAS, testa o código já empacotado como o Netlify faz (npm run test:empacotadas).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const EMPACOTADAS = process.env.FUNCOES_EMPACOTADAS;
const funcao = (nome) => EMPACOTADAS
  ? pathToFileURL(resolve(EMPACOTADAS, nome, "netlify/functions", `${nome}.mjs`)).href
  : `../netlify/functions/${nome}.mjs`;
const { default: criarBusca } = await import(funcao("criar-busca"));
const { default: cancelarBusca } = await import(funcao("cancelar-busca"));
const { default: apagarBusca } = await import(funcao("apagar-busca"));
const { default: adminUsuarios } = await import(funcao("admin-usuarios"));
const { default: configPublica } = await import(funcao("config-publica"));
const { default: perfis } = await import(funcao("perfis"));
const { default: saudeMotor } = await import(funcao("saude-motor"));
const { acordar } = await import(funcao("despertador"));
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

  // Uso da semana: soma estatisticas/{dia}__{uid} dos últimos 7 dias (o de 8 dias atrás não entra).
  const dia = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - n * 86400000));
  await db.doc(`estatisticas/${dia(0)}__${uid}`).set({ dono_uid: uid, buscas: 1, leads: 10, com_whatsapp: 4 });
  await db.doc(`estatisticas/${dia(3)}__${uid}`).set({ dono_uid: uid, buscas: 2, leads: 5, com_whatsapp: 1 });
  await db.doc(`estatisticas/${dia(8)}__${uid}`).set({ dono_uid: uid, buscas: 9, leads: 99, com_whatsapp: 9 });
  const lista = await pedido(adminUsuarios, { acao: "listar" }, tokens.breno);
  assert.equal(lista.corpo.limite_padrao, 20);
  const caio = lista.corpo.usuarios.find((u) => u.uid === uid);
  assert.equal(caio.limite_diario, 5);
  assert.equal(caio.buscas_hoje, 1);
  assert.deepEqual(caio.semana, { buscas: 3, leads: 15, com_whatsapp: 5 });
  assert.equal(caio.nome, "Caio");
  // Nome (saudação "Olá, ..."): só o admin muda; espaços limpos e no máximo 60 caracteres.
  assert.equal((await pedido(adminUsuarios, { acao: "definir_nome", uid, nome: "Ana" }, tokens.ana)).status, 403);
  const renomeado = await pedido(adminUsuarios, { acao: "definir_nome", uid, nome: "  Caio   Souza  " }, tokens.breno);
  assert.equal(renomeado.status, 200);
  assert.equal((await db.doc(`usuarios/${uid}`).get()).data().nome, "Caio Souza");
  assert.equal((await firebase().auth.getUser(uid)).displayName, "Caio Souza");
  assert.equal((await pedido(adminUsuarios, { acao: "definir_nome", uid, nome: "x".repeat(80) }, tokens.breno)).corpo.nome.length, 60);
  assert.equal((await pedido(adminUsuarios, { acao: "definir_nome", uid: "nao-existe", nome: "X" }, tokens.breno)).status, 404);
  await pedido(adminUsuarios, { acao: "definir_nome", uid, nome: "Caio" }, tokens.breno);
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

test("perfis: cada usuário salva, lista, edita e apaga só os próprios", async () => {
  assert.equal((await pedido(perfis, { acao: "listar" })).status, 401);
  const perfil = { nome: "Clínicas", termos: "clínica", cidades: ["Natal RN", "Extremoz RN"], profundidade: "rapida", tipo_regiao: "micro", regioes: ["24018"] };
  const criado = await pedido(perfis, { acao: "salvar", perfil }, tokens.ana);
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  assert.equal((await pedido(perfis, { acao: "salvar", perfil: { ...perfil, nome: "" } }, tokens.ana)).status, 400);

  const lista = await pedido(perfis, { acao: "listar" }, tokens.ana);
  assert.deepEqual(lista.corpo.perfis, [{
    id: criado.corpo.id, nome: "Clínicas", termos: ["clínica"], cidades: ["Natal RN", "Extremoz RN"],
    extrair_email: false, profundidade: "rapida", sinonimos: [], categorias_aceitas: [], tipo_regiao: "micro", regioes: ["24018"],
  }]);
  // Guardar categorias aceitas escolhidas na tela de leads
  assert.equal((await pedido(perfis, { acao: "salvar_categorias", id: criado.corpo.id, categorias_aceitas: ["Residência geriátrica", "Casa de repouso para idosos"] }, tokens.ana)).status, 200);
  assert.deepEqual((await pedido(perfis, { acao: "listar" }, tokens.ana)).corpo.perfis[0].categorias_aceitas, ["Residência geriátrica", "Casa de repouso para idosos"]);
  assert.equal((await pedido(perfis, { acao: "salvar_categorias", id: criado.corpo.id, categorias_aceitas: ["x"] }, tokens.breno)).status, 404);
  // Outro usuário não vê nem altera.
  assert.deepEqual((await pedido(perfis, { acao: "listar" }, tokens.breno)).corpo.perfis, []);
  assert.equal((await pedido(perfis, { acao: "salvar", perfil: { ...perfil, id: criado.corpo.id } }, tokens.breno)).status, 404);
  await pedido(perfis, { acao: "apagar", id: criado.corpo.id }, tokens.breno); // apaga só na coleção do breno (nada)
  assert.equal((await pedido(perfis, { acao: "listar" }, tokens.ana)).corpo.perfis.length, 1);

  const editado = await pedido(perfis, { acao: "salvar", perfil: { ...perfil, id: criado.corpo.id, nome: "Clínicas 2" } }, tokens.ana);
  assert.equal(editado.status, 200);
  assert.equal((await pedido(perfis, { acao: "listar" }, tokens.ana)).corpo.perfis[0].nome, "Clínicas 2");
  assert.equal((await pedido(perfis, { acao: "apagar", id: criado.corpo.id }, tokens.ana)).status, 200);
  assert.equal((await pedido(perfis, { acao: "listar" }, tokens.ana)).corpo.perfis.length, 0);
  assert.equal((await pedido(perfis, { acao: "voar" }, tokens.ana)).status, 400);
});

test("saúde do motor: só admin; resume fila, órfãs e pausas sem expor termos", async () => {
  const { db } = firebase();
  assert.equal((await pedido(saudeMotor, {}, tokens.ana)).status, 403);
  const agora = Date.now();
  await db.doc("buscas/pausada1").set({ tipo: "rn_filha", mae_id: "m1", status: "na_fila", pausada_ate: new Date(agora + 20 * 60000), parametros: { termos: ["segredo"] } });
  await db.doc("buscas/orfa1").set({ tipo: "comum", status: "rodando", batimento_em: new Date(agora - 60 * 60000) });
  const r = await pedido(saudeMotor, {}, tokens.breno);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.ok(r.corpo.fila.pausadas >= 1);
  assert.ok(r.corpo.fila.orfas >= 1);
  assert.ok(r.corpo.fila.rn_em_andamento >= 1);
  assert.deepEqual(r.corpo.execucoes, { erro: "Token do GitHub não configurado no Netlify." });
  assert.ok(!JSON.stringify(r.corpo).includes("segredo"));
  await db.doc("buscas/pausada1").delete();
  await db.doc("buscas/orfa1").delete();
});

test("despertador: dispara só quando há trabalho e registra em config/despertador", async () => {
  const { db } = firebase();
  // Limpa a fila dos testes anteriores.
  for (const d of (await db.collection("buscas").get()).docs) await d.ref.delete();
  const disparos = [];
  const disparar = async (id) => { disparos.push(id); return true; };

  let r = await acordar({ db, disparar });
  assert.deepEqual(r, { disparar: false, motivo: "fila_vazia", elegiveis: 0, orfas: 0, disparou: false });
  assert.equal((await db.doc("config/despertador").get()).data().motivo, "fila_vazia");

  await db.doc("buscas/noite").set({ tipo: "rn_filha", status: "na_fila", agendada_para: new Date(Date.now() + 3600000) });
  r = await acordar({ db, disparar });
  assert.equal(r.disparou, false);

  await db.doc("buscas/agora").set({ tipo: "comum", status: "na_fila" });
  r = await acordar({ db, disparar });
  assert.equal(r.motivo, "fila_com_trabalho");
  assert.equal(r.disparou, true);
  assert.equal(disparos.length, 1);

  await db.doc("buscas/viva").set({ tipo: "comum", status: "rodando", batimento_em: new Date() });
  r = await acordar({ db, disparar });
  assert.equal(r.motivo, "motor_rodando");
  assert.equal(disparos.length, 1);
  const registro = (await db.doc("config/despertador").get()).data();
  assert.equal(registro.disparou, false);
  assert.ok(registro.ultima_execucao);
});

test("sessão antiga de admin não vale: token de usuário comum recebe 403 em todas as ações de admin", async () => {
  // A tela recarrega ao trocar de usuário; mesmo que um estado antigo tentasse, o servidor confere a claim do token.
  const r1 = await pedido(adminUsuarios, { acao: "listar" }, tokens.ana);
  const r2 = await pedido(adminUsuarios, { acao: "definir_limite", uid: "qualquer", limite_diario: 999 }, tokens.ana);
  const r3 = await pedido(saudeMotor, {}, tokens.ana);
  const r4 = await pedido(criarBusca, { modo: "rn_inteiro", termos: "x", simular: true }, tokens.ana);
  assert.deepEqual([r1.status, r2.status, r3.status, r4.status], [403, 403, 403, 403]);
});

test("busca comum guarda sinônimos e categorias aceitas (só marcam leads; não mudam as consultas)", async () => {
  const { db } = firebase();
  const sim = await pedido(criarBusca, { termos: "home care", cidades: "Natal RN", profundidade: "rapida", sinonimos: ["casa de repouso"], simular: true }, tokens.breno);
  assert.equal(sim.corpo.consultas, 1);
  const r = await pedido(criarBusca, { termos: "home care", cidades: "Natal RN", profundidade: "rapida", sinonimos: ["casa de repouso"], categorias_aceitas: ["Residência geriátrica"] }, tokens.breno);
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  const p = (await db.doc(`buscas/${r.corpo.id}`).get()).data().parametros;
  assert.deepEqual([p.termos, p.sinonimos, p.categorias_aceitas], [["home care"], ["casa de repouso"], ["Residência geriátrica"]]);
});

test("apagar: vendedor apaga a própria (com os leads), recebe 403 na de outro; admin apaga a de qualquer um", async () => {
  const { auth, db } = firebase();
  const ana = await auth.getUserByEmail("ana@x.example"), breno = await auth.getUserByEmail("breno@x.example");
  const criar = async (id, dono, extra = {}) => {
    await db.doc(`buscas/${id}`).set({ tipo: "comum", lista: true, dono_uid: dono, status: "concluida", qtd_lotes: 2, ...extra });
    await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono, leads: [{ nome: "Lead Fictício" }] });
    await db.doc(`buscas/${id}/lotes/1`).set({ dono_uid: dono, leads: [{ nome: "Lead Fictício 2" }] });
  };
  await criar("ap-ana", ana.uid); await criar("ap-ana2", ana.uid); await criar("ap-breno", breno.uid);
  await db.doc(`usuarios/${ana.uid}`).set({ contagem_dia: 7 }, { merge: true });

  // sem login e sem id
  assert.equal((await pedido(apagarBusca, { id: "ap-ana" })).status, 401);
  assert.equal((await pedido(apagarBusca, {}, tokens.ana)).status, 400);
  // vendedor apaga a própria: documento e lotes somem; a cota do dia NÃO volta
  const propria = await pedido(apagarBusca, { id: "ap-ana" }, tokens.ana);
  assert.deepEqual(propria, { status: 200, corpo: { resultado: "apagada", lotes: 2, buscas: 1 } });
  assert.equal((await db.doc("buscas/ap-ana").get()).exists, false);
  assert.equal((await db.collection("buscas/ap-ana/lotes").get()).size, 0);
  assert.equal((await db.doc(`usuarios/${ana.uid}`).get()).data().contagem_dia, 7);
  // vendedor tentando apagar a de outro: 403 e nada muda
  const deOutro = await pedido(apagarBusca, { id: "ap-breno" }, tokens.ana);
  assert.equal(deOutro.status, 403);
  assert.equal((await db.doc("buscas/ap-breno").get()).exists, true);
  assert.equal((await db.collection("buscas/ap-breno/lotes").get()).size, 2);
  // já apagada / inexistente: 404
  assert.equal((await pedido(apagarBusca, { id: "ap-ana" }, tokens.ana)).status, 404);
  // admin apaga a de qualquer vendedor
  const admin = await pedido(apagarBusca, { id: "ap-ana2" }, tokens.breno);
  assert.equal(admin.status, 200);
  assert.equal((await db.doc("buscas/ap-ana2").get()).exists, false);
  assert.equal((await db.collection("buscas/ap-ana2/lotes").get()).size, 0);
  assert.equal((await pedido(apagarBusca, { id: "ap-breno" }, tokens.breno)).status, 200);
});

test("apagar: busca em andamento precisa ser cancelada antes; mãe do Estado inteiro leva as filhas e os leads", async () => {
  const { auth, db } = firebase();
  const ana = await auth.getUserByEmail("ana@x.example"), breno = await auth.getUserByEmail("breno@x.example");
  for (const status of ["na_fila", "rodando"]) {
    await db.doc("buscas/ap-andamento").set({ tipo: "comum", lista: true, dono_uid: ana.uid, status });
    const r = await pedido(apagarBusca, { id: "ap-andamento" }, tokens.ana);
    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /cancele primeiro/);
  }
  // cancelou (o motor marcou "cancelada") → pode apagar
  await db.doc("buscas/ap-andamento").update({ status: "cancelada" });
  assert.equal((await pedido(apagarBusca, { id: "ap-andamento" }, tokens.ana)).status, 200);

  await db.doc("buscas/ap-mae").set({ tipo: "rn_mae", lista: true, dono_uid: breno.uid, status: "concluida" });
  await db.doc("buscas/ap-mae/lotes/0").set({ dono_uid: breno.uid, leads: [] });
  for (const f of ["ap-f1", "ap-f2"]) {
    await db.doc(`buscas/${f}`).set({ tipo: "rn_filha", mae_id: "ap-mae", dono_uid: breno.uid, status: "concluida" });
    await db.doc(`buscas/${f}/lotes/0`).set({ dono_uid: breno.uid, leads: [] });
  }
  assert.equal((await pedido(apagarBusca, { id: "ap-f1" }, tokens.breno)).status, 400); // só pela principal
  const r = await pedido(apagarBusca, { id: "ap-mae" }, tokens.breno);
  assert.deepEqual(r.corpo, { resultado: "apagada", lotes: 3, buscas: 3 });
  for (const id of ["ap-mae", "ap-f1", "ap-f2"]) assert.equal((await db.doc(`buscas/${id}`).get()).exists, false);
});
