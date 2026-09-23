// POST /api/criar-busca
// Cria uma busca comum (qualquer usuário logado, respeitando o limite diário)
// ou um RN inteiro (SÓ admin — conferido aqui no servidor pela claim do token).
// Com { simular: true } só devolve a estimativa, sem criar nada.

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as L from "../lib/logica.mjs";
import { dispararMotor, ErroHttp, firebase, handler, json, lerCorpo, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const corpo = await lerCorpo(req);
  const { db } = firebase();
  const metricas = (await db.doc("config/metricas").get()).data() || {};
  if (corpo.modo === "rn_inteiro") return criarRnInteiro(db, usuario, corpo, metricas);
  return criarBuscaComum(db, usuario, corpo, metricas);
});

export const config = { path: "/api/criar-busca" };

async function criarBuscaComum(db, usuario, corpo, metricas) {
  let parametros;
  try {
    parametros = L.validarBuscaComum(corpo);
  } catch (erro) {
    throw new ErroHttp(400, erro.message);
  }
  const consultas = L.consultasBuscaComum(parametros);
  const estimativa = L.estimarConsultasSeg(consultas, parametros.extrair_email, metricas);
  if (estimativa > L.LIMITE_BUSCA_COMUM_SEG) {
    throw new ErroHttp(400, "Busca grande demais para uma execução (mais de 5 h estimadas). Divida em buscas menores.");
  }
  if (corpo.simular) return json(200, { consultas: consultas.length, estimativa_seg: estimativa });

  const ref = db.collection("buscas").doc();
  // Limite diário conferido e contado na MESMA transação que cria a busca:
  // dois cliques ao mesmo tempo não furam o limite.
  const limite = await db.runTransaction(async (t) => {
    const refUsuario = db.doc(`usuarios/${usuario.uid}`);
    const [docUsuario, docGeral] = await t.getAll(refUsuario, db.doc("config/geral"));
    const situacao = L.conferirLimiteDiario(docUsuario.data() || {}, docGeral.data() || {});
    if (!situacao.permitido) {
      throw new ErroHttp(429, `Limite diário atingido (${situacao.limite} buscas por dia). Tente novamente amanhã.`);
    }
    t.set(refUsuario, { email: usuario.email, dia: situacao.dia, contagem_dia: situacao.contagem + 1 }, { merge: true });
    t.set(ref, {
      tipo: "comum",
      lista: true, // aparece em "Minhas buscas" (filhas do RN não aparecem)
      dono_uid: usuario.uid,
      dono_email: usuario.email,
      criada_em: FieldValue.serverTimestamp(),
      status: "na_fila",
      origem: "tela",
      parametros,
      total_consultas: consultas.length,
      estimativa_seg: estimativa,
    });
    return situacao;
  });

  await adicionarNaFila(db, [{ id: ref.id, tipo: "comum", estimativa_seg: estimativa }], false);
  const disparado = await dispararMotor(ref.id);
  return json(201, {
    id: ref.id,
    estimativa_seg: estimativa,
    restantes_hoje: limite.limite - limite.contagem - 1,
    disparado,
  });
}

async function criarRnInteiro(db, usuario, corpo, metricas) {
  // Bloqueio no SERVIDOR: esconder o botão na tela não basta.
  if (!usuario.admin) throw new ErroHttp(403, "A busca RN inteiro é exclusiva do administrador.");
  let plano;
  try {
    plano = L.prepararRnInteiro(corpo, metricas);
  } catch (erro) {
    throw new ErroHttp(400, erro.message);
  }
  const resumoPlano = {
    consultas: plano.consultas.length,
    lotes: plano.lotes.length,
    estimativa_seg: plano.estimativa_seg,
  };
  if (corpo.simular) return json(200, resumoPlano);

  const agendada = plano.parametros.agendar_noite ? Timestamp.fromDate(L.proximaNoite()) : null;
  const refMae = db.collection("buscas").doc();
  const lote = db.batch();
  lote.set(refMae, {
    tipo: "rn_mae",
    lista: true,
    dono_uid: usuario.uid,
    dono_email: usuario.email,
    criada_em: FieldValue.serverTimestamp(),
    status: "na_fila",
    origem: "tela",
    parametros: plano.parametros,
    total_consultas: plano.consultas.length,
    consultas_feitas: 0,
    filhas_total: plano.lotes.length,
    vazias_seguidas: 0,
    estimativa_seg: plano.estimativa_seg,
    ...(agendada ? { agendada_para: agendada } : {}),
  });
  const novosNaFila = [];
  plano.lotes.forEach((consultas, ordem) => {
    const refFilha = db.collection("buscas").doc();
    lote.set(refFilha, {
      tipo: "rn_filha",
      mae_id: refMae.id,
      dono_uid: usuario.uid,
      dono_email: usuario.email,
      parametros: { termos: plano.parametros.termos, extrair_email: plano.parametros.extrair_email },
      consultas,
      ordem,
      status: "na_fila",
      criada_em: FieldValue.serverTimestamp(),
      ...(agendada ? { agendada_para: agendada } : {}),
    });
    novosNaFila.push({
      id: refFilha.id,
      tipo: "rn_filha",
      mae_id: refMae.id,
      estimativa_seg: L.estimarConsultasSeg(consultas, plano.parametros.extrair_email, metricas),
    });
  });
  await lote.commit();

  await adicionarNaFila(db, novosNaFila, Boolean(agendada));
  const disparado = agendada ? false : await dispararMotor(refMae.id);
  return json(201, {
    id: refMae.id,
    ...resumoPlano,
    agendada_para: agendada ? agendada.toDate().toISOString() : null,
    disparado,
  });
}

/** Atualiza o documento público da fila (só IDs, tipo e estimativa). Falha aqui não impede a busca. */
async function adicionarNaFila(db, novos, agendados) {
  try {
    const refEstado = db.doc("fila/estado");
    await db.runTransaction(async (t) => {
      const atual = (await t.get(refEstado)).data() || {};
      let estado;
      if (agendados) {
        estado = {
          itens: atual.itens || [],
          rodando: atual.rodando || [],
          aguardando: [...(atual.aguardando || []), ...novos.map(({ estimativa_seg, ...resto }) => resto)],
        };
      } else {
        estado = L.inserirNaFila(atual, novos);
      }
      t.set(refEstado, { ...estado, atualizado_em: FieldValue.serverTimestamp() });
    });
  } catch {
    // O motor recalcula o estado da fila a cada busca.
  }
}
