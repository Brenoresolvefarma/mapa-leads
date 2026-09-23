// POST /api/cancelar-busca  { id }
// Dono da busca ou admin. Na fila: cancela na hora. Rodando: pede o cancelamento
// e o motor para antes da próxima consulta, guardando os leads já coletados.
// Busca-mãe do RN: cancela os lotes que ainda não rodaram e fecha a mãe com o que já foi coletado.

import { FieldValue } from "firebase-admin/firestore";
import { dispararMotor, ErroHttp, firebase, handler, json, lerCorpo, usuarioDoToken } from "../lib/servidor.mjs";

const FINAIS = ["concluida", "erro", "cancelada"];

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const { id } = await lerCorpo(req);
  if (!id || typeof id !== "string") throw new ErroHttp(400, "Informe a busca.");
  const { db } = firebase();
  const ref = db.doc(`buscas/${id}`);
  const doc = await ref.get();
  const dados = doc.data();
  // Mesma resposta para "não existe" e "não é sua": não revela buscas de outros.
  if (!doc.exists || !(usuario.admin || dados.dono_uid === usuario.uid)) {
    throw new ErroHttp(404, "Busca não encontrada.");
  }
  if (dados.tipo === "rn_filha") throw new ErroHttp(400, "Cancele pela busca principal do RN inteiro.");
  if (FINAIS.includes(dados.status)) throw new ErroHttp(409, "Esta busca já terminou.");

  if (dados.tipo === "rn_mae") {
    await ref.update({ cancelar_solicitado: true });
    const filhas = await db.collection("buscas")
      .where("mae_id", "==", id).where("status", "==", "na_fila").get();
    const lote = db.batch();
    filhas.forEach((f) => lote.update(f.ref, { status: "cancelada", finalizada_em: FieldValue.serverTimestamp() }));
    await lote.commit();
    await removerDaFila(db, [id, ...filhas.docs.map((f) => f.id)]);
    // O motor consolida a mãe (com os leads já coletados) na próxima execução.
    await dispararMotor();
    return json(200, { resultado: "cancelamento_solicitado", lotes_cancelados: filhas.size });
  }

  const resultado = await db.runTransaction(async (t) => {
    const atual = (await t.get(ref)).data();
    if (atual.status === "na_fila") {
      t.update(ref, {
        status: "cancelada",
        aviso: "Cancelada antes de começar.",
        finalizada_em: FieldValue.serverTimestamp(),
      });
      return "cancelada";
    }
    if (atual.status === "rodando") {
      t.update(ref, { cancelar_solicitado: true });
      return "cancelamento_solicitado";
    }
    throw new ErroHttp(409, "Esta busca já terminou.");
  });
  if (resultado === "cancelada") await removerDaFila(db, [id]);
  return json(200, { resultado });
});

export const config = { path: "/api/cancelar-busca" };

async function removerDaFila(db, ids) {
  try {
    const refEstado = db.doc("fila/estado");
    await db.runTransaction(async (t) => {
      const atual = (await t.get(refEstado)).data() || {};
      const fora = (i) => !ids.includes(i.id) && !ids.includes(i.mae_id);
      t.set(refEstado, {
        itens: (atual.itens || []).filter(fora),
        rodando: atual.rodando || [],
        aguardando: (atual.aguardando || []).filter(fora),
        atualizado_em: FieldValue.serverTimestamp(),
      });
    });
  } catch {
    // O motor recalcula o estado da fila a cada busca.
  }
}
