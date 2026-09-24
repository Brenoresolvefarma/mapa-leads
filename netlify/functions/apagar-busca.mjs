// POST /api/apagar-busca  { id }
// Apaga uma busca e os leads dela (documento + subcoleção "lotes").
// - Vendedor: só as próprias (dono_uid = o uid do token); de outro → 403.
// - Admin: qualquer busca, de qualquer vendedor.
// - Em andamento (na fila / rodando): recusa com 409 — cancelar primeiro, apagar depois.
// - Busca-mãe do Estado inteiro: apaga também os lotes (filhas) e os leads de cada uma.
// - Liberada para vendedores: apaga também as cópias por vendedor (a lista some para eles).
// - NÃO devolve a cota do dia (o contador em usuarios/{uid} não é mexido).
// - Log: só o id da busca e o uid de quem apagou (nada de leads), e só no log privado do Netlify.
// As regras do Firestore continuam com write false para o navegador: só o servidor apaga.

import { FieldValue } from "firebase-admin/firestore";
import { ErroHttp, firebase, handler, json, lerCorpo, logPrivado, usuarioDoToken } from "../lib/servidor.mjs";

const FINAIS = ["concluida", "erro", "cancelada"];

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const { id } = await lerCorpo(req);
  if (!id || typeof id !== "string" || id.includes("/")) throw new ErroHttp(400, "Informe a busca.");
  const { db } = firebase();
  const ref = db.doc(`buscas/${id}`);
  const doc = await ref.get();
  if (!doc.exists) throw new ErroHttp(404, "Busca não encontrada.");
  const dados = doc.data();
  if (!usuario.admin && dados.dono_uid !== usuario.uid) throw new ErroHttp(403, "Você só pode apagar as suas buscas.");
  if (dados.tipo === "rn_filha") throw new ErroHttp(400, "Apague pela busca principal do Estado inteiro.");
  if (dados.tipo === "parte") throw new ErroHttp(400, "Apague pela busca principal.");
  if (!FINAIS.includes(dados.status)) throw new ErroHttp(409, "Busca em andamento: cancele primeiro e depois apague.");

  // Mãe do Estado inteiro: as filhas (lotes de consultas) vão junto. A mãe só fica final
  // depois que todas as filhas terminaram, mas conferimos de novo por segurança.
  // Busca comum dividida em partes (paralelismo): as partes e os leads parciais delas vão junto.
  const temFilhas = dados.tipo === "rn_mae" || Number(dados.partes_total) > 0;
  const filhas = temFilhas ? (await db.collection("buscas").where("mae_id", "==", id).get()).docs : [];
  if (filhas.some((f) => !FINAIS.includes(f.data().status))) throw new ErroHttp(409, "Busca em andamento: cancele primeiro e depois apague.");

  let lotes = 0;
  // Cópias liberadas para vendedores (recorte por cidades): buscas/{id}/liberacoes/{uid}/lotes/{n}.
  for (const [uid, lib] of Object.entries(dados.liberacoes || {})) {
    for (let n = 0; n < (Number(lib?.qtd_lotes) || 0); n++) await ref.collection("liberacoes").doc(uid).collection("lotes").doc(String(n)).delete();
  }
  for (const alvo of [...filhas.map((f) => f.ref), ref]) lotes += await apagarComLotes(db, alvo);
  await removerDaFila(db, [id, ...filhas.map((f) => f.id)]);
  logPrivado(`apagar-busca: busca ${id} apagada por ${usuario.uid}`);
  return json(200, { resultado: "apagada", lotes, buscas: filhas.length + 1 });
});

export const config = { path: "/api/apagar-busca" };

/** Apaga os lotes (leads) e depois o documento da busca. Devolve quantos lotes apagou. */
async function apagarComLotes(db, ref) {
  const lotes = (await ref.collection("lotes").select().get()).docs;
  for (let i = 0; i < lotes.length; i += 400) {
    const lote = db.batch();
    lotes.slice(i, i + 400).forEach((l) => lote.delete(l.ref));
    await lote.commit();
  }
  await ref.delete();
  return lotes.length;
}

async function removerDaFila(db, ids) {
  try {
    const refEstado = db.doc("fila/estado");
    await db.runTransaction(async (t) => {
      const atual = (await t.get(refEstado)).data();
      if (!atual) return;
      const fora = (i) => !ids.includes(i.id) && !ids.includes(i.mae_id);
      t.set(refEstado, {
        itens: (atual.itens || []).filter(fora),
        rodando: (atual.rodando || []).filter(fora),
        aguardando: (atual.aguardando || []).filter(fora),
        atualizado_em: FieldValue.serverTimestamp(),
      });
    });
  } catch {
    // O motor recalcula o estado da fila a cada busca.
  }
}
