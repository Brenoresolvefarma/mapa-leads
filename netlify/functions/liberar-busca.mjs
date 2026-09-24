// POST /api/liberar-busca — SÓ admin (claim conferida no servidor). O admin libera uma busca (lista de leads)
// para um ou mais vendedores.
// Ações:
//  - simular  { id, vendedores?, modo?, cidades?, dividir? } → vendedores disponíveis, leads por cidade e,
//             com vendedores, quantos leads cada um recebe (nada é gravado).
//  - liberar  { id, vendedores, modo: "inteira" | "cidades", cidades?, dividir? }
//  - revogar  { id, uid } → a lista some para aquele vendedor.
//
// Como fica no Firestore (o navegador continua sem gravar nada):
//  - buscas/{id}.liberada_para = [uid, ...] (todos que receberam) e buscas/{id}.liberacoes.{uid} =
//    { modo, cidades, qtd_lotes, qtd_leads, dividida, rotulo, liberada_em, liberada_por };
//  - "inteira": os lotes da busca ganham liberada_para (a regra deixa o vendedor ler esses lotes);
//  - "recorte" (só algumas cidades e/ou dividida entre vendedores): cópia SÓ com os leads das cidades do vendedor
//    em buscas/{id}/liberacoes/{uid}/lotes/{n} — documentos separados por vendedor, para a regra filtrar pelo caminho.
// Não conta na cota diária do vendedor. Log só com ids e números (nada de leads).

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { cidadeDoLead, planoLiberacao } from "../lib/logica.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, logPrivado, usuarioDoToken } from "../lib/servidor.mjs";

const FINAIS = ["concluida", "erro", "cancelada"];
const POR_LOTE = 300;
const MAX_VENDEDORES = 20;

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  if (!usuario.admin) throw new ErroHttp(403, "Só o administrador libera buscas para vendedores.");
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();
  const { id } = corpo;
  if (!id || typeof id !== "string" || id.includes("/")) throw new ErroHttp(400, "Informe a busca.");
  const ref = db.doc(`buscas/${id}`);
  const doc = await ref.get();
  if (!doc.exists) throw new ErroHttp(404, "Busca não encontrada.");
  const busca = doc.data();

  if (corpo.acao === "revogar") return json(200, await revogar(db, ref, busca, corpo.uid));
  if (corpo.acao !== "simular" && corpo.acao !== "liberar") throw new ErroHttp(400, "Ação inválida.");

  if (busca.tipo === "parte" || busca.tipo === "rn_filha") throw new ErroHttp(400, "Libere pela busca principal.");
  if (!FINAIS.includes(busca.status)) throw new ErroHttp(409, "Só dá para liberar busca terminada.");
  const qtdLotes = Number(busca.qtd_lotes) || 0;
  if (!qtdLotes) throw new ErroHttp(400, "Esta busca não tem leads para liberar.");

  const disponiveis = await vendedoresDisponiveis(auth, busca.dono_uid);
  const leads = await lerLeads(db, ref, qtdLotes);
  const vendedores = corpo.vendedores === undefined && corpo.acao === "simular" ? [] : conferirVendedores(corpo.vendedores, disponiveis);
  let plano;
  try {
    plano = planoLiberacao(leads, { vendedores, modo: corpo.modo || "inteira", cidades: Array.isArray(corpo.cidades) ? corpo.cidades.map(String) : [], dividir: !!corpo.dividir });
  } catch (e) { throw new ErroHttp(400, e.message); }

  if (corpo.acao === "simular") {
    return json(200, { vendedores: disponiveis.map(({ uid, rotulo }) => ({ uid, rotulo })), total: leads.length, ...plano });
  }
  const rotulos = new Map(disponiveis.map((v) => [v.uid, v.rotulo]));
  await liberar(db, ref, busca, leads, qtdLotes, plano, !!corpo.dividir && vendedores.length > 1, rotulos, usuario.uid);
  const somaLeads = plano.por_vendedor.reduce((t, p) => t + p.leads, 0);
  logPrivado(`liberar-busca: busca ${id} liberada para ${vendedores.length} vendedor(es) (${corpo.modo || "inteira"}${corpo.dividir ? ", dividida" : ""}), ${somaLeads} leads no total`);
  return json(200, { resultado: "liberada", por_vendedor: plano.por_vendedor });
});

export const config = { path: "/api/liberar-busca" };

/** Vendedores que podem receber: contas ativas sem a claim admin, fora o dono da busca. */
async function vendedoresDisponiveis(auth, donoUid) {
  const contas = await auth.listUsers(1000);
  return contas.users
    .filter((u) => !u.disabled && !u.customClaims?.admin && u.uid !== donoUid)
    .map((u) => ({ uid: u.uid, rotulo: u.displayName || u.email || "vendedor" }))
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

async function liberar(db, ref, busca, leads, qtdLotes, plano, dividida, rotulos, adminUid) {
  const ops = [];
  const campos = [];
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
      const meus = leads.filter((l) => minhas.has(cidadeDoLead(l)));
      qtd = Math.ceil(meus.length / POR_LOTE);
      for (let n = 0; n < qtd; n++) {
        const itens = meus.slice(n * POR_LOTE, (n + 1) * POR_LOTE);
        ops.push((b) => b.set(ref.collection("liberacoes").doc(p.uid).collection("lotes").doc(String(n)),
          { vendedor_uid: p.uid, indice: n, leads: itens }));
      }
    }
    campos.push(new FieldPath("liberacoes", p.uid), {
      modo: p.modo, cidades: p.cidades, qtd_lotes: qtd, qtd_leads: p.leads, dividida,
      rotulo: rotulos.get(p.uid) || "vendedor", liberada_em: FieldValue.serverTimestamp(), liberada_por: adminUid,
    });
  }
  // Os lotes primeiro; o documento da busca (que faz a lista aparecer para o vendedor) por último.
  await gravar(db, ops);
  await ref.update("liberada_para", FieldValue.arrayUnion(...plano.por_vendedor.map((p) => p.uid)), ...campos);
}

async function revogar(db, ref, busca, uid) {
  if (!uid || typeof uid !== "string") throw new ErroHttp(400, "Informe o vendedor.");
  const atual = busca.liberacoes?.[uid];
  if (!atual && !(busca.liberada_para || []).includes(uid)) throw new ErroHttp(404, "Esta busca não está liberada para esse vendedor.");
  // O documento da busca primeiro (a lista some da tela na hora), depois os lotes.
  await ref.update("liberada_para", FieldValue.arrayRemove(uid), new FieldPath("liberacoes", uid), FieldValue.delete());
  if (atual) await gravar(db, desfazer(ref, busca, uid, atual));
  logPrivado(`liberar-busca: liberação da busca ${ref.id} revogada (1 vendedor)`);
  return { resultado: "revogada" };
}
