// Migração para EQUIPES (master › gestor › vendedor), decisão do Breno em 24/09.
// Roda pelo workflow manual "Migrar equipes" (FIREBASE_SERVICE_ACCOUNT) ou no emulador (FIRESTORE_EMULATOR_HOST, para teste).
//
// MODO=simular  → só conta o que mudaria (nada é gravado).
// MODO=aplicar  → grava. Idempotente: pode rodar de novo (só completa o que falta; nada é apagado nem muda de dono).
// MODO=limpar_carteira_antiga → apaga carteira/NN (formato antigo) SÓ se carteira/resolve-farma__NN já tem todas as chaves.
//
// O que faz no "aplicar":
//  1. cria equipes/resolve-farma ("Resolve Farma", SEM limite de cotas — decisão do Breno);
//  2. claims: o master (admin=true) ganha papel=master; os demais sem papel viram vendedor da Resolve Farma
//     (quem já tem papel/equipe fica como está); usuarios/{uid} ganha equipe_id, papel e ativo;
//  3. buscas (e partes/filhas), lotes, cópias liberadas, liberacoes.{uid}, crm e estatísticas ganham equipe_id
//     (busca do master → "_master": área só dele; dos outros → a equipe do dono);
//  4. carteira/NN → carteira/resolve-farma__NN (junta com o que já houver lá, ficando com o contato mais recente).
// Log PÚBLICO (repositório aberto): só contagens. Nunca uid, e-mail, nome, termo, cidade ou lead.

import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const EQUIPE = "resolve-farma", MASTER = "_master";
const MODO = process.env.MODO || "simular";
if (!["simular", "aplicar", "limpar_carteira_antiga"].includes(MODO)) { console.error("MODO inválido."); process.exit(1); }
const gravar = MODO !== "simular";

const app = process.env.FIRESTORE_EMULATOR_HOST
  ? initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-mapaleads" }, "migrar-equipes")
  : initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) }, "migrar-equipes");
const auth = getAuth(app), db = getFirestore(app);

const conta = {};
const somar = (k, n = 1) => { conta[k] = (conta[k] || 0) + n; };

// Gravações em lotes de até 400 (o limite do Firestore é 500 por batch).
let lote = db.batch(), noLote = 0;
async function atualizar(ref, campos, tipo) {
  somar(tipo);
  if (!gravar) return;
  lote.set(ref, campos, { merge: true });
  if (++noLote >= 400) { await lote.commit(); lote = db.batch(); noLote = 0; }
}
async function fecharLote() { if (gravar && noLote) await lote.commit(); lote = db.batch(); noLote = 0; }

export async function migrar() {
  if (MODO === "limpar_carteira_antiga") return limparCarteiraAntiga();

  // 1. Equipe Resolve Farma (sem limite)
  const refEq = db.doc(`equipes/${EQUIPE}`);
  if (!(await refEq.get()).exists) {
    await atualizar(refEq, { nome: "Resolve Farma", ativa: true, gestor_uid: null, cotas: { max_usuarios: null, buscas_dia: null, consultas_mes: null },
      uso: {}, representadas: [], criada_em: new Date() }, "equipe criada");
  }

  // 2. Usuários: claims + usuarios/{uid}
  const equipeDe = new Map(), master = new Set();
  let pagina;
  do {
    const r = await auth.listUsers(1000, pagina);
    for (const u of r.users) {
      const c = u.customClaims || {};
      const ehMaster = c.admin === true || c.papel === "master";
      const papel = ehMaster ? "master" : c.papel === "gestor" ? "gestor" : "vendedor";
      const equipe = c.equipe_id || EQUIPE;
      const novas = ehMaster ? { ...c, admin: true, papel: "master", equipe_id: equipe } : { ...c, papel, equipe_id: equipe };
      if (JSON.stringify(novas) !== JSON.stringify(c)) {
        somar(ehMaster ? "claims do master" : "claims de vendedor");
        if (gravar) await auth.setCustomUserClaims(u.uid, novas);
      }
      equipeDe.set(u.uid, equipe);
      if (ehMaster) master.add(u.uid);
      const perfil = (await db.doc(`usuarios/${u.uid}`).get()).data() || {};
      const campos = {};
      if (!perfil.equipe_id) campos.equipe_id = equipe;
      if (!perfil.papel) campos.papel = papel;
      if (perfil.ativo === undefined) campos.ativo = !u.disabled;
      if (!perfil.email && u.email) campos.email = u.email;
      if (Object.keys(campos).length) await atualizar(db.doc(`usuarios/${u.uid}`), campos, "usuarios");
    }
    pagina = r.pageToken;
  } while (pagina);
  // Removidos (sem conta no Auth): continuam visíveis ao master; ganham a equipe padrão.
  for (const d of (await db.collection("usuarios").get()).docs) {
    if (equipeDe.has(d.id)) continue;
    equipeDe.set(d.id, d.data().equipe_id || EQUIPE);
    if (!d.data().equipe_id) await atualizar(d.ref, { equipe_id: EQUIPE }, "usuarios removidos");
  }
  const equipeDoDono = (uid) => (master.has(uid) ? MASTER : equipeDe.get(uid) || EQUIPE);

  // 3. Buscas, lotes, cópias liberadas
  const buscas = (await db.collection("buscas").get()).docs;
  const porId = new Map(buscas.map((d) => [d.id, d.data()]));
  for (const d of buscas) {
    const b = d.data();
    // Partes/filhas: a equipe da busca principal (mesmo dono).
    const equipe = b.equipe_id || porId.get(b.mae_id)?.equipe_id || equipeDoDono(b.dono_uid);
    const campos = {};
    if (!b.equipe_id) campos.equipe_id = equipe;
    const libs = Object.entries(b.liberacoes || {}).filter(([, l]) => l && !l.equipe_id);
    if (libs.length) campos.liberacoes = Object.fromEntries(libs.map(([uid]) => [uid, { equipe_id: equipeDe.get(uid) || EQUIPE }]));
    if (Object.keys(campos).length) await atualizar(d.ref, campos, "buscas");
    for (const l of (await d.ref.collection("lotes").get()).docs) {
      if (!l.data().equipe_id) await atualizar(l.ref, { equipe_id: equipe }, "lotes");
    }
    for (const uid of Object.keys(b.liberacoes || {})) {
      for (const c of (await d.ref.collection("liberacoes").doc(uid).collection("lotes").get()).docs) {
        if (!c.data().equipe_id) await atualizar(c.ref, { equipe_id: equipeDe.get(uid) || EQUIPE }, "cópias liberadas");
      }
    }
  }

  // CRM e estatísticas
  for (const d of (await db.collection("crm").get()).docs) {
    if (!d.data().equipe_id) await atualizar(d.ref, { equipe_id: equipeDe.get(d.data().dono_uid || d.id.split("__")[0]) || EQUIPE }, "crm");
  }
  for (const d of (await db.collection("estatisticas").get()).docs) {
    const uid = d.id.split("__")[1];
    if (!uid || uid === "geral" || d.data().equipe_id) continue;
    await atualizar(d.ref, { equipe_id: equipeDoDono(uid) === MASTER ? MASTER : equipeDe.get(uid) || EQUIPE }, "estatisticas");
  }
  await fecharLote();

  // 4. Carteira: carteira/NN → carteira/resolve-farma__NN (fica o contato mais recente de cada estabelecimento)
  for (const d of (await db.collection("carteira").get()).docs) {
    if (!/^\d{2}$/.test(d.id)) continue;
    const refNova = db.doc(`carteira/${EQUIPE}__${d.id}`);
    const nova = (await refNova.get()).data()?.leads || {};
    const juntar = {};
    for (const [k, e] of Object.entries(d.data().leads || {})) {
      if (!nova[k] || Number(e.ultimo || 0) > Number(nova[k].ultimo || 0)) juntar[k] = e;
    }
    if (Object.keys(juntar).length) {
      somar("leads da carteira copiados", Object.keys(juntar).length);
      await atualizar(refNova, { leads: juntar }, "documentos da carteira");
    }
  }
  await fecharLote();
  return conta;
}

async function limparCarteiraAntiga() {
  for (const d of (await db.collection("carteira").get()).docs) {
    if (!/^\d{2}$/.test(d.id)) continue;
    const nova = (await db.doc(`carteira/${EQUIPE}__${d.id}`).get()).data()?.leads || {};
    const faltam = Object.keys(d.data().leads || {}).filter((k) => !nova[k]);
    if (faltam.length) { somar("documentos antigos mantidos (faltam chaves na nova; rode aplicar antes)"); continue; }
    somar("documentos antigos apagados");
    if (gravar) await d.ref.delete();
  }
  return conta;
}

const resultado = await migrar();
console.log(`Migração de equipes (${MODO}):`);
for (const [k, v] of Object.entries(resultado)) console.log(`  ${k}: ${v}`);
if (!Object.keys(resultado).length) console.log("  nada a fazer (já migrado).");
