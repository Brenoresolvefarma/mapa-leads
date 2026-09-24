// POST /api/liberar-busca — master ou gestor (papel conferido no servidor). Libera uma busca (lista de leads)
// para um ou mais vendedores.
//  - master: qualquer busca, para vendedores de qualquer equipe, ou para uma EQUIPE inteira (o gestor redistribui);
//  - gestor: buscas da equipe dele ou liberadas para a equipe dele, só para os prepostos da equipe (outra → 403).
// Ações:
//  - simular  { id, vendedores?, modo?, cidades?, dividir? } → vendedores disponíveis, leads por cidade e,
//             com vendedores, quantos leads cada um recebe (nada é gravado). Master: também as equipes.
//  - liberar  { id, vendedores, modo: "inteira" | "cidades", cidades?, dividir? }
//  - revogar  { id, uid } → a lista some para aquele vendedor.
//  - liberar_equipe { id, equipe_id } / revogar_equipe { id, equipe_id } (só master): lista inteira para a equipe;
//    revogar tira também o que o gestor dela tinha repassado aos prepostos. Não conta na cota da equipe.
//
// Como fica no Firestore (o navegador continua sem gravar nada):
//  - buscas/{id}.liberada_para = [uid, ...] (todos que receberam) e buscas/{id}.liberacoes.{uid} =
//    { modo, cidades, qtd_lotes, qtd_leads, dividida, rotulo, liberada_em, liberada_por };
//  - "inteira": os lotes da busca ganham liberada_para (a regra deixa o vendedor ler esses lotes);
//  - "recorte" (só algumas cidades e/ou dividida entre vendedores): cópia SÓ com os leads das cidades do vendedor
//    em buscas/{id}/liberacoes/{uid}/lotes/{n} — documentos separados por vendedor, para a regra filtrar pelo caminho.
// Não conta na cota diária do vendedor. Log só com ids e números (nada de leads).

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { EQUIPE_MASTER, carteiraAtiva, chaveLead, cidadeDoLead, diasCarteira, equipeDaBusca, fatiaDe, idCarteira, planoLiberacao } from "../lib/logica.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, logPrivado, usuarioDoToken } from "../lib/servidor.mjs";

const FINAIS = ["concluida", "erro", "cancelada"];
const POR_LOTE = 300;
const MAX_VENDEDORES = 20;

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  if (!usuario.admin && !usuario.gestor) throw new ErroHttp(403, "Só o administrador ou o representante liberam buscas para vendedores.");
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();
  const { id } = corpo;
  if (!id || typeof id !== "string" || id.includes("/")) throw new ErroHttp(400, "Informe a busca.");
  const ref = db.doc(`buscas/${id}`);
  const doc = await ref.get();
  if (!doc.exists) throw new ErroHttp(404, "Busca não encontrada.");
  const busca = doc.data();
  // Gestor: só busca da equipe dele ou liberada para a equipe dele (mesma resposta de "não existe" para as outras).
  const daEquipe = equipeDaBusca(busca) === usuario.equipe_id || (busca.liberada_equipes || []).includes(usuario.equipe_id);
  if (!usuario.admin && !daEquipe) throw new ErroHttp(403, "Esta busca não é da sua equipe.");

  if (corpo.acao === "revogar") return json(200, await revogar(db, usuario, ref, busca, corpo.uid));
  if (corpo.acao === "liberar_equipe" || corpo.acao === "revogar_equipe") {
    if (!usuario.admin) throw new ErroHttp(403, "Só o administrador libera listas para uma equipe inteira.");
    return json(200, await (corpo.acao === "liberar_equipe" ? liberarEquipe : revogarEquipe)(db, usuario, ref, busca, corpo.equipe_id));
  }
  if (corpo.acao !== "simular" && corpo.acao !== "liberar") throw new ErroHttp(400, "Ação inválida.");

  if (busca.tipo === "parte" || busca.tipo === "rn_filha") throw new ErroHttp(400, "Libere pela busca principal.");
  if (!FINAIS.includes(busca.status)) throw new ErroHttp(409, "Só dá para liberar busca terminada.");
  const qtdLotes = Number(busca.qtd_lotes) || 0;
  if (!qtdLotes) throw new ErroHttp(400, "Esta busca não tem leads para liberar.");

  const disponiveis = await vendedoresDisponiveis(auth, db, usuario, busca.dono_uid);
  const leads = await lerLeads(db, ref, qtdLotes);
  const vendedores = corpo.vendedores === undefined && corpo.acao === "simular" ? [] : conferirVendedores(corpo.vendedores, disponiveis);
  const equipeDoVendedor = new Map(disponiveis.map((v) => [v.uid, v.equipe_id]));
  const donoDe = corpo.dividir && vendedores.length > 1 ? await donosNaCarteira(db, leads, vendedores, equipeDoVendedor) : () => null;
  let plano;
  try {
    plano = planoLiberacao(leads, { vendedores, modo: corpo.modo || "inteira", cidades: Array.isArray(corpo.cidades) ? corpo.cidades.map(String) : [], dividir: !!corpo.dividir, donoDe });
  } catch (e) { throw new ErroHttp(400, e.message); }

  if (corpo.acao === "simular") {
    const equipes = usuario.admin ? (await db.collection("equipes").get()).docs.filter((d) => d.data().ativa !== false)
      .map((d) => ({ id: d.id, nome: d.data().nome || d.id, liberada: (busca.liberada_equipes || []).includes(d.id) }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")) : [];
    return json(200, { vendedores: disponiveis.map(({ uid, rotulo }) => ({ uid, rotulo })), equipes, total: leads.length, ...plano });
  }
  const rotulos = new Map(disponiveis.map((v) => [v.uid, v.rotulo]));
  await liberar(db, ref, busca, leads, qtdLotes, plano, !!corpo.dividir && vendedores.length > 1, rotulos, usuario.uid, donoDe, equipeDoVendedor);
  const somaLeads = plano.por_vendedor.reduce((t, p) => t + p.leads, 0);
  logPrivado(`liberar-busca: busca ${id} liberada para ${vendedores.length} vendedor(es) (${corpo.modo || "inteira"}${corpo.dividir ? ", dividida" : ""}), ${somaLeads} leads no total`);
  return json(200, { resultado: "liberada", por_vendedor: plano.por_vendedor });
});

export const config = { path: "/api/liberar-busca" };

/**
 * Dono (uid) de cada lead na carteira agora, nas carteiras das equipes dos vendedores escolhidos (cada equipe tem a sua;
 * até 16 leituras por equipe). Lead na carteira de alguém de uma equipe que não está recebendo = livre para os outros.
 */
async function donosNaCarteira(db, leads, vendedores, equipeDoVendedor) {
  const equipes = [...new Set(vendedores.map((u) => equipeDoVendedor.get(u)).filter(Boolean))];
  const fatias = [...new Set(leads.map((l) => fatiaDe(chaveLead(l))))];
  const pares = equipes.flatMap((e) => fatias.map((f) => [e, f]));
  const [docs, geral] = await Promise.all([db.getAll(...pares.map(([e, f]) => db.doc(`carteira/${idCarteira(e, f)}`))), db.doc("config/geral").get()]);
  const dias = diasCarteira(geral.data()), agora = Date.now(), cart = new Map();
  docs.forEach((d, i) => cart.set(pares[i].join("|"), d.data()?.leads || {}));
  return (l) => {
    const k = chaveLead(l), f = fatiaDe(k);
    for (const e of equipes) { const x = cart.get(`${e}|${f}`)?.[k]; if (carteiraAtiva(x, agora, dias)) return x.uid; }
    return null;
  };
}

/**
 * Vendedores que podem receber, fora o dono da busca e contas desativadas:
 * master → todos os não-master (de todas as equipes, com o nome da equipe no rótulo); gestor → os prepostos da equipe dele.
 */
async function vendedoresDisponiveis(auth, db, usuario, donoUid) {
  const [contas, perfis, equipes] = await Promise.all([
    auth.listUsers(1000),
    (usuario.admin ? db.collection("usuarios") : db.collection("usuarios").where("equipe_id", "==", usuario.equipe_id)).get(),
    usuario.admin ? db.collection("equipes").get() : null,
  ]);
  const perfil = new Map(perfis.docs.map((d) => [d.id, d.data()]));
  const nomeEquipe = new Map((equipes?.docs || []).map((d) => [d.id, d.data().nome || d.id]));
  const doMaster = (u) => u.customClaims?.admin || u.customClaims?.papel === "master";
  return contas.users
    .filter((u) => !u.disabled && !doMaster(u) && u.uid !== donoUid)
    .map((u) => ({ u, p: perfil.get(u.uid) || {}, equipe: u.customClaims?.equipe_id || perfil.get(u.uid)?.equipe_id || "resolve-farma" }))
    .filter(({ u, p, equipe }) => usuario.admin || (equipe === usuario.equipe_id && (u.customClaims?.papel || p.papel || "vendedor") === "vendedor"))
    .map(({ u, p, equipe }) => {
      const nome = p.nome || u.displayName || u.email || "vendedor";
      return { uid: u.uid, equipe_id: equipe, rotulo: usuario.admin && equipes?.size > 1 ? `${nome} · ${nomeEquipe.get(equipe) || equipe}` : nome };
    })
    .sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR"));
}

function conferirVendedores(lista, disponiveis) {
  if (!Array.isArray(lista) || !lista.length) throw new ErroHttp(400, "Escolha pelo menos um vendedor.");
  const unicos = [...new Set(lista.map(String))];
  if (unicos.length > MAX_VENDEDORES) throw new ErroHttp(400, `No máximo ${MAX_VENDEDORES} vendedores por vez.`);
  const validos = new Set(disponiveis.map((v) => v.uid));
  if (unicos.some((u) => !validos.has(u))) throw new ErroHttp(400, "Vendedor inválido (conta removida, admin ou dono da busca).");
  return unicos;
}

async function lerLeads(db, ref, qtdLotes) {
  const lotes = await db.getAll(...Array.from({ length: qtdLotes }, (_, n) => ref.collection("lotes").doc(String(n))));
  return lotes.flatMap((l) => l.data()?.leads || []);
}

/** Grava em lotes de até 450 operações (o limite do Firestore é 500 por batch). */
async function gravar(db, ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const lote = db.batch();
    for (const op of ops.slice(i, i + 450)) op(lote);
    await lote.commit();
  }
}

/** Operações que desfazem a liberação atual de um vendedor (antes de liberar de novo ou ao revogar). */
function desfazer(ref, busca, uid, atual) {
  const ops = [];
  if (atual.modo === "inteira") {
    for (let n = 0; n < (Number(busca.qtd_lotes) || 0); n++) {
      ops.push((b) => b.update(ref.collection("lotes").doc(String(n)), { liberada_para: FieldValue.arrayRemove(uid) }));
    }
  } else {
    for (let n = 0; n < (Number(atual.qtd_lotes) || 0); n++) {
      ops.push((b) => b.delete(ref.collection("liberacoes").doc(uid).collection("lotes").doc(String(n))));
    }
  }
  return ops;
}

async function liberar(db, ref, busca, leads, qtdLotes, plano, dividida, rotulos, adminUid, donoDe, equipeDoVendedor) {
  const ops = [];
  const campos = [];
  const recorte = plano.cidades_recorte ? new Set(plano.cidades_recorte) : null;
  for (const p of plano.por_vendedor) {
    const atual = busca.liberacoes?.[p.uid];
    if (atual) ops.push(...desfazer(ref, busca, p.uid, atual));
    let qtd = 0;
    if (p.modo === "inteira") {
      for (let n = 0; n < qtdLotes; n++) {
        ops.push((b) => b.update(ref.collection("lotes").doc(String(n)), { liberada_para: FieldValue.arrayUnion(p.uid) }));
      }
    } else {
      const minhas = new Set(p.cidades);
      // Dividida: o lead na carteira de alguém vai só para o dono dele (e o livre, pela cidade).
      const meus = leads.filter((l) => {
        const dono = dividida ? donoDe(l) : null;
        return dono ? dono === p.uid && (!recorte || recorte.has(cidadeDoLead(l))) : minhas.has(cidadeDoLead(l));
      });
      qtd = Math.ceil(meus.length / POR_LOTE);
      for (let n = 0; n < qtd; n++) {
        const itens = meus.slice(n * POR_LOTE, (n + 1) * POR_LOTE);
        ops.push((b) => b.set(ref.collection("liberacoes").doc(p.uid).collection("lotes").doc(String(n)),
          { vendedor_uid: p.uid, ...(equipeDoVendedor.get(p.uid) ? { equipe_id: equipeDoVendedor.get(p.uid) } : {}), indice: n, leads: itens }));
      }
    }
    campos.push(new FieldPath("liberacoes", p.uid), {
      modo: p.modo, cidades: p.cidades, qtd_lotes: qtd, qtd_leads: p.leads, dividida,
      rotulo: rotulos.get(p.uid) || "vendedor", equipe_id: equipeDoVendedor.get(p.uid) || null,
      liberada_em: FieldValue.serverTimestamp(), liberada_por: adminUid,
    });
  }
  // Os lotes primeiro; o documento da busca (que faz a lista aparecer para o vendedor) por último.
  await gravar(db, ops);
  await ref.update("liberada_para", FieldValue.arrayUnion(...plano.por_vendedor.map((p) => p.uid)), ...campos);
}

async function revogar(db, usuario, ref, busca, uid) {
  if (!uid || typeof uid !== "string") throw new ErroHttp(400, "Informe o vendedor.");
  const atual = busca.liberacoes?.[uid];
  if (!atual && !(busca.liberada_para || []).includes(uid)) throw new ErroHttp(404, "Esta busca não está liberada para esse vendedor.");
  // Gestor: só tira o que é de um preposto da equipe dele.
  if (!usuario.admin) {
    const equipe = atual?.equipe_id || (await db.doc(`usuarios/${uid}`).get()).data()?.equipe_id || "resolve-farma";
    if (equipe !== usuario.equipe_id) throw new ErroHttp(403, "Você só revoga listas dos prepostos da sua equipe.");
  }
  // O documento da busca primeiro (a lista some da tela na hora), depois os lotes.
  await ref.update("liberada_para", FieldValue.arrayRemove(uid), new FieldPath("liberacoes", uid), FieldValue.delete());
  if (atual) await gravar(db, desfazer(ref, busca, uid, atual));
  logPrivado(`liberar-busca: liberação da busca ${ref.id} revogada (1 vendedor)`);
  return { resultado: "revogada" };
}

/** Master: lista inteira para uma equipe (o gestor lê a busca e os lotes e redistribui). Não conta na cota da equipe. */
async function liberarEquipe(db, usuario, ref, busca, equipeId) {
  if (!equipeId || typeof equipeId !== "string" || equipeId.includes("/") || equipeId === EQUIPE_MASTER) throw new ErroHttp(400, "Informe a equipe.");
  const eq = await db.doc(`equipes/${equipeId}`).get();
  if (!eq.exists || eq.data().ativa === false) throw new ErroHttp(400, "Equipe inválida ou desativada.");
  if (busca.tipo === "parte" || busca.tipo === "rn_filha") throw new ErroHttp(400, "Libere pela busca principal.");
  if (!FINAIS.includes(busca.status)) throw new ErroHttp(409, "Só dá para liberar busca terminada.");
  const qtdLotes = Number(busca.qtd_lotes) || 0;
  if (!qtdLotes) throw new ErroHttp(400, "Esta busca não tem leads para liberar.");
  const ops = Array.from({ length: qtdLotes }, (_, n) => (b) => b.update(ref.collection("lotes").doc(String(n)), { liberada_equipes: FieldValue.arrayUnion(equipeId) }));
  await gravar(db, ops);
  await ref.update("liberada_equipes", FieldValue.arrayUnion(equipeId), new FieldPath("liberacoes_equipes", equipeId), {
    nome: eq.data().nome || equipeId, qtd_leads: Number(busca.resumo?.total || 0), liberada_em: FieldValue.serverTimestamp(), liberada_por: usuario.uid });
  logPrivado(`liberar-busca: busca ${ref.id} liberada para a equipe ${equipeId}`);
  return { resultado: "liberada", equipe_id: equipeId };
}

/** Master: tira a lista da equipe e também o que o gestor dela tinha repassado aos prepostos. */
async function revogarEquipe(db, usuario, ref, busca, equipeId) {
  if (!(busca.liberada_equipes || []).includes(equipeId)) throw new ErroHttp(404, "Esta busca não está liberada para essa equipe.");
  const daEquipe = Object.entries(busca.liberacoes || {}).filter(([, l]) => l?.equipe_id === equipeId);
  await ref.update("liberada_equipes", FieldValue.arrayRemove(equipeId), new FieldPath("liberacoes_equipes", equipeId), FieldValue.delete(),
    ...(daEquipe.length ? ["liberada_para", FieldValue.arrayRemove(...daEquipe.map(([uid]) => uid))] : []),
    ...daEquipe.flatMap(([uid]) => [new FieldPath("liberacoes", uid), FieldValue.delete()]));
  const ops = Array.from({ length: Number(busca.qtd_lotes) || 0 }, (_, n) => (b) => b.update(ref.collection("lotes").doc(String(n)), { liberada_equipes: FieldValue.arrayRemove(equipeId) }));
  for (const [uid, atual] of daEquipe) ops.push(...desfazer(ref, busca, uid, atual));
  await gravar(db, ops);
  logPrivado(`liberar-busca: liberação da busca ${ref.id} para a equipe ${equipeId} revogada (${daEquipe.length} preposto(s))`);
  return { resultado: "revogada" };
}
