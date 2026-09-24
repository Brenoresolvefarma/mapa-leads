// POST /api/equipes — SÓ o master (claim conferida no servidor). Aba "Equipes" da tela.
// Ações:
//  - listar                                  → equipes com cotas, uso do dia/mês, nº de usuários e o gestor
//  - criar   { nome, gestor: {email, senha, nome}, cotas? }  → equipe nova + a conta do representante (gestor)
//  - editar  { id, nome?, cotas? }           → cotas: número ou null (sem limite)
//  - ativar  { id, ativa }                   → desativar desliga todas as contas da equipe (os dados ficam)
// Os usuários de uma equipe são mexidos por /api/equipe (o master também pode, informando a equipe).
// Log: só ids e números.

import { FieldValue } from "firebase-admin/firestore";
import { COTAS_EQUIPE_PADRAO, EQUIPE_MASTER, idDaEquipe, usoDaEquipe, validarCotas } from "../lib/logica.mjs";
import { contaNoLimite, criarConta, lerEquipe, membrosDaEquipe } from "../lib/equipes.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, logPrivado, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  if (!usuario.admin) throw new ErroHttp(403, "Acesso exclusivo do administrador master.");
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();
  switch (corpo.acao) {
    case "listar": return json(200, await listar(auth, db));
    case "criar": return json(201, await criar(auth, db, corpo));
    case "editar": return json(200, await editar(db, corpo));
    case "ativar": return json(200, await ativar(auth, db, usuario, corpo));
    default: throw new ErroHttp(400, "Ação inválida.");
  }
});

export const config = { path: "/api/equipes" };

const limparNome = (nome) => String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

async function listar(auth, db) {
  const docs = (await db.collection("equipes").get()).docs;
  const equipes = [];
  for (const d of docs) {
    const e = d.data(), membros = await membrosDaEquipe(auth, db, d.id);
    const gestor = membros.find((m) => m.uid === e.gestor_uid);
    equipes.push({
      id: d.id, nome: e.nome || d.id, ativa: e.ativa !== false, cotas: e.cotas || null, uso: usoDaEquipe(e),
      representadas: e.representadas || [], usuarios: contaNoLimite(membros), total_membros: membros.length,
      gestor: gestor ? { uid: gestor.uid, nome: gestor.nome, email: gestor.email } : null,
    });
  }
  equipes.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return { equipes, cotas_padrao: COTAS_EQUIPE_PADRAO };
}

async function criar(auth, db, corpo) {
  const nome = limparNome(corpo.nome);
  if (!nome) throw new ErroHttp(400, "Informe o nome da equipe.");
  const g = corpo.gestor || {};
  let cotas;
  try { cotas = { ...COTAS_EQUIPE_PADRAO, ...validarCotas(corpo.cotas || {}) }; } catch (e) { throw new ErroHttp(400, e.message); }
  // Id pelo nome; se já existir, acrescenta um número.
  const base = idDaEquipe(nome);
  if (base === EQUIPE_MASTER || base.startsWith("_")) throw new ErroHttp(400, "Nome de equipe inválido.");
  let id = base;
  for (let n = 2; (await db.doc(`equipes/${id}`).get()).exists; n++) id = `${base}-${n}`;
  await db.doc(`equipes/${id}`).set({ nome, ativa: true, gestor_uid: null, cotas, uso: {}, representadas: [], criada_em: FieldValue.serverTimestamp() });
  let uid;
  try {
    uid = await criarConta(auth, db, { email: g.email, senha: g.senha, nome: limparNome(g.nome), papel: "gestor", equipe: id });
  } catch (e) {
    await db.doc(`equipes/${id}`).delete(); // sem representante, a equipe não fica pela metade
    throw e;
  }
  await db.doc(`equipes/${id}`).update({ gestor_uid: uid });
  logPrivado(`equipes: equipe ${id} criada com o gestor ${uid}`);
  return { id, gestor_uid: uid };
}

async function editar(db, corpo) {
  const equipe = await lerEquipe(db, corpo.id);
  const campos = {};
  if (corpo.nome !== undefined) {
    const nome = limparNome(corpo.nome);
    if (!nome) throw new ErroHttp(400, "Informe o nome da equipe.");
    campos.nome = nome;
  }
  if (corpo.cotas !== undefined) {
    try { campos.cotas = { ...(equipe.cotas || {}), ...validarCotas(corpo.cotas) }; } catch (e) { throw new ErroHttp(400, e.message); }
  }
  if (!Object.keys(campos).length) throw new ErroHttp(400, "Nada para salvar.");
  await db.doc(`equipes/${equipe.id}`).update(campos);
  return { id: equipe.id, ...campos };
}

async function ativar(auth, db, usuario, corpo) {
  const equipe = await lerEquipe(db, corpo.id);
  const ativa = corpo.ativa === true;
  const membros = await membrosDaEquipe(auth, db, equipe.id);
  for (const m of membros) {
    if (m.uid === usuario.uid || m.papel === "master") continue; // o master nunca se desliga
    if (!ativa && m.ativo) {
      await auth.updateUser(m.uid, { disabled: true });
      await auth.revokeRefreshTokens(m.uid);
      await db.doc(`usuarios/${m.uid}`).set({ ativo: false, desligado_pela_equipe: true }, { merge: true });
    }
    // Reativar volta só quem a equipe desligou (preposto desativado antes pelo gestor continua desativado).
    if (ativa && m.perfil.desligado_pela_equipe) {
      await auth.updateUser(m.uid, { disabled: false });
      await db.doc(`usuarios/${m.uid}`).set({ ativo: true, desligado_pela_equipe: FieldValue.delete() }, { merge: true });
    }
  }
  await db.doc(`equipes/${equipe.id}`).update({ ativa });
  logPrivado(`equipes: equipe ${equipe.id} ${ativa ? "reativada" : "desativada"} (${membros.length} conta(s))`);
  return { id: equipe.id, ativa };
}
