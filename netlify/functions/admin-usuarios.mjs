// POST /api/admin-usuarios  — SÓ admin (conferido pela claim do token, no servidor).
// Ações: listar | criar | remover | definir_limite | definir_nome | definir_limite_consultas | definir_config
// Não existe cadastro público e não existe "promover a admin" por aqui:
// o admin é definido só pelo workflow "Definir admin" no GitHub.

import { FieldValue } from "firebase-admin/firestore";
import { LIMITE_DIARIO_PADRAO, LIMITES_VENDEDOR_PADRAO, diaFortaleza, diasCarteira, limitesVendedor } from "../lib/logica.mjs";
import { EQUIPE_PADRAO } from "../lib/logica.mjs";
import { criarConta } from "../lib/equipes.mjs";
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
    case "definir_nome":
      return json(200, await definirNome(auth, db, corpo));
    case "definir_limite_consultas":
      return json(200, await definirLimiteConsultas(auth, db, corpo));
    case "definir_config":
      return json(200, await definirConfig(db, corpo));
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
  // Uso da semana por vendedor: estatisticas/{dia}__{uid} dos últimos 7 dias (7 leituras por usuário).
  const dias = Array.from({ length: 7 }, (_, i) => diaFortaleza(new Date(Date.now() - i * 86400000)));
  const refs = contas.users.flatMap((u) => dias.map((d) => db.doc(`estatisticas/${d}__${u.uid}`)));
  const stats = refs.length ? await db.getAll(...refs) : [];
  const semana = new Map();
  for (const s of stats) {
    if (!s.exists) continue;
    const x = s.data(), uid = x.dono_uid, atual = semana.get(uid) || { buscas: 0, leads: 0, com_whatsapp: 0 };
    atual.buscas += x.buscas || 0; atual.leads += x.leads || 0; atual.com_whatsapp += x.com_whatsapp || 0;
    semana.set(uid, atual);
  }
  const usuarios = contas.users.map((u) => {
    const p = perfis.get(u.uid) || {};
    perfis.delete(u.uid);
    return {
      uid: u.uid,
      email: u.email || "",
      nome: p.nome || u.displayName || "",
      admin: u.customClaims?.admin === true || u.customClaims?.papel === "master",
      papel: u.customClaims?.admin === true || u.customClaims?.papel === "master" ? "master" : u.customClaims?.papel || p.papel || "vendedor",
      equipe_id: u.customClaims?.equipe_id || p.equipe_id || EQUIPE_PADRAO,
      ativo: !u.disabled,
      limite_diario: Number.isInteger(p.limite_diario) ? p.limite_diario : null,
      limite_consultas_dia: Number.isInteger(p.limite_consultas_dia) ? p.limite_consultas_dia : null,
      buscas_hoje: p.dia === hoje ? p.contagem_dia || 0 : 0,
      consultas_hoje: p.dia === hoje ? p.consultas_dia || 0 : 0,
      semana: semana.get(u.uid) || { buscas: 0, leads: 0, com_whatsapp: 0 },
      removido: false,
    };
  });
  // Usuários removidos: a conta não existe mais, mas as buscas continuam visíveis ao admin.
  for (const [uid, p] of perfis) {
    if (p.removido) usuarios.push({ uid, email: p.email || "", nome: p.nome || "", admin: false, removido: true });
  }
  const limitePadrao = Number.isInteger(geral.data()?.limite_padrao) ? geral.data().limite_padrao : LIMITE_DIARIO_PADRAO;
  return { usuarios, limite_padrao: limitePadrao, config: configPublica(geral.data() || {}) };
}

// Consultas por dia de um vendedor (null = volta ao padrão de Admin › Configurações).
async function definirLimiteConsultas(auth, db, { uid, limite_consultas_dia }) {
  if (!uid) throw new ErroHttp(400, "Informe o usuário.");
  const usarPadrao = limite_consultas_dia === null;
  if (!usarPadrao && !(Number.isInteger(limite_consultas_dia) && limite_consultas_dia >= 0)) {
    throw new ErroHttp(400, "O limite de consultas precisa ser um número inteiro maior ou igual a zero.");
  }
  try {
    await auth.getUser(uid);
  } catch {
    throw new ErroHttp(404, "Usuário não encontrado.");
  }
  await db.doc(`usuarios/${uid}`).set(
    { limite_consultas_dia: usarPadrao ? FieldValue.delete() : limite_consultas_dia }, { merge: true });
  return { limite_consultas_dia: usarPadrao ? null : limite_consultas_dia };
}

// Admin › Configurações: limites do vendedor por busca e por dia (inteiros de 1 a 10.000).
const configPublica = (geral) => ({ ...limitesVendedor(geral), carteira_dias: diasCarteira(geral) });

async function definirConfig(db, corpo) {
  const novos = {};
  for (const chave of Object.keys(LIMITES_VENDEDOR_PADRAO)) {
    const v = corpo?.[chave];
    if (v === undefined) continue;
    if (!(Number.isInteger(v) && v >= 1 && v <= 10000)) throw new ErroHttp(400, "Cada limite precisa ser um número inteiro de 1 a 10.000.");
    novos[chave] = v;
  }
  // Carteira: dias sem contato até o lead voltar a ficar livre (padrão 60).
  if (corpo?.carteira_dias !== undefined) {
    const v = corpo.carteira_dias;
    if (!(Number.isInteger(v) && v >= 1 && v <= 3650)) throw new ErroHttp(400, "Prazo da carteira: número inteiro de 1 a 3.650 dias.");
    novos.carteira_dias = v;
  }
  if (!Object.keys(novos).length) throw new ErroHttp(400, "Nada para salvar.");
  await db.doc("config/geral").set(novos, { merge: true });
  return { config: configPublica((await db.doc("config/geral").get()).data() || {}) };
}

// Nome mostrado na saudação ("Olá, Breno"): até 60 caracteres, sem espaços sobrando.
const limparNome = (nome) => String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

// Master cria vendedor em qualquer equipe (padrão: a equipe de antes das equipes). Representante novo: aba Equipes.
async function criar(auth, db, { email, senha, nome: nomeBruto, limite_diario, equipe_id }) {
  const equipe = typeof equipe_id === "string" && equipe_id ? equipe_id : EQUIPE_PADRAO;
  if (equipe !== EQUIPE_PADRAO && !(await db.doc(`equipes/${equipe}`).get()).exists) throw new ErroHttp(400, "Equipe não encontrada.");
  const uid = await criarConta(auth, db, { email, senha, nome: limparNome(nomeBruto), papel: "vendedor", equipe,
    extras: Number.isInteger(limite_diario) && limite_diario >= 0 ? { limite_diario } : {} });
  return { uid };
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
  if (conta.customClaims?.admin === true || conta.customClaims?.papel === "master") throw new ErroHttp(400, "Não é possível remover um administrador.");
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

async function definirNome(auth, db, { uid, nome: nomeBruto }) {
  if (!uid) throw new ErroHttp(400, "Informe o usuário.");
  const nome = limparNome(nomeBruto);
  try {
    await auth.updateUser(uid, { displayName: nome || null });
  } catch {
    throw new ErroHttp(404, "Usuário não encontrado.");
  }
  await db.doc(`usuarios/${uid}`).set({ nome }, { merge: true });
  return { nome };
}
