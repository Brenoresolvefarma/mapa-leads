// Funções de servidor das EQUIPES (usadas por /api/equipes, /api/equipe e pelas Functions que conferem equipe).
// Estrutura (decisões do Breno em 24/09):
//  - equipes/{id} = { nome, ativa, gestor_uid, cotas: {max_usuarios, buscas_dia, consultas_mes} (null = sem limite),
//                     uso: {dia, buscas_dia, mes, consultas_mes}, representadas: [..], criada_em };
//  - usuarios/{uid} ganha equipe_id, papel e ativo; o papel e a equipe também vão nas custom claims do token.
// Log: só ids e números.

import { FieldValue } from "firebase-admin/firestore";
import { FATIAS_CRM, carteiraAtiva, diasCarteira, idCarteira } from "./logica.mjs";
import { ErroHttp, claimsDe } from "./servidor.mjs";

export async function lerEquipe(db, id) {
  if (!id || typeof id !== "string" || id.includes("/")) throw new ErroHttp(400, "Informe a equipe.");
  const doc = await db.doc(`equipes/${id}`).get();
  if (!doc.exists) throw new ErroHttp(404, "Equipe não encontrada.");
  return { id, ...doc.data() };
}

/** Equipe que o pedido pode mexer: gestor → só a dele (outra → 403); master → a informada. */
export function equipeAlvo(usuario, pedida) {
  if (usuario.admin) {
    if (!pedida) throw new ErroHttp(400, "Informe a equipe.");
    return pedida;
  }
  if (!usuario.gestor) throw new ErroHttp(403, "Acesso exclusivo do representante (gestor) da equipe.");
  if (pedida && pedida !== usuario.equipe_id) throw new ErroHttp(403, "Você só mexe na sua equipe.");
  return usuario.equipe_id;
}

/** Membros da equipe (conta do Auth + usuarios/{uid}); removidos ficam de fora. */
export async function membrosDaEquipe(auth, db, equipe) {
  const docs = (await db.collection("usuarios").where("equipe_id", "==", equipe).get()).docs.filter((d) => !d.data().removido);
  if (!docs.length) return [];
  const contas = await auth.getUsers(docs.map((d) => ({ uid: d.id })));
  const porUid = new Map(contas.users.map((u) => [u.uid, u]));
  return docs.filter((d) => porUid.has(d.id)).map((d) => {
    const conta = porUid.get(d.id), p = d.data();
    return { uid: d.id, email: conta.email || "", nome: p.nome || conta.displayName || "", papel: p.papel || "vendedor",
      ativo: !conta.disabled, perfil: p };
  });
}

/** Usuários que contam no limite da equipe: ativos (o gestor conta). */
export const contaNoLimite = (membros) => membros.filter((m) => m.ativo && m.papel !== "master").length;

/** Cria a conta (Auth + claims + usuarios/{uid}). Erros do Auth viram mensagens claras. */
export async function criarConta(auth, db, { email, senha, nome, papel, equipe, extras = {} }) {
  if (!email || !senha) throw new ErroHttp(400, "Informe e-mail e senha.");
  if (String(senha).length < 8) throw new ErroHttp(400, "A senha precisa ter pelo menos 8 caracteres.");
  let conta;
  try {
    conta = await auth.createUser({ email: String(email).trim(), password: String(senha), displayName: nome || undefined });
  } catch (erro) {
    if (erro?.code === "auth/email-already-exists") throw new ErroHttp(409, "Já existe um usuário com esse e-mail.");
    if (erro?.code === "auth/invalid-email") throw new ErroHttp(400, "E-mail inválido.");
    throw new ErroHttp(400, "Não foi possível criar o usuário.");
  }
  await auth.setCustomUserClaims(conta.uid, claimsDe(papel, equipe));
  await db.doc(`usuarios/${conta.uid}`).set({
    email: conta.email, nome: nome || "", papel, equipe_id: equipe, ativo: true, removido: false,
    criado_em: FieldValue.serverTimestamp(), ...extras,
  }, { merge: true });
  return conta.uid;
}

/** Quantos leads estão na carteira (ativa) deste usuário, na carteira da equipe: 16 leituras. */
export async function leadsNaCarteira(db, equipe, uid) {
  const refs = Array.from({ length: FATIAS_CRM }, (_, i) => db.doc(`carteira/${idCarteira(equipe, String(i).padStart(2, "0"))}`));
  const [docs, geral] = await Promise.all([db.getAll(...refs), db.doc("config/geral").get()]);
  const dias = diasCarteira(geral.data()), agora = Date.now();
  let n = 0;
  for (const d of docs) for (const e of Object.values(d.data()?.leads || {})) if (e.uid === uid && carteiraAtiva(e, agora, dias)) n++;
  return n;
}

/** Nome para mostrar ("Na carteira de <nome>", rótulos): nome do perfil, displayName ou o começo do e-mail. */
export async function nomeDe(auth, db, uid) {
  const [conta, perfil] = await Promise.all([auth.getUser(uid).catch(() => null), db.doc(`usuarios/${uid}`).get()]);
  return String(perfil.data()?.nome || conta?.displayName || conta?.email?.split("@")[0] || "vendedor").slice(0, 60);
}
