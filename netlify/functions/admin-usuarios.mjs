// POST /api/admin-usuarios  — SÓ admin (conferido pela claim do token, no servidor).
// Ações: listar | criar | remover | definir_limite
// Não existe cadastro público e não existe "promover a admin" por aqui:
// o admin é definido só pelo workflow "Definir admin" no GitHub.

import { FieldValue } from "firebase-admin/firestore";
import { LIMITE_DIARIO_PADRAO, diaFortaleza } from "../lib/logica.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  if (!usuario.admin) throw new ErroHttp(403, "Acesso exclusivo do administrador.");
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();

  switch (corpo.acao) {
    case "listar":
      return json(200, await listar(auth, db));
    case "criar":
      return json(201, await criar(auth, db, corpo));
    case "remover":
      return json(200, await remover(auth, db, usuario, corpo));
    case "definir_limite":
      return json(200, await definirLimite(auth, db, corpo));
    default:
      throw new ErroHttp(400, "Ação inválida.");
  }
});

export const config = { path: "/api/admin-usuarios" };

async function listar(auth, db) {
  const [contas, docs, geral] = await Promise.all([
    auth.listUsers(1000),
    db.collection("usuarios").get(),
    db.doc("config/geral").get(),
  ]);
  const perfis = new Map(docs.docs.map((d) => [d.id, d.data()]));
  const hoje = diaFortaleza();
  const usuarios = contas.users.map((u) => {
    const p = perfis.get(u.uid) || {};
    perfis.delete(u.uid);
    return {
      uid: u.uid,
      email: u.email || "",
      nome: p.nome || u.displayName || "",
      admin: u.customClaims?.admin === true,
      limite_diario: Number.isInteger(p.limite_diario) ? p.limite_diario : null,
      buscas_hoje: p.dia === hoje ? p.contagem_dia || 0 : 0,
      removido: false,
    };
  });
  // Usuários removidos: a conta não existe mais, mas as buscas continuam visíveis ao admin.
  for (const [uid, p] of perfis) {
    if (p.removido) usuarios.push({ uid, email: p.email || "", nome: p.nome || "", admin: false, removido: true });
  }
  const limitePadrao = Number.isInteger(geral.data()?.limite_padrao) ? geral.data().limite_padrao : LIMITE_DIARIO_PADRAO;
  return { usuarios, limite_padrao: limitePadrao };
}

async function criar(auth, db, { email, senha, nome, limite_diario }) {
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
  await db.doc(`usuarios/${conta.uid}`).set({
    email: conta.email,
    nome: nome || "",
    ...(Number.isInteger(limite_diario) && limite_diario >= 0 ? { limite_diario } : {}),
    criado_em: FieldValue.serverTimestamp(),
    removido: false,
  }, { merge: true });
  return { uid: conta.uid };
}

async function remover(auth, db, admin, { uid }) {
  if (!uid) throw new ErroHttp(400, "Informe o usuário.");
  if (uid === admin.uid) throw new ErroHttp(400, "Você não pode remover a si mesmo.");
  let conta;
  try {
    conta = await auth.getUser(uid);
  } catch {
    throw new ErroHttp(404, "Usuário não encontrado.");
  }
  if (conta.customClaims?.admin === true) throw new ErroHttp(400, "Não é possível remover um administrador.");
  await auth.deleteUser(uid);
  // As buscas do usuário continuam no banco, visíveis para o admin, marcadas como "removido".
  await db.doc(`usuarios/${uid}`).set({
    email: conta.email || "",
    removido: true,
    removido_em: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { removido: true };
}

async function definirLimite(auth, db, { uid, limite_diario }) {
  if (!uid) throw new ErroHttp(400, "Informe o usuário.");
  const usarPadrao = limite_diario === null;
  if (!usarPadrao && !(Number.isInteger(limite_diario) && limite_diario >= 0)) {
    throw new ErroHttp(400, "O limite precisa ser um número inteiro maior ou igual a zero.");
  }
  try {
    await auth.getUser(uid);
  } catch {
    throw new ErroHttp(404, "Usuário não encontrado.");
  }
  await db.doc(`usuarios/${uid}`).set(
    { limite_diario: usarPadrao ? FieldValue.delete() : limite_diario },
    { merge: true },
  );
  return { limite_diario: usarPadrao ? null : limite_diario };
}
