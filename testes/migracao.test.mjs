// Teste da migração para EQUIPES (ferramentas/migrar_equipes.mjs) no emulador, com dados fictícios no formato antigo.
// Rodar: npm run test:migracao
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { before, test } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST, FS = process.env.FIRESTORE_EMULATOR_HOST;
const app = initializeApp({ projectId: "demo-mapaleads" }, "teste-migracao");
const auth = getAuth(app), db = getFirestore(app);
const rodar = (modo) => execFileSync("node", ["ferramentas/migrar_equipes.mjs"], { env: { ...process.env, MODO: modo, GCLOUD_PROJECT: "demo-mapaleads" }, encoding: "utf8" });
const uids = {};

before(async () => {
  await fetch(`http://${FS}/emulator/v1/projects/demo-mapaleads/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH}/emulator/v1/projects/demo-mapaleads/accounts`, { method: "DELETE" });
  // Como está hoje: master com admin=true, vendedores sem papel/equipe, carteira/NN, crm sem equipe.
  uids.breno = (await auth.createUser({ email: "breno@x.example", password: "senha-forte-1" })).uid;
  await auth.setCustomUserClaims(uids.breno, { admin: true });
  uids.ana = (await auth.createUser({ email: "ana@x.example", password: "senha-forte-2", displayName: "Ana" })).uid;
  uids.rui = (await auth.createUser({ email: "rui@x.example", password: "senha-forte-3" })).uid;
  await db.doc(`usuarios/${uids.ana}`).set({ email: "ana@x.example", nome: "Ana Souza", limite_diario: 5 });
  await db.doc("usuarios/removido1").set({ email: "saiu@x.example", removido: true });
  await db.doc("buscas/a1").set({ tipo: "comum", lista: true, dono_uid: uids.ana, status: "concluida", qtd_lotes: 1, criada_em: new Date(),
    liberada_para: [uids.rui], liberacoes: { [uids.rui]: { modo: "recorte", qtd_lotes: 1, qtd_leads: 1 } } });
  await db.doc("buscas/a1/lotes/0").set({ dono_uid: uids.ana, leads: [{ nome: "Fictício 1", id_lugar: "L1" }] });
  await db.doc(`buscas/a1/liberacoes/${uids.rui}/lotes/0`).set({ vendedor_uid: uids.rui, leads: [{ nome: "Fictício 1" }] });
  await db.doc("buscas/m1").set({ tipo: "rn_mae", lista: true, dono_uid: uids.breno, status: "concluida", qtd_lotes: 1, criada_em: new Date() });
  await db.doc("buscas/m1/lotes/0").set({ dono_uid: uids.breno, leads: [{ nome: "Do master" }] });
  await db.doc("buscas/f1").set({ tipo: "rn_filha", mae_id: "m1", dono_uid: uids.breno, status: "concluida", qtd_lotes: 0 });
  await db.doc("buscas/r1").set({ tipo: "comum", lista: true, dono_uid: "removido1", status: "concluida", qtd_lotes: 0, criada_em: new Date() });
  await db.doc(`crm/${uids.ana}__03`).set({ dono_uid: uids.ana, leads: { p_L1: { s: "contatado", em: 1 } } });
  await db.doc(`estatisticas/2026-09-23__${uids.ana}`).set({ dono_uid: uids.ana, leads: 3 });
  await db.doc(`estatisticas/2026-09-23__${uids.breno}`).set({ dono_uid: uids.breno, leads: 9 });
  await db.doc("estatisticas/2026-09-23__geral").set({ leads: 12 });
  await db.doc("carteira/03").set({ leads: { p_L1: { uid: uids.ana, nome: "Ana", s: "contatado", desde: 1, ultimo: 100 } } });
});

test("migração: simular não grava nada; aplicar cria a Resolve Farma, põe papel/equipe em tudo e copia a carteira, sem mudar dono", async () => {
  const sim = rodar("simular");
  assert.match(sim, /Migração de equipes \(simular\)/);
  assert.match(sim, /buscas: 4/);
  assert.equal((await db.doc("equipes/resolve-farma").get()).exists, false); // simular não grava
  assert.equal((await auth.getUser(uids.ana)).customClaims, undefined);
  // O log público só tem contagens: nenhum uid nem e-mail
  for (const x of [...Object.values(uids), "ana@x.example"]) assert.ok(!sim.includes(x));

  const apl = rodar("aplicar");
  for (const x of [...Object.values(uids), "ana@x.example", "Fictício"]) assert.ok(!apl.includes(x));
  const eq = (await db.doc("equipes/resolve-farma").get()).data();
  assert.equal(eq.nome, "Resolve Farma");
  assert.deepEqual(eq.cotas, { max_usuarios: null, buscas_dia: null, consultas_mes: null }); // sem limite
  assert.deepEqual((await auth.getUser(uids.breno)).customClaims, { admin: true, papel: "master", equipe_id: "resolve-farma" });
  assert.deepEqual((await auth.getUser(uids.ana)).customClaims, { papel: "vendedor", equipe_id: "resolve-farma" });
  const ana = (await db.doc(`usuarios/${uids.ana}`).get()).data();
  assert.deepEqual([ana.equipe_id, ana.papel, ana.ativo, ana.nome, ana.limite_diario], ["resolve-farma", "vendedor", true, "Ana Souza", 5]);
  assert.equal((await db.doc(`usuarios/${uids.rui}`).get()).data().equipe_id, "resolve-farma");
  assert.equal((await db.doc("usuarios/removido1").get()).data().equipe_id, "resolve-farma");
  // Buscas: donos iguais; as do master na área dele
  const a1 = (await db.doc("buscas/a1").get()).data();
  assert.deepEqual([a1.dono_uid, a1.equipe_id, a1.liberacoes[uids.rui].equipe_id, a1.liberacoes[uids.rui].qtd_leads], [uids.ana, "resolve-farma", "resolve-farma", 1]);
  assert.equal((await db.doc("buscas/a1/lotes/0").get()).data().equipe_id, "resolve-farma");
  assert.equal((await db.doc("buscas/a1/lotes/0").get()).data().leads[0].nome, "Fictício 1");
  assert.equal((await db.doc(`buscas/a1/liberacoes/${uids.rui}/lotes/0`).get()).data().equipe_id, "resolve-farma");
  for (const id of ["m1", "f1"]) assert.equal((await db.doc(`buscas/${id}`).get()).data().equipe_id, "_master");
  assert.equal((await db.doc("buscas/m1/lotes/0").get()).data().equipe_id, "_master");
  assert.equal((await db.doc("buscas/r1").get()).data().equipe_id, "resolve-farma");
  assert.equal((await db.doc(`crm/${uids.ana}__03`).get()).data().equipe_id, "resolve-farma");
  assert.equal((await db.doc(`estatisticas/2026-09-23__${uids.ana}`).get()).data().equipe_id, "resolve-farma");
  assert.equal((await db.doc(`estatisticas/2026-09-23__${uids.breno}`).get()).data().equipe_id, "_master");
  assert.equal((await db.doc("estatisticas/2026-09-23__geral").get()).data().equipe_id, undefined);
  // Carteira copiada (a antiga continua até o "limpar")
  assert.deepEqual((await db.doc("carteira/resolve-farma__03").get()).data().leads.p_L1, { uid: uids.ana, nome: "Ana", s: "contatado", desde: 1, ultimo: 100 });
  assert.equal((await db.doc("carteira/03").get()).exists, true);

  // Idempotente: rodar de novo não tem nada a fazer; um contato mais novo na antiga (antes do deploy) é trazido
  assert.match(rodar("aplicar"), /nada a fazer/);
  await db.doc("carteira/03").set({ leads: { p_L1: { uid: uids.ana, nome: "Ana", s: "negociando", desde: 1, ultimo: 200 } } });
  assert.match(rodar("aplicar"), /leads da carteira copiados: 1/);
  assert.equal((await db.doc("carteira/resolve-farma__03").get()).data().leads.p_L1.s, "negociando");
  // Limpar a carteira antiga
  assert.match(rodar("limpar_carteira_antiga"), /documentos antigos apagados: 1/);
  assert.equal((await db.doc("carteira/03").get()).exists, false);
});
