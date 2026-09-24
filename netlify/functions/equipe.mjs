// POST /api/equipe — "Minha equipe": o GESTOR (representante) mexe só na equipe dele; o master pode mexer em qualquer
// uma informando { equipe_id }. Vendedor → 403. Gestor tentando outra equipe → 403.
// Ações:
//  - resumo                                   → equipe (nome, cotas, uso), prepostos com limites e uso de hoje
//  - criar_preposto  { email, senha, nome, limite_diario?, limite_consultas_dia? }   (dentro do limite de usuários)
//  - editar_preposto { uid, nome?, limite_diario?, limite_consultas_dia? }  (limites nunca acima dos da equipe; null = padrão)
//  - desativar_preposto { uid }  → só sem leads na carteira dele (transferir ou liberar antes: /api/crm-lead)
//  - reativar_preposto  { uid }  (dentro do limite de usuários)
//  - representadas { lista }     → nomes das empresas/marcas representadas (só informação: painel e exportação)
//  - painel                      → por preposto: buscas, leads, contatados, negociando, clientes e conversão
// Log: só ids e números.

import { FieldValue } from "firebase-admin/firestore";
import { STATUS_CRM, diaFortaleza, limparRepresentadas, tetoDoPreposto, usoDaEquipe } from "../lib/logica.mjs";
import { contaNoLimite, criarConta, equipeAlvo, leadsNaCarteira, lerEquipe, membrosDaEquipe } from "../lib/equipes.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, logPrivado, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();
  const equipe = await lerEquipe(db, equipeAlvo(usuario, corpo.equipe_id));
  if (equipe.ativa === false && !usuario.admin) throw new ErroHttp(403, "Equipe desativada. Fale com o administrador.");
  switch (corpo.acao) {
    case "resumo": return json(200, await resumo(auth, db, equipe));
    case "criar_preposto": return json(201, await criarPreposto(auth, db, equipe, corpo));
    case "editar_preposto": return json(200, await editarPreposto(auth, db, usuario, equipe, corpo));
    case "desativar_preposto": return json(200, await desativar(auth, db, usuario, equipe, corpo));
    case "reativar_preposto": return json(200, await reativar(auth, db, usuario, equipe, corpo));
    case "representadas": return json(200, await representadas(db, equipe, corpo));
    case "painel": return json(200, await painel(auth, db, equipe));
    default: throw new ErroHttp(400, "Ação inválida.");
  }
});

export const config = { path: "/api/equipe" };

const limparNome = (nome) => String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
const geralDe = async (db) => (await db.doc("config/geral").get()).data() || {};

async function resumo(auth, db, equipe) {
  const [membros, geral] = await Promise.all([membrosDaEquipe(auth, db, equipe.id), geralDe(db)]);
  const hoje = diaFortaleza();
  return {
    equipe: { id: equipe.id, nome: equipe.nome, ativa: equipe.ativa !== false, cotas: equipe.cotas || null, uso: usoDaEquipe(equipe),
      representadas: equipe.representadas || [], gestor_uid: equipe.gestor_uid || null },
    usuarios: contaNoLimite(membros),
    teto: tetoDoPreposto(geral, equipe),
    membros: membros.map((m) => ({
      uid: m.uid, email: m.email, nome: m.nome, papel: m.papel, ativo: m.ativo,
      limite_diario: Number.isInteger(m.perfil.limite_diario) ? m.perfil.limite_diario : null,
      limite_consultas_dia: Number.isInteger(m.perfil.limite_consultas_dia) ? m.perfil.limite_consultas_dia : null,
      buscas_hoje: m.perfil.dia === hoje ? m.perfil.contagem_dia || 0 : 0,
      consultas_hoje: m.perfil.dia === hoje ? m.perfil.consultas_dia || 0 : 0,
    })).sort((a, b) => (a.papel === "gestor" ? -1 : b.papel === "gestor" ? 1 : a.nome.localeCompare(b.nome, "pt-BR"))),
  };
}

/** Limites do preposto: inteiro de 0 até o teto da equipe, ou null (padrão). undefined = não mexe. */
function conferirLimites(corpo, teto) {
  const saida = {};
  for (const k of ["limite_diario", "limite_consultas_dia"]) {
    const v = corpo[k];
    if (v === undefined) continue;
    if (v === null) { saida[k] = null; continue; }
    if (!(Number.isInteger(v) && v >= 0)) throw new ErroHttp(400, "Cada limite precisa ser um número inteiro maior ou igual a zero.");
    if (v > teto[k]) throw new ErroHttp(400, `Limite acima do permitido para a equipe (máximo ${teto[k]}).`);
    saida[k] = v;
  }
  return saida;
}

async function conferirVaga(auth, db, equipe) {
  const max = equipe.cotas?.max_usuarios;
  if (!Number.isInteger(max)) return; // sem limite
  const ativos = contaNoLimite(await membrosDaEquipe(auth, db, equipe.id));
  if (ativos >= max) throw new ErroHttp(409, `A equipe já tem ${ativos} de ${max} usuários (o representante conta). Desative alguém ou peça mais vagas ao administrador.`);
}

async function criarPreposto(auth, db, equipe, corpo) {
  const limites = conferirLimites(corpo, tetoDoPreposto(await geralDe(db), equipe));
  await conferirVaga(auth, db, equipe);
  const extras = {};
  for (const [k, v] of Object.entries(limites)) if (v !== null) extras[k] = v;
  const uid = await criarConta(auth, db, { email: corpo.email, senha: corpo.senha, nome: limparNome(corpo.nome), papel: "vendedor", equipe: equipe.id, extras });
  logPrivado(`equipe: preposto ${uid} criado na equipe ${equipe.id}`);
  return { uid };
}

/** O preposto precisa ser da equipe. Gestor mexe só em vendedor; o master mexe também no gestor. */
async function membro(db, usuario, equipe, uid) {
  if (!uid || typeof uid !== "string" || uid.includes("/")) throw new ErroHttp(400, "Informe o usuário.");
  const p = (await db.doc(`usuarios/${uid}`).get()).data();
  if (!p || p.equipe_id !== equipe.id || p.removido) throw new ErroHttp(403, "Este usuário não é da sua equipe.");
  if (!usuario.admin && (p.papel || "vendedor") !== "vendedor") throw new ErroHttp(403, "Você só mexe nos prepostos da equipe.");
  if (uid === usuario.uid) throw new ErroHttp(400, "Você não pode mexer na sua própria conta por aqui.");
  return p;
}

async function editarPreposto(auth, db, usuario, equipe, corpo) {
  await membro(db, usuario, equipe, corpo.uid);
  const limites = conferirLimites(corpo, tetoDoPreposto(await geralDe(db), equipe));
  const campos = {};
  for (const [k, v] of Object.entries(limites)) campos[k] = v === null ? FieldValue.delete() : v;
  if (corpo.nome !== undefined) {
    const nome = limparNome(corpo.nome);
    await auth.updateUser(corpo.uid, { displayName: nome || null });
    campos.nome = nome;
  }
  if (!Object.keys(campos).length) throw new ErroHttp(400, "Nada para salvar.");
  await db.doc(`usuarios/${corpo.uid}`).set(campos, { merge: true });
  return { uid: corpo.uid };
}

async function desativar(auth, db, usuario, equipe, corpo) {
  await membro(db, usuario, equipe, corpo.uid);
  // Decisão do Breno: antes de desativar, os leads da carteira dele vão para outro preposto ou ficam livres.
  const naCarteira = await leadsNaCarteira(db, equipe.id, corpo.uid);
  if (naCarteira) {
    throw new ErroHttp(409, `Este preposto tem ${naCarteira} lead(s) na carteira. Transfira para outro preposto ou libere a carteira antes de desativar.`);
  }
  await auth.updateUser(corpo.uid, { disabled: true });
  await auth.revokeRefreshTokens(corpo.uid);
  await db.doc(`usuarios/${corpo.uid}`).set({ ativo: false, desativado_em: FieldValue.serverTimestamp() }, { merge: true });
  logPrivado(`equipe: preposto ${corpo.uid} desativado na equipe ${equipe.id}`);
  return { uid: corpo.uid, ativo: false };
}

async function reativar(auth, db, usuario, equipe, corpo) {
  await membro(db, usuario, equipe, corpo.uid);
  await conferirVaga(auth, db, equipe);
  await auth.updateUser(corpo.uid, { disabled: false });
  await db.doc(`usuarios/${corpo.uid}`).set({ ativo: true, desligado_pela_equipe: FieldValue.delete() }, { merge: true });
  return { uid: corpo.uid, ativo: true };
}

async function representadas(db, equipe, corpo) {
  let lista;
  try { lista = limparRepresentadas(corpo.lista); } catch (e) { throw new ErroHttp(400, e.message); }
  await db.doc(`equipes/${equipe.id}`).update({ representadas: lista });
  return { representadas: lista };
}

/**
 * Painel "Minha equipe": por pessoa, buscas e leads (das buscas dela + das listas liberadas para ela) e o funil do
 * mini-CRM (status atual de cada lead): contatados, negociando, clientes; conversão = clientes ÷ (contatados +
 * negociando + clientes). Lê só os documentos das buscas (resumo) e do CRM da equipe — nunca os leads.
 */
async function painel(auth, db, equipe) {
  const [membros, buscas, liberadas, crms] = await Promise.all([
    membrosDaEquipe(auth, db, equipe.id),
    db.collection("buscas").where("equipe_id", "==", equipe.id).get(),
    db.collection("buscas").where("liberada_equipes", "array-contains", equipe.id).get(),
    db.collection("crm").where("equipe_id", "==", equipe.id).get(),
  ]);
  const linhas = new Map(membros.map((m) => [m.uid, { uid: m.uid, nome: m.nome || m.email, papel: m.papel, ativo: m.ativo, buscas: 0, leads: 0,
    ...Object.fromEntries(STATUS_CRM.map((s) => [s, 0])) }]));
  const vistas = new Set();
  for (const d of [...buscas.docs, ...liberadas.docs]) {
    if (vistas.has(d.id)) continue;
    vistas.add(d.id);
    const b = d.data();
    if (!b.lista) continue; // partes e filhas contam pela busca principal
    const dono = linhas.get(b.dono_uid);
    if (dono) { dono.buscas++; dono.leads += Number(b.resumo?.total || 0); }
    for (const [uid, lib] of Object.entries(b.liberacoes || {})) {
      const l = linhas.get(uid);
      if (l && uid !== b.dono_uid) l.leads += Number(lib?.qtd_leads || 0);
    }
  }
  for (const d of crms.docs) {
    const l = linhas.get(d.data().dono_uid);
    if (!l) continue;
    for (const r of Object.values(d.data().leads || {})) if (l[r.s] !== undefined) l[r.s]++;
  }
  const pessoas = [...linhas.values()].map((l) => {
    const trabalhados = l.contatado + l.negociando + l.cliente;
    return { uid: l.uid, nome: l.nome, papel: l.papel, ativo: l.ativo, buscas: l.buscas, leads: l.leads,
      contatados: l.contatado, negociando: l.negociando, clientes: l.cliente, descartados: l.descartado,
      conversao: trabalhados ? l.cliente / trabalhados : null };
  }).sort((a, b) => b.clientes - a.clientes || b.leads - a.leads || a.nome.localeCompare(b.nome, "pt-BR"));
  const soma = (k) => pessoas.reduce((t, p) => t + p[k], 0);
  const trabalhados = soma("contatados") + soma("negociando") + soma("clientes");
  return { equipe: { id: equipe.id, nome: equipe.nome, representadas: equipe.representadas || [] }, pessoas,
    total: { buscas: soma("buscas"), leads: soma("leads"), contatados: soma("contatados"), negociando: soma("negociando"),
      clientes: soma("clientes"), conversao: trabalhados ? soma("clientes") / trabalhados : null } };
}
