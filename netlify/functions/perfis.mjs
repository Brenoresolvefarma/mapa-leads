// POST /api/perfis  — perfis de busca salvos, por usuário (Fase 3a).
// Ações: listar | salvar (cria ou atualiza pelo id) | apagar
// Cada usuário só enxerga e altera os PRÓPRIOS perfis (usuarios/{uid}/perfis).
// O navegador nunca grava no Firestore: tudo passa por aqui.

import { FieldValue } from "firebase-admin/firestore";
import { MAX_PERFIS_POR_USUARIO, validarPerfil } from "../lib/logica.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const corpo = await lerCorpo(req);
  const { db } = firebase();
  const colecao = db.collection(`usuarios/${usuario.uid}/perfis`);

  switch (corpo.acao) {
    case "listar": {
      const docs = await colecao.orderBy("nome").limit(MAX_PERFIS_POR_USUARIO).get();
      return json(200, { perfis: docs.docs.map((d) => ({ id: d.id, ...semDatas(d.data()) })) });
    }
    case "salvar": {
      let perfil;
      try {
        perfil = validarPerfil(corpo.perfil);
      } catch (erro) {
        throw new ErroHttp(400, erro.message);
      }
      const id = idValido(corpo.perfil?.id);
      if (id) {
        const ref = colecao.doc(id);
        if (!(await ref.get()).exists) throw new ErroHttp(404, "Perfil não encontrado.");
        await ref.set({ ...perfil, atualizado_em: FieldValue.serverTimestamp() });
        return json(200, { id });
      }
      // Proteção técnica: no máximo N perfis por usuário (1 consulta de contagem barata).
      const total = (await colecao.count().get()).data().count;
      if (total >= MAX_PERFIS_POR_USUARIO) {
        throw new ErroHttp(400, `Você já tem ${MAX_PERFIS_POR_USUARIO} perfis salvos. Apague algum para salvar outro.`);
      }
      const ref = await colecao.add({ ...perfil, criado_em: FieldValue.serverTimestamp() });
      return json(201, { id: ref.id });
    }
    case "apagar": {
      const id = idValido(corpo.id);
      if (!id) throw new ErroHttp(400, "Informe o perfil.");
      await colecao.doc(id).delete();
      return json(200, { apagado: true });
    }
    default:
      throw new ErroHttp(400, "Ação inválida.");
  }
});

export const config = { path: "/api/perfis" };

function idValido(id) {
  return typeof id === "string" && /^[A-Za-z0-9]{1,40}$/.test(id) ? id : null;
}

function semDatas({ criado_em, atualizado_em, ...resto }) {
  return resto;
}
