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
const { default: liberarBusca } = await import(funcao("liberar-busca"));
const { default: crmLead } = await import(funcao("crm-lead"));
const { default: adminUsuarios } = await import(funcao("admin-usuarios"));
const { default: configPublica } = await import(funcao("config-publica"));
const { default: perfis } = await import(funcao("perfis"));
const { default: saudeMotor } = await import(funcao("saude-motor"));
const { default: equipesFn } = await import(funcao("equipes"));
const { default: equipeFn } = await import(funcao("equipe"));
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
  // 1 cidade: uma máquina só; estimativa = partida (60 s) + a consulta (40 s)
  assert.deepEqual(sim, { status: 200, corpo: { consultas: 1, estimativa_seg: 100, maquinas: 1, um_motor_seg: 100, pequenas: 0 } });
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
  // Mesmo dividida em 4 máquinas, cada parte passaria de 5 h.
  const cidades = Array.from({ length: 80 }, (_, i) => `Cidade ${i}`).join(",");
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

  // Uma máquina rodando e trabalho na fila: com 4 vagas, dispara para as vagas livres.
  await db.doc("buscas/viva").set({ tipo: "comum", status: "rodando", batimento_em: new Date() });
  r = await acordar({ db, disparar });
  assert.equal(r.motivo, "fila_com_trabalho");
  assert.equal(disparos.length, 2);
  // Paralelismo reduzido a 1 vaga (sinal de bloqueio): não dispara com a máquina viva.
  await db.doc("config/paralelismo").set({ vagas_base: 1, ultimo_sinal_em: new Date() });
  r = await acordar({ db, disparar });
  assert.equal(r.motivo, "motor_rodando");
  assert.equal(disparos.length, 2);
  await db.doc("config/paralelismo").delete();
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

test("paralelismo: busca com várias cidades nasce dividida em partes (até 4, por cidade) e a estimativa é a da maior parte", async () => {
  const { db } = firebase();
  const cidades = "Natal RN, Parnamirim RN, Macaíba RN, Extremoz RN, Ceará-Mirim RN";
  const sim = await pedido(criarBusca, { termos: "pet shop, veterinário", cidades, profundidade: "rapida", simular: true }, tokens.breno);
  assert.equal(sim.corpo.consultas, 10);
  assert.equal(sim.corpo.maquinas, 4);
  // 4 máquinas: a maior parte tem 2 cidades × 2 termos = 4 consultas → 60 + 4×40 + 3×30 = 310 s (uma só: 60 + 10×40 + 9×30 = 730 s)
  assert.equal(sim.corpo.estimativa_seg, 310);
  assert.equal(sim.corpo.um_motor_seg, 730);

  const r = await pedido(criarBusca, { termos: "pet shop, veterinário", cidades, profundidade: "rapida" }, tokens.breno);
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  const mae = (await db.doc(`buscas/${r.corpo.id}`).get()).data();
  assert.equal(mae.partes_total, 4);
  assert.equal(mae.cidades_total, 5);
  assert.equal(mae.cidades_prontas, 0);
  const partes = (await db.collection("buscas").where("mae_id", "==", r.corpo.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.ordem - b.ordem);
  assert.deepEqual(partes.map((p) => p.cidades), [["Natal RN", "Ceará-Mirim RN"], ["Parnamirim RN"], ["Macaíba RN"], ["Extremoz RN"]]);
  assert.ok(partes.every((p) => p.tipo === "parte" && p.status === "na_fila" && !p.lista && p.dono_uid === mae.dono_uid));
  // Cidade por cidade dentro da parte (os 2 termos de Natal, depois os 2 de Ceará-Mirim)
  assert.deepEqual(partes[0].consultas.map((c) => c.texto), ["pet shop Natal RN", "veterinário Natal RN", "pet shop Ceará-Mirim RN", "veterinário Ceará-Mirim RN"]);
  const fila = (await db.doc("fila/estado").get()).data();
  const itens = fila.itens.filter((i) => i.mae_id === r.corpo.id);
  assert.equal(itens.length, 4);

  // Com o paralelismo reduzido (sinal de bloqueio), divide em menos partes.
  await db.doc("config/paralelismo").set({ vagas_base: 2, ultimo_sinal_em: new Date() });
  const sim2 = await pedido(criarBusca, { termos: "pet shop", cidades, profundidade: "rapida", simular: true }, tokens.breno);
  assert.equal(sim2.corpo.maquinas, 2);
  await db.doc("config/paralelismo").delete();

  // Cancelar antes de começar: mãe e partes canceladas na hora.
  const c = await pedido(cancelarBusca, { id: r.corpo.id }, tokens.breno);
  assert.deepEqual(c.corpo, { resultado: "cancelada" });
  assert.equal((await db.doc(`buscas/${r.corpo.id}`).get()).data().status, "cancelada");
  const depois = (await db.collection("buscas").where("mae_id", "==", r.corpo.id).get()).docs.map((d) => d.data().status);
  assert.deepEqual([...new Set(depois)], ["cancelada"]);
  assert.equal((await pedido(cancelarBusca, { id: partes[0].id }, tokens.breno)).status, 400); // parte: só pela principal

  // Apagar leva as partes (e os leads parciais delas).
  await db.doc(`buscas/${partes[0].id}/lotes/0`).set({ dono_uid: mae.dono_uid, leads: [{ nome: "Parcial Fictício" }] });
  const ap = await pedido(apagarBusca, { id: r.corpo.id }, tokens.breno);
  assert.deepEqual(ap.corpo, { resultado: "apagada", lotes: 1, buscas: 5 });
  assert.equal((await db.collection("buscas").where("mae_id", "==", r.corpo.id).get()).size, 0);
});

test("aviso de cidades pequenas: simular diz quantas têm menos de 5 mil hab. (IBGE) e quanto tempo tirá-las economiza", async () => {
  // Água Nova (2.946) e Almino Afonso (4.687) são pequenas; Natal e Mossoró não; João Pessoa (fora do RN) não conta.
  const r = await pedido(criarBusca, { termos: "farmácia", cidades: "Natal RN, Água Nova RN, Almino Afonso RN, Mossoró RN, João Pessoa PB",
    profundidade: "rapida", simular: true }, tokens.ana);
  assert.equal(r.corpo.pequenas, 2);
  assert.deepEqual(r.corpo.cidades_pequenas, ["Água Nova RN", "Almino Afonso RN"]);
  assert.equal(r.corpo.sem_pequenas.consultas, 3);
  assert.ok(r.corpo.sem_pequenas.estimativa_seg <= r.corpo.estimativa_seg);
  const sem = await pedido(criarBusca, { termos: "farmácia", cidades: "Natal RN, Mossoró RN", profundidade: "rapida", simular: true }, tokens.ana);
  assert.equal(sem.corpo.pequenas, 0);
  assert.equal(sem.corpo.sem_pequenas, undefined);
});

test("limites do vendedor: 167 cidades → 400; 30 cidades passam; admin com 167 passa; consultas por dia; Configurações", async () => {
  const { auth, db } = firebase();
  await auth.createUser({ email: "caio@x.example", password: "senha-forte-3" });
  const caio = await entrar("caio@x.example", "senha-forte-3");
  const cidades = (n) => Array.from({ length: n }, (_, i) => `Cidade ${i} RN`).join(",");

  // Vendedor com as 167 cidades do RN: 400 com a mensagem combinada (também na simulação)
  for (const simular of [true, false]) {
    const r = await pedido(criarBusca, { termos: "farmácia", cidades: cidades(167), profundidade: "rapida", simular }, caio);
    assert.equal(r.status, 400);
    assert.equal(r.corpo.erro, "Busca grande demais para vendedor (167 cidades / 167 consultas). Máximo: 40 cidades ou 120 consultas. Divida por região ou peça ao admin.");
  }
  // 41 cidades (passa das 40) e 30 cidades × 5 termos = 150 consultas (passa das 120): 400
  assert.equal((await pedido(criarBusca, { termos: "a", cidades: cidades(41), profundidade: "rapida", simular: true }, caio)).status, 400);
  const muitas = await pedido(criarBusca, { termos: "a,b,c,d,e", cidades: cidades(30), profundidade: "rapida", simular: true }, caio);
  assert.match(muitas.corpo.erro, /\(30 cidades \/ 150 consultas\)/);
  // 30 cidades passam (30 × 4 termos = 120 consultas, no limite)
  const ok = await pedido(criarBusca, { termos: "a,b,c,d", cidades: cidades(30), profundidade: "rapida" }, caio);
  assert.equal(ok.status, 201, JSON.stringify(ok.corpo));
  const perfil = (await db.doc(`usuarios/${(await auth.getUserByEmail("caio@x.example")).uid}`).get()).data();
  assert.equal(perfil.consultas_dia, 120);
  // Consultas por dia (300): +120 = 240 passa; +120 = 360 não
  assert.equal((await pedido(criarBusca, { termos: "e,f,g,h", cidades: cidades(30), profundidade: "rapida" }, caio)).status, 201);
  const dia = await pedido(criarBusca, { termos: "i,j,k,l", cidades: cidades(30), profundidade: "rapida" }, caio);
  assert.equal(dia.status, 429);
  assert.match(dia.corpo.erro, /Limite diário de consultas atingido: 240 de 300 usadas hoje e esta busca tem 120/);

  // Admin: sem esses limites (167 cidades passa)
  const adm = await pedido(criarBusca, { termos: "farmácia", cidades: cidades(167), profundidade: "rapida" }, tokens.breno);
  assert.equal(adm.status, 201, JSON.stringify(adm.corpo));

  // Admin › Configurações: só admin; os números valem na hora
  assert.equal((await pedido(adminUsuarios, { acao: "definir_config", max_cidades_busca: 999 }, caio)).status, 403);
  assert.equal((await pedido(adminUsuarios, { acao: "definir_config", max_cidades_busca: 0 }, tokens.breno)).status, 400);
  const cfg = await pedido(adminUsuarios, { acao: "definir_config", max_cidades_busca: 10, max_consultas_busca: 50, max_consultas_dia: 400 }, tokens.breno);
  assert.deepEqual(cfg.corpo.config, { max_cidades_busca: 10, max_consultas_busca: 50, max_consultas_dia: 400, carteira_dias: 60 });
  const r10 = await pedido(criarBusca, { termos: "a", cidades: cidades(11), profundidade: "rapida", simular: true }, caio);
  assert.match(r10.corpo.erro, /Máximo: 10 cidades ou 50 consultas/);
  // com 400 por dia, a 3ª busca de 120 passa (240 + 120 = 360)
  assert.equal((await pedido(criarBusca, { termos: "i,j", cidades: cidades(10), profundidade: "rapida" }, caio)).status, 201);
  const lista = await pedido(adminUsuarios, { acao: "listar" }, tokens.breno);
  assert.deepEqual(lista.corpo.config, { max_cidades_busca: 10, max_consultas_busca: 50, max_consultas_dia: 400, carteira_dias: 60 });
  const linhaCaio = lista.corpo.usuarios.find((u) => u.email === "caio@x.example");
  assert.equal(linhaCaio.consultas_hoje, 260);

  // Consultas por dia do vendedor (na tabela de usuários): 250 → a próxima de 10 não passa (260 + 10)
  const uidCaio = linhaCaio.uid;
  const lc = await pedido(adminUsuarios, { acao: "definir_limite_consultas", uid: uidCaio, limite_consultas_dia: 250 }, tokens.breno);
  assert.deepEqual(lc.corpo, { limite_consultas_dia: 250 });
  assert.equal((await pedido(criarBusca, { termos: "z", cidades: cidades(10), profundidade: "rapida" }, caio)).status, 429);
  await pedido(adminUsuarios, { acao: "definir_limite_consultas", uid: uidCaio, limite_consultas_dia: null }, tokens.breno);
  const { FieldValue } = await import("firebase-admin/firestore");
  await db.doc("config/geral").set({ max_cidades_busca: FieldValue.delete(), max_consultas_busca: FieldValue.delete(), max_consultas_dia: FieldValue.delete() }, { merge: true });
});

test("liberar busca: só admin; lista inteira, recorte e divisão sem repetir lead; revogar; não mexe na cota; apagar leva as cópias", async () => {
  const { auth, db } = firebase();
  const vivi = await auth.createUser({ email: "vivi@x.example", password: "senha-forte-v", displayName: "Vivi" });
  const davi = await auth.createUser({ email: "davi@x.example", password: "senha-forte-d", displayName: "Davi" });
  const ana = await auth.getUserByEmail("ana@x.example");
  const breno = await auth.getUserByEmail("breno@x.example");
  tokens.vivi = await entrar("vivi@x.example", "senha-forte-v");
  // Busca fictícia da Ana, terminada, com 12 leads em 2 lotes (5 Natal, 3 Mossoró, 2 Caicó, 1 Macau, 1 sem cidade).
  const cidades = ["Natal", "Natal", "Natal", "Natal", "Natal", "Mossoró", "Mossoró", "Mossoró", "Caicó", "Caicó", "Macau", ""];
  const leads = cidades.map((c, i) => ({ nome: `Lugar ${i}`, cidade: c, id_lugar: `L${i}` }));
  const ref = db.doc("buscas/lib1");
  await ref.set({ dono_uid: ana.uid, tipo: "comum", lista: true, status: "concluida", qtd_lotes: 2, criada_em: new Date(),
    parametros: { termos: ["x"], cidades: ["Natal RN"] }, resumo: { total: 12 } });
  await ref.collection("lotes").doc("0").set({ dono_uid: ana.uid, leads: leads.slice(0, 7) });
  await ref.collection("lotes").doc("1").set({ dono_uid: ana.uid, leads: leads.slice(7) });

  // Vendedor não libera nada.
  assert.equal((await pedido(liberarBusca, { acao: "simular", id: "lib1" }, tokens.ana)).status, 403);
  assert.equal((await pedido(liberarBusca, { acao: "revogar", id: "lib1", uid: vivi.uid }, tokens.vivi)).status, 403);

  // Simular sem vendedores: lista de vendedores (sem admin e sem o dono) e leads por cidade.
  const s0 = await pedido(liberarBusca, { acao: "simular", id: "lib1" }, tokens.breno);
  assert.equal(s0.status, 200);
  const uidsDisp = s0.corpo.vendedores.map((v) => v.uid);
  assert.ok(uidsDisp.includes(vivi.uid) && uidsDisp.includes(davi.uid));
  assert.ok(!uidsDisp.includes(ana.uid) && !uidsDisp.includes(breno.uid));
  assert.equal(s0.corpo.total, 12);
  assert.deepEqual(s0.corpo.cidades.slice(0, 2), [{ cidade: "Natal", leads: 5 }, { cidade: "Mossoró", leads: 3 }]);
  assert.ok(s0.corpo.cidades.some((c) => c.cidade === "(sem cidade)" && c.leads === 1));

  // Simular a divisão: cidades diferentes para cada um, soma = total, nada gravado.
  const s1 = await pedido(liberarBusca, { acao: "simular", id: "lib1", vendedores: [vivi.uid, davi.uid], modo: "inteira", dividir: true }, tokens.breno);
  const [pv, pd] = s1.corpo.por_vendedor;
  assert.equal(pv.leads + pd.leads, 12);
  assert.equal(pv.cidades.filter((c) => pd.cidades.includes(c)).length, 0);
  assert.equal((await ref.get()).data().liberada_para, undefined);

  // Validações.
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [breno.uid] }, tokens.breno)).status, 400);
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [ana.uid] }, tokens.breno)).status, 400);
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [] }, tokens.breno)).status, 400);
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [vivi.uid], modo: "cidades", cidades: [] }, tokens.breno)).status, 400);

  // Liberar dividido: cada um recebe a cópia só das cidades dele, sem nenhum lead repetido.
  const r1 = await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [vivi.uid, davi.uid], modo: "inteira", dividir: true }, tokens.breno);
  assert.equal(r1.status, 200);
  let b = (await ref.get()).data();
  assert.deepEqual(b.liberada_para.sort(), [vivi.uid, davi.uid].sort());
  assert.equal(b.liberacoes[vivi.uid].modo, "recorte");
  assert.equal(b.liberacoes[vivi.uid].dividida, true);
  assert.equal(b.liberacoes[vivi.uid].rotulo, "Vivi");
  const copia = async (uid) => (await ref.collection("liberacoes").doc(uid).collection("lotes").doc("0").get()).data();
  const cv = await copia(vivi.uid), cd = await copia(davi.uid);
  assert.equal(cv.vendedor_uid, vivi.uid);
  const idsV = cv.leads.map((l) => l.id_lugar), idsD = cd.leads.map((l) => l.id_lugar);
  assert.equal(idsV.length + idsD.length, 12);
  assert.equal(idsV.filter((x) => idsD.includes(x)).length, 0);
  assert.ok(cv.leads.every((l) => b.liberacoes[vivi.uid].cidades.includes(l.cidade || "(sem cidade)")));
  // Os lotes da busca não ganham os vendedores do recorte.
  assert.equal((await ref.collection("lotes").doc("0").get()).data().liberada_para, undefined);

  // Lista inteira para a Vivi (troca o recorte dela): lotes ganham o uid; a cópia antiga some.
  const r2 = await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [vivi.uid], modo: "inteira" }, tokens.breno);
  assert.equal(r2.status, 200);
  b = (await ref.get()).data();
  assert.equal(b.liberacoes[vivi.uid].modo, "inteira");
  assert.equal(b.liberacoes[vivi.uid].qtd_leads, 12);
  for (const n of ["0", "1"]) assert.deepEqual((await ref.collection("lotes").doc(n).get()).data().liberada_para, [vivi.uid]);
  assert.equal((await ref.collection("liberacoes").doc(vivi.uid).collection("lotes").doc("0").get()).exists, false);

  // Só estas cidades (sem dividir): Davi fica só com Natal + Caicó.
  await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [davi.uid], modo: "cidades", cidades: ["Natal", "Caicó"] }, tokens.breno);
  const cd2 = await copia(davi.uid);
  assert.equal(cd2.leads.length, 7);
  assert.ok(cd2.leads.every((l) => ["Natal", "Caicó"].includes(l.cidade)));

  // Não conta na cota do vendedor.
  assert.equal((await db.doc(`usuarios/${vivi.uid}`).get()).exists, false);

  // Revogar: some da lista (liberada_para) e os leads saem (lotes e cópia).
  assert.equal((await pedido(liberarBusca, { acao: "revogar", id: "lib1", uid: vivi.uid }, tokens.breno)).status, 200);
  assert.equal((await pedido(liberarBusca, { acao: "revogar", id: "lib1", uid: davi.uid }, tokens.breno)).status, 200);
  b = (await ref.get()).data();
  assert.deepEqual(b.liberada_para, []);
  assert.deepEqual(b.liberacoes, {});
  assert.deepEqual((await ref.collection("lotes").doc("0").get()).data().liberada_para, []);
  assert.equal((await ref.collection("liberacoes").doc(davi.uid).collection("lotes").doc("0").get()).exists, false);
  assert.equal((await pedido(liberarBusca, { acao: "revogar", id: "lib1", uid: davi.uid }, tokens.breno)).status, 404);

  // Busca em andamento ou parte: não libera.
  await db.doc("buscas/lib2").set({ dono_uid: ana.uid, tipo: "comum", lista: true, status: "na_fila", criada_em: new Date() });
  assert.equal((await pedido(liberarBusca, { acao: "simular", id: "lib2" }, tokens.breno)).status, 409);
  await db.doc("buscas/lib3").set({ dono_uid: ana.uid, tipo: "parte", status: "concluida", qtd_lotes: 1, criada_em: new Date() });
  assert.equal((await pedido(liberarBusca, { acao: "simular", id: "lib3" }, tokens.breno)).status, 400);

  // Apagar a busca leva as cópias liberadas.
  await pedido(liberarBusca, { acao: "liberar", id: "lib1", vendedores: [davi.uid, vivi.uid], modo: "inteira", dividir: true }, tokens.breno);
  assert.equal((await pedido(apagarBusca, { id: "lib1" }, tokens.breno)).status, 200);
  assert.equal((await ref.collection("liberacoes").doc(davi.uid).collection("lotes").doc("0").get()).exists, false);
  assert.equal((await ref.collection("liberacoes").doc(vivi.uid).collection("lotes").doc("0").get()).exists, false);
  for (const id of ["lib2", "lib3"]) await db.doc(`buscas/${id}`).delete();
});

test("mini-CRM e carteira: status com histórico; vendedor B recebe 409 no lead da carteira do A; prazo; admin transfere; painel", async () => {
  const { auth, db } = firebase();
  const { chaveLead, fatiaDe } = await import("../netlify/lib/logica.mjs");
  const fla = await auth.createUser({ email: "fla@x.example", password: "senha-forte-f", displayName: "Flávio" });
  const gil = await auth.createUser({ email: "gil@x.example", password: "senha-forte-g", displayName: "Gil" });
  tokens.fla = await entrar("fla@x.example", "senha-forte-f");
  tokens.gil = await entrar("gil@x.example", "senha-forte-g");
  // O mesmo estabelecimento (place_id C1) em buscas diferentes, uma de cada vendedor.
  const c1 = { nome: "Clínica Um", cidade: "Natal", id_lugar: "C1", telefone: "(84) 99999-1111" };
  const semId = { nome: "Clínica Dois", cidade: "Natal", id_lugar: "", telefone: "(84) 3333-2222" };
  for (const [id, dono, leads] of [["crm1", fla.uid, [c1, semId]], ["crm2", gil.uid, [c1]]]) {
    await db.doc(`buscas/${id}`).set({ dono_uid: dono, tipo: "comum", lista: true, status: "concluida", qtd_lotes: 1, criada_em: new Date() });
    await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono, leads });
  }
  const K1 = chaveLead(c1), K2 = chaveLead(semId);
  assert.equal(K1, "p_C1");
  assert.equal(K2, "t_8433332222_clinica-dois");
  const st = (token, corpo) => pedido(crmLead, { acao: "status", ...corpo }, token);

  // Validações
  assert.equal((await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "talvez" })).status, 400);
  assert.equal((await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "descartado" })).status, 400); // sem motivo
  assert.equal((await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "contatado", proximo: "amanhã" })).status, 400);
  // Flávio: Contatado com anotação e próximo contato → histórico e carteira
  const r1 = await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "contatado", anotacao: "ligar sexta", proximo: "2026-09-26" });
  assert.equal(r1.status, 200);
  const crmFla = (await db.doc(`crm/${fla.uid}__${fatiaDe(K1)}`).get()).data();
  assert.equal(crmFla.dono_uid, fla.uid);
  const reg = crmFla.leads[K1];
  assert.deepEqual([reg.s, reg.n, reg.p, reg.busca], ["contatado", "ligar sexta", "2026-09-26", "crm1"]);
  assert.deepEqual([reg.h[0].u, reg.h[0].s, reg.h[0].n], ["Flávio", "contatado", "ligar sexta"]);
  let cart = (await db.doc(`carteira/resolve-farma__${fatiaDe(K1)}`).get()).data().leads[K1];
  assert.deepEqual([cart.uid, cart.nome, cart.s], [fla.uid, "Flávio", "contatado"]);
  // Gil tem o mesmo lugar numa busca dele: 409 "Na carteira de Flávio"
  const r2 = await st(tokens.gil, { busca_id: "crm2", chave: K1, status: "contatado" });
  assert.equal(r2.status, 409);
  assert.match(r2.corpo.erro, /carteira de Flávio/);
  // Gil não mexe em lead de busca que não é dele, nem em lead que não está na busca dele
  assert.equal((await st(tokens.gil, { busca_id: "crm1", chave: K1, status: "contatado" })).status, 403);
  assert.equal((await st(tokens.gil, { busca_id: "crm2", chave: K2, status: "contatado" })).status, 403);
  // Negociando mantém o "desde"; o histórico cresce (mais recente primeiro)
  await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "negociando", anotacao: "mandou proposta" });
  const reg2 = (await db.doc(`crm/${fla.uid}__${fatiaDe(K1)}`).get()).data().leads[K1];
  assert.deepEqual(reg2.h.map((h) => h.s), ["negociando", "contatado"]);
  assert.equal(reg2.p, "2026-09-26"); // próximo contato continua
  // Prazo: sem contato há 61 dias → livre (padrão 60); com o prazo em 90 dias, continua do Flávio
  const refCart = db.doc(`carteira/resolve-farma__${fatiaDe(K1)}`);
  await refCart.set({ leads: { [K1]: { ...cart, s: "negociando", ultimo: Date.now() - 61 * 86400000 } } }, { merge: true });
  assert.equal((await pedido(adminUsuarios, { acao: "definir_config", carteira_dias: 90 }, tokens.breno)).corpo.config.carteira_dias, 90);
  assert.equal((await st(tokens.gil, { busca_id: "crm2", chave: K1, status: "contatado" })).status, 409);
  assert.equal((await pedido(adminUsuarios, { acao: "definir_config", carteira_dias: 0 }, tokens.breno)).status, 400);
  await pedido(adminUsuarios, { acao: "definir_config", carteira_dias: 60 }, tokens.breno);
  const r3 = await st(tokens.gil, { busca_id: "crm2", chave: K1, status: "contatado", anotacao: "retomado" });
  assert.equal(r3.status, 200);
  assert.equal((await refCart.get()).data().leads[K1].uid, gil.uid);
  // Admin transfere de volta para o Flávio
  assert.equal((await pedido(crmLead, { acao: "transferir", chave: K1, para_uid: fla.uid }, tokens.gil)).status, 403);
  assert.equal((await pedido(crmLead, { acao: "transferir", chave: K1, para_uid: "nao-existe" }, tokens.breno)).status, 400);
  const tr = await pedido(crmLead, { acao: "transferir", chave: K1, para_uid: fla.uid }, tokens.breno);
  assert.equal(tr.status, 200);
  cart = (await refCart.get()).data().leads[K1];
  assert.deepEqual([cart.uid, cart.nome, cart.s], [fla.uid, "Flávio", "contatado"]);
  const regFla = (await db.doc(`crm/${fla.uid}__${fatiaDe(K1)}`).get()).data().leads[K1];
  assert.match(regFla.h[0].n, /^Transferido por .+ \(antes: Gil\)$/);
  const regGil = (await db.doc(`crm/${gil.uid}__${fatiaDe(K1)}`).get()).data().leads[K1];
  assert.match(regGil.h[0].n, /Transferido para Flávio/);
  // Cliente e depois Descartado (com motivo): sai da carteira
  await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "cliente" });
  const painel = await pedido(crmLead, { acao: "carteiras" }, tokens.breno);
  assert.equal(painel.status, 200);
  const pf = painel.corpo.vendedores.find((v) => v.uid === fla.uid);
  assert.equal(pf.carteira, 1);
  assert.equal(pf.por_status.cliente, 1);
  assert.equal(pf.conversao, 1);
  assert.equal((await pedido(crmLead, { acao: "carteiras" }, tokens.fla)).status, 403);
  const r4 = await st(tokens.fla, { busca_id: "crm1", chave: K1, status: "descartado", motivo: "fechou" });
  assert.equal(r4.status, 200);
  assert.equal((await refCart.get()).data().leads[K1], undefined);
  // Lead sem place_id (telefone + nome) também funciona; não mexe na cota do vendedor
  assert.equal((await st(tokens.fla, { busca_id: "crm1", chave: K2, status: "contatado" })).status, 200);
  assert.equal((await db.doc(`usuarios/${fla.uid}`).get()).exists, false);
  // Liberar dividindo respeita a carteira: C1 (do Gil agora) vai só para o Gil, mesmo que Natal caia para o Flávio.
  await st(tokens.gil, { busca_id: "crm2", chave: K1, status: "contatado" });
  const ana = await auth.getUserByEmail("ana@x.example");
  await db.doc("buscas/crm3").set({ dono_uid: ana.uid, tipo: "comum", lista: true, status: "concluida", qtd_lotes: 1, criada_em: new Date() });
  await db.doc("buscas/crm3/lotes/0").set({ dono_uid: ana.uid, leads: [c1, { nome: "N2", cidade: "Natal", id_lugar: "N2" }, { nome: "N3", cidade: "Natal", id_lugar: "N3" },
    { nome: "M1", cidade: "Mossoró", id_lugar: "M1" }] });
  const lib = await pedido(liberarBusca, { acao: "liberar", id: "crm3", vendedores: [fla.uid, gil.uid], modo: "inteira", dividir: true }, tokens.breno);
  assert.equal(lib.status, 200);
  const copia = async (uid) => ((await db.doc(`buscas/crm3/liberacoes/${uid}/lotes/0`).get()).data()?.leads || []).map((l) => l.id_lugar);
  const [cf, cg] = [await copia(fla.uid), await copia(gil.uid)];
  assert.ok(cg.includes("C1") && !cf.includes("C1"), "C1 só na cópia do dono da carteira");
  assert.deepEqual([...cf, ...cg].sort(), ["C1", "M1", "N2", "N3"]);
  await pedido(apagarBusca, { id: "crm3" }, tokens.breno);
  for (const id of ["crm1", "crm2"]) { await db.doc(`buscas/${id}/lotes/0`).delete(); await db.doc(`buscas/${id}`).delete(); }
});

test("PB: Estado inteiro (admin) estima com 'PB'; vendedor recebe 403; busca comum na PB com limites e aviso de pequenas", async () => {
  const sim = await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista", uf: "PB", simular: true }, tokens.breno);
  assert.equal(sim.status, 200);
  assert.equal(sim.corpo.uf, "PB");
  assert.equal(sim.corpo.consultas, 345);
  assert.ok(sim.corpo.estimativa_seg > 7 * 3600);
  assert.equal((await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista", uf: "CE", simular: true }, tokens.breno)).status, 400);
  assert.equal((await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista", uf: "PB", simular: true }, tokens.ana)).status, 403);
  // RN sem uf continua igual
  const rn = await pedido(criarBusca, { modo: "rn_inteiro", termos: "dentista", simular: true }, tokens.breno);
  assert.deepEqual([rn.corpo.uf, rn.corpo.consultas], ["RN", 249]);
  // Busca comum na PB (vendedor): pequenas (< 5 mil hab.) avisadas; limite de 40 cidades vale igual
  const pb = (await import("../dados/municipios_pb.json", { with: { type: "json" } })).default.municipios;
  const pequenas = pb.filter((m) => m.populacao_2022 < 5000).slice(0, 2).map((m) => `${m.nome} PB`);
  const s1 = await pedido(criarBusca, { termos: "dentista", cidades: ["João Pessoa PB", ...pequenas].join(","), profundidade: "rapida", simular: true }, tokens.ana);
  assert.equal(s1.status, 200);
  assert.equal(s1.corpo.pequenas, 2);
  const muitas = pb.slice(0, 41).map((m) => `${m.nome} PB`).join(",");
  const s2 = await pedido(criarBusca, { termos: "dentista", cidades: muitas, profundidade: "rapida", simular: true }, tokens.ana);
  assert.equal(s2.status, 400);
  assert.match(s2.corpo.erro, /41 cidades/);
  // Liberação dividida, status e carteira com leads da PB (mesmas regras do RN)
  const { auth, db } = firebase();
  const [fla, gil, ana] = await Promise.all(["fla", "gil", "ana"].map((n) => auth.getUserByEmail(`${n}@x.example`)));
  await db.doc("buscas/pbL").set({ dono_uid: ana.uid, tipo: "comum", lista: true, status: "concluida", qtd_lotes: 1, criada_em: new Date(), parametros: { termos: ["x"], cidades: ["João Pessoa PB", "Patos PB"] } });
  await db.doc("buscas/pbL/lotes/0").set({ dono_uid: ana.uid, leads: [
    { nome: "JP1", cidade: "João Pessoa", uf: "PB", id_lugar: "PBJ1" }, { nome: "JP2", cidade: "João Pessoa", uf: "PB", id_lugar: "PBJ2" },
    { nome: "PT1", cidade: "Patos", uf: "PB", id_lugar: "PBP1" }] });
  const lib = await pedido(liberarBusca, { acao: "liberar", id: "pbL", vendedores: [fla.uid, gil.uid], modo: "inteira", dividir: true }, tokens.breno);
  assert.equal(lib.status, 200);
  const deFla = lib.corpo.por_vendedor.find((x) => x.uid === fla.uid);
  const chave = deFla.cidades.includes("João Pessoa") ? "p_PBJ1" : "p_PBP1";
  assert.equal((await pedido(crmLead, { acao: "status", busca_id: "pbL", chave, status: "contatado" }, tokens.fla)).status, 200);
  assert.equal((await pedido(crmLead, { acao: "status", busca_id: "pbL", chave, status: "contatado" }, tokens.gil)).status, 403); // não é da parte dele
  await pedido(apagarBusca, { id: "pbL" }, tokens.breno);
});

// ------------------------------------------------------------ EQUIPES (master › gestor › vendedor)
test("equipes: master cria equipe e gestor; gestor cria prepostos no limite, 403 em outra equipe; cotas da equipe; carteira isolada; liberar e desativar", async () => {
  const { auth, db } = firebase();
  const { chaveLead, fatiaDe } = await import("../netlify/lib/logica.mjs");
  // Master cria duas equipes (com o representante de cada uma)
  assert.equal((await pedido(equipesFn, { acao: "listar" }, tokens.ana)).status, 403); // vendedor não
  const e1 = await pedido(equipesFn, { acao: "criar", nome: "Farma Norte", gestor: { email: "gestor1@x.example", senha: "senha-forte-g1", nome: "Gestor Um" },
    cotas: { max_usuarios: 3, buscas_dia: 2, consultas_mes: 12 } }, tokens.breno);
  assert.equal(e1.status, 201, JSON.stringify(e1.corpo));
  assert.equal(e1.corpo.id, "farma-norte");
  const e2 = await pedido(equipesFn, { acao: "criar", nome: "Farma Sul", gestor: { email: "gestor2@x.example", senha: "senha-forte-g2", nome: "Gestor Dois" } }, tokens.breno);
  assert.equal(e2.status, 201);
  assert.deepEqual((await db.doc("equipes/farma-sul").get()).data().cotas, { max_usuarios: 10, buscas_dia: 100, consultas_mes: 6000 }); // padrão do Breno
  const claims = (await auth.getUser(e1.corpo.gestor_uid)).customClaims;
  assert.deepEqual(claims, { papel: "gestor", equipe_id: "farma-norte" });
  const g1 = await entrar("gestor1@x.example", "senha-forte-g1"), g2 = await entrar("gestor2@x.example", "senha-forte-g2");
  assert.equal((await pedido(equipesFn, { acao: "listar" }, g1)).status, 403); // gestor não mexe nas equipes

  // Gestor cria prepostos na própria equipe, dentro do limite de usuários (o gestor conta: 3 = gestor + 2)
  const p1 = await pedido(equipeFn, { acao: "criar_preposto", email: "pn1@x.example", senha: "senha-forte-n1", nome: "Preposto Norte 1" }, g1);
  assert.equal(p1.status, 201, JSON.stringify(p1.corpo));
  const p2 = await pedido(equipeFn, { acao: "criar_preposto", email: "pn2@x.example", senha: "senha-forte-n2", nome: "Preposto Norte 2", limite_diario: 1 }, g1);
  assert.equal(p2.status, 201);
  const cheio = await pedido(equipeFn, { acao: "criar_preposto", email: "pn3@x.example", senha: "senha-forte-n3" }, g1);
  assert.equal(cheio.status, 409);
  assert.match(cheio.corpo.erro, /3 de 3 usuários/);
  assert.deepEqual((await auth.getUser(p1.corpo.uid)).customClaims, { papel: "vendedor", equipe_id: "farma-norte" });
  // Limite acima do da equipe (2 buscas/dia): recusado
  assert.equal((await pedido(equipeFn, { acao: "editar_preposto", uid: p1.corpo.uid, limite_diario: 5 }, g1)).status, 400);
  assert.equal((await pedido(equipeFn, { acao: "editar_preposto", uid: p1.corpo.uid, limite_diario: 2 }, g1)).status, 200);
  // Outra equipe: 403 (ver, criar e mexer em preposto de lá)
  assert.equal((await pedido(equipeFn, { acao: "resumo", equipe_id: "farma-sul" }, g1)).status, 403);
  assert.equal((await pedido(equipeFn, { acao: "criar_preposto", equipe_id: "farma-sul", email: "x9@x.example", senha: "senha-forte-x9" }, g1)).status, 403);
  const ps = await pedido(equipeFn, { acao: "criar_preposto", email: "ps1@x.example", senha: "senha-forte-s1", nome: "Preposto Sul" }, g2);
  assert.equal(ps.status, 201);
  assert.equal((await pedido(equipeFn, { acao: "editar_preposto", uid: ps.corpo.uid, nome: "Roubado" }, g1)).status, 403);
  assert.equal((await pedido(equipeFn, { acao: "desativar_preposto", uid: ps.corpo.uid }, g1)).status, 403);
  // Vendedor não abre "Minha equipe"; o master abre qualquer uma
  const tn1 = await entrar("pn1@x.example", "senha-forte-n1"), tn2 = await entrar("pn2@x.example", "senha-forte-n2"), ts1 = await entrar("ps1@x.example", "senha-forte-s1");
  assert.equal((await pedido(equipeFn, { acao: "resumo" }, tn1)).status, 403);
  const rm = await pedido(equipeFn, { acao: "resumo", equipe_id: "farma-sul" }, tokens.breno);
  assert.equal(rm.status, 200);
  assert.equal(rm.corpo.usuarios, 2);
  const r1 = await pedido(equipeFn, { acao: "resumo" }, g1);
  assert.equal(r1.corpo.membros.length, 3);
  assert.equal(r1.corpo.teto.limite_diario, 2);

  // Buscas: levam o equipe_id; a cota da equipe (2 buscas/dia, 12 consultas/mês) bloqueia ao passar
  const b1 = await pedido(criarBusca, { termos: "farmácia", cidades: "Natal RN, Parnamirim RN", profundidade: "rapida" }, tn1);
  assert.equal(b1.status, 201, JSON.stringify(b1.corpo));
  assert.equal((await db.doc(`buscas/${b1.corpo.id}`).get()).data().equipe_id, "farma-norte");
  const partes = await db.collection("buscas").where("mae_id", "==", b1.corpo.id).get();
  assert.ok(partes.docs.every((d) => d.data().equipe_id === "farma-norte"));
  const grande = await pedido(criarBusca, { termos: "a, b, c, d, e, f", cidades: "Natal RN, Parnamirim RN", profundidade: "rapida" }, tn2);
  assert.equal(grande.status, 429); // 2 + 12 consultas > 12 no mês
  assert.match(grande.corpo.erro, /Cota de consultas da equipe no mês: 2 de 12/);
  assert.equal((await pedido(criarBusca, { termos: "drogaria", cidades: "Natal RN", profundidade: "rapida" }, tn2)).status, 201);
  const terceira = await pedido(criarBusca, { termos: "drogaria", cidades: "Mossoró RN", profundidade: "rapida" }, tn1);
  assert.equal(terceira.status, 429);
  assert.match(terceira.corpo.erro, /2 de 2 buscas hoje \(cota da equipe\)/);
  const usoNorte = (await db.doc("equipes/farma-norte").get()).data().uso;
  assert.deepEqual([usoNorte.buscas_dia, usoNorte.consultas_mes], [2, 3]);
  // Master: busca na área dele (_master), sem cota de equipe
  const bm = await pedido(criarBusca, { termos: "clínica", cidades: "Natal RN", profundidade: "rapida" }, tokens.breno);
  assert.equal((await db.doc(`buscas/${bm.corpo.id}`).get()).data().equipe_id, "_master");

  // Carteira isolada por equipe: o mesmo estabelecimento na carteira do Norte e do Sul, sem 409
  const lugar = { nome: "Farmácia Central", cidade: "Natal", id_lugar: "EQX", telefone: "(84) 99999-7777" };
  for (const [id, dono, eq] of [["eqn1", p1.corpo.uid, "farma-norte"], ["eqs1", ps.corpo.uid, "farma-sul"]]) {
    await db.doc(`buscas/${id}`).set({ dono_uid: dono, equipe_id: eq, tipo: "comum", lista: true, status: "concluida", qtd_lotes: 1, resumo: { total: 1 }, criada_em: new Date() });
    await db.doc(`buscas/${id}/lotes/0`).set({ dono_uid: dono, equipe_id: eq, leads: [lugar] });
  }
  const K = chaveLead(lugar), f = fatiaDe(K);
  assert.equal((await pedido(crmLead, { acao: "status", busca_id: "eqn1", chave: K, status: "contatado" }, tn1)).status, 200);
  assert.equal((await pedido(crmLead, { acao: "status", busca_id: "eqs1", chave: K, status: "negociando" }, ts1)).status, 200);
  assert.equal((await db.doc(`carteira/farma-norte__${f}`).get()).data().leads[K].uid, p1.corpo.uid);
  assert.equal((await db.doc(`carteira/farma-sul__${f}`).get()).data().leads[K].uid, ps.corpo.uid);
  assert.equal((await db.doc(`crm/${p1.corpo.uid}__${f}`).get()).data().equipe_id, "farma-norte");
  // Dentro da equipe continua o "sem conflito": o preposto 2 do Norte recebe 409
  await db.doc("buscas/eqn2").set({ dono_uid: p2.corpo.uid, equipe_id: "farma-norte", tipo: "comum", lista: true, status: "concluida", qtd_lotes: 1, criada_em: new Date() });
  await db.doc("buscas/eqn2/lotes/0").set({ dono_uid: p2.corpo.uid, equipe_id: "farma-norte", leads: [lugar] });
  const conflito = await pedido(crmLead, { acao: "status", busca_id: "eqn2", chave: K, status: "contatado" }, tn2);
  assert.equal(conflito.status, 409);
  assert.match(conflito.corpo.erro, /carteira de Preposto Norte 1/);
  // Gestor: transfere só dentro da equipe; vê as carteiras só da equipe dele
  assert.equal((await pedido(crmLead, { acao: "transferir", chave: K, para_uid: ps.corpo.uid }, g1)).status, 403);
  const cg = await pedido(crmLead, { acao: "carteiras" }, g1);
  assert.equal(cg.status, 200);
  assert.ok(cg.corpo.vendedores.every((v) => v.equipe_id === "farma-norte"));
  assert.equal(cg.corpo.vendedores.find((v) => v.uid === p1.corpo.uid).carteira, 1);

  // Apagar: gestor apaga busca da equipe; de outra equipe → 403
  assert.equal((await pedido(apagarBusca, { id: "eqs1" }, g1)).status, 403);
  await db.doc("buscas/eqn3").set({ dono_uid: p2.corpo.uid, equipe_id: "farma-norte", tipo: "comum", lista: true, status: "concluida", qtd_lotes: 0, criada_em: new Date() });
  assert.equal((await pedido(apagarBusca, { id: "eqn3" }, g1)).status, 200);

  // Liberar: gestor repassa busca da equipe só para prepostos da equipe; busca de outra equipe → 403
  assert.equal((await pedido(liberarBusca, { acao: "simular", id: "eqs1" }, g1)).status, 403);
  const sim = await pedido(liberarBusca, { acao: "simular", id: "eqn1" }, g1);
  assert.equal(sim.status, 200);
  assert.deepEqual(sim.corpo.vendedores.map((v) => v.uid), [p2.corpo.uid]); // só a equipe, fora o dono
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "eqn1", vendedores: [ps.corpo.uid], modo: "inteira" }, g1)).status, 400);
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "eqn1", vendedores: [p2.corpo.uid], modo: "inteira" }, g1)).status, 200);
  // Master libera uma lista dele para a equipe inteira: o gestor lê e redistribui; não conta na cota
  await db.doc("buscas/est9").set({ dono_uid: (await auth.getUserByEmail("breno@x.example")).uid, equipe_id: "_master", tipo: "rn_mae", lista: true, status: "concluida", qtd_lotes: 1, resumo: { total: 1 }, criada_em: new Date() });
  await db.doc("buscas/est9/lotes/0").set({ equipe_id: "_master", leads: [{ nome: "Drogaria Estado", cidade: "Mossoró", id_lugar: "EST9" }] });
  assert.equal((await pedido(liberarBusca, { acao: "simular", id: "est9" }, g1)).status, 403); // ainda não liberada
  assert.equal((await pedido(liberarBusca, { acao: "liberar_equipe", id: "est9", equipe_id: "farma-norte" }, g1)).status, 403); // só o master
  assert.equal((await pedido(liberarBusca, { acao: "liberar_equipe", id: "est9", equipe_id: "farma-norte" }, tokens.breno)).status, 200);
  assert.deepEqual((await db.doc("buscas/est9/lotes/0").get()).data().liberada_equipes, ["farma-norte"]);
  assert.equal((await pedido(liberarBusca, { acao: "liberar", id: "est9", vendedores: [p1.corpo.uid], modo: "inteira" }, g1)).status, 200);
  assert.equal((await pedido(liberarBusca, { acao: "simular", id: "est9" }, g2)).status, 403); // outra equipe
  assert.deepEqual((await db.doc("equipes/farma-norte").get()).data().uso.buscas_dia, 2); // não contou
  // Master revoga da equipe: sai também o que o gestor repassou
  assert.equal((await pedido(liberarBusca, { acao: "revogar_equipe", id: "est9", equipe_id: "farma-norte" }, tokens.breno)).status, 200);
  const est9 = (await db.doc("buscas/est9").get()).data();
  assert.deepEqual([est9.liberada_equipes, est9.liberada_para], [[], []]);

  // Desativar preposto com carteira: 409; libera a carteira e desativa
  const des = await pedido(equipeFn, { acao: "desativar_preposto", uid: p1.corpo.uid }, g1);
  assert.equal(des.status, 409);
  assert.match(des.corpo.erro, /1 lead\(s\) na carteira/);
  const tc = await pedido(crmLead, { acao: "transferir_carteira", de_uid: p1.corpo.uid, para_uid: p2.corpo.uid }, g1);
  assert.equal(tc.status, 200);
  assert.equal(tc.corpo.leads, 1);
  assert.equal((await db.doc(`carteira/farma-norte__${f}`).get()).data().leads[K].uid, p2.corpo.uid);
  assert.equal((await pedido(equipeFn, { acao: "desativar_preposto", uid: p1.corpo.uid }, g1)).status, 200);
  assert.equal((await auth.getUser(p1.corpo.uid)).disabled, true);
  assert.equal((await pedido(crmLead, { acao: "liberar_carteira", uid: p2.corpo.uid }, g2)).status, 403); // outra equipe
  assert.equal((await pedido(crmLead, { acao: "liberar_carteira", uid: p2.corpo.uid }, g1)).status, 200);
  assert.equal((await db.doc(`carteira/farma-norte__${f}`).get()).data().leads[K], undefined);

  // Painel da equipe e representadas
  assert.equal((await pedido(equipeFn, { acao: "representadas", lista: ["Marca A", "marca a", " Marca B "] }, g1)).corpo.representadas.join("|"), "Marca A|Marca B");
  const pn = await pedido(equipeFn, { acao: "painel" }, g1);
  assert.equal(pn.status, 200);
  const linha1 = pn.corpo.pessoas.find((x) => x.uid === p1.corpo.uid);
  assert.equal(linha1.buscas, 2); // a dele criada pela tela + a eqn1
  assert.ok(pn.corpo.pessoas.every((x) => [e1.corpo.gestor_uid, p1.corpo.uid, p2.corpo.uid].includes(x.uid)));
  assert.deepEqual(pn.corpo.equipe.representadas, ["Marca A", "Marca B"]);

  // Master desativa a equipe do Sul: as contas de lá são desligadas; reativar volta
  assert.equal((await pedido(equipesFn, { acao: "ativar", id: "farma-sul", ativa: false }, tokens.breno)).status, 200);
  assert.equal((await auth.getUser(ps.corpo.uid)).disabled, true);
  assert.equal((await pedido(equipesFn, { acao: "ativar", id: "farma-sul", ativa: true }, tokens.breno)).status, 200);
  assert.equal((await auth.getUser(ps.corpo.uid)).disabled, false);
  const lista = await pedido(equipesFn, { acao: "listar" }, tokens.breno);
  assert.deepEqual(lista.corpo.equipes.map((x) => x.id), ["farma-norte", "farma-sul"]);
  assert.equal(lista.corpo.equipes[0].usuarios, 2); // gestor + preposto 2 (o 1 foi desativado)
  // Limpeza: buscas deste teste
  for (const id of ["eqn1", "eqn2", "eqs1", "est9", b1.corpo.id, bm.corpo.id]) {
    for (const d of (await db.collection("buscas").where("mae_id", "==", id).get()).docs) await d.ref.delete();
    await db.recursiveDelete(db.doc(`buscas/${id}`));
  }
});
