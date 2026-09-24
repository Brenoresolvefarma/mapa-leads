// POST /api/criar-busca
// Cria uma busca comum (qualquer usuário logado, respeitando o limite diário)
// ou um RN inteiro (SÓ admin — conferido aqui no servidor pela claim do token).
// Com { simular: true } só devolve a estimativa, sem criar nada.
// Paralelismo (24/09): a busca comum com várias cidades já nasce dividida em até 4 PARTES
// (por cidade), uma por máquina do motor; a estimativa é a da parte mais demorada.
// Equipes (24/09): a busca leva o equipe_id (master → área só dele); gestor e vendedor respeitam também a cota da
// equipe (buscas por dia e consultas por mês), conferida e contada na mesma transação. Equipe desativada → 403.

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
  const vagas = L.vagasEfetivas((await db.doc("config/paralelismo").get()).data() || {});
  const plano = L.planoBuscaComum(parametros, metricas, vagas);
  const { consultas, partes, estimativa } = plano;
  if (plano.maiorParte > L.LIMITE_BUSCA_COMUM_SEG) {
    throw new ErroHttp(400, "Busca grande demais para uma execução (mais de 5 h estimadas). Divida em buscas menores.");
  }
  // Vendedor (não admin): no máximo 40 cidades OU 120 consultas por busca (valores em Admin › Configurações).
  const geral = (await db.doc("config/geral").get()).data() || {};
  if (!usuario.admin) {
    const erro = L.conferirTamanhoVendedor(parametros.cidades.length, consultas.length, L.limitesVendedor(geral));
    if (erro) throw new ErroHttp(400, erro);
  }
  const resumoPlano = {
    consultas: consultas.length,
    estimativa_seg: estimativa,
    maquinas: plano.vagas, // quantas partes/máquinas ao mesmo tempo
    um_motor_seg: plano.umMotor, // quanto levaria numa máquina só (para comparar)
    pequenas: plano.pequenas.length, // cidades do RN com menos de 5 mil hab. (IBGE, Censo 2022)
    ...(plano.semPequenas ? { sem_pequenas: plano.semPequenas, cidades_pequenas: plano.pequenas } : {}),
  };
  if (corpo.simular) return json(200, resumoPlano);

  const ref = db.collection("buscas").doc();
  const refsPartes = partes.map(() => db.collection("buscas").doc());
  const equipeId = L.equipeDaNovaBusca(usuario);
  const refEquipe = usuario.admin ? null : db.doc(`equipes/${usuario.equipe_id}`);
  // Limite diário conferido e contado na MESMA transação que cria a busca:
  // dois cliques ao mesmo tempo não furam o limite.
  const limite = await db.runTransaction(async (t) => {
    const refUsuario = db.doc(`usuarios/${usuario.uid}`);
    const [docUsuario, docGeral, docEquipe] = await t.getAll(refUsuario, db.doc("config/geral"), ...(refEquipe ? [refEquipe] : []));
    // Cota da equipe (o master não tem). Equipe sem documento (antes da migração) = sem limite.
    if (docEquipe?.exists) {
      if (docEquipe.data().ativa === false) throw new ErroHttp(403, "Equipe desativada. Fale com o administrador.");
      const cota = L.conferirCotaEquipe(docEquipe.data(), consultas.length);
      if (!cota.permitido) throw new ErroHttp(429, cota.erro);
      t.update(refEquipe, { uso: cota.uso });
    }
    const situacao = L.conferirLimiteDiario(docUsuario.data() || {}, docGeral.data() || {});
    if (!situacao.permitido) {
      throw new ErroHttp(429, `Limite diário atingido (${situacao.limite} buscas por dia). Tente novamente amanhã.`);
    }
    // Vendedor: também no máximo 300 consultas por dia (por usuário ou o padrão de config/geral). Admin não tem.
    const doDia = L.conferirConsultasDia(docUsuario.data() || {}, docGeral.data() || {}, consultas.length);
    if (!usuario.admin && !doDia.permitido) {
      throw new ErroHttp(429, `Limite diário de consultas atingido: ${doDia.usadas} de ${doDia.limite} usadas hoje e esta busca tem ` +
        `${consultas.length}. Diminua a busca ou tente amanhã.`);
    }
    t.set(refUsuario, { email: usuario.email, dia: situacao.dia, contagem_dia: situacao.contagem + 1,
      consultas_dia: doDia.usadas + consultas.length }, { merge: true });
    t.set(ref, {
      tipo: "comum",
      lista: true, // aparece em "Minhas buscas" (filhas do RN e partes não aparecem)
      dono_uid: usuario.uid,
      dono_email: usuario.email,
      equipe_id: equipeId,
      criada_em: FieldValue.serverTimestamp(),
      status: "na_fila",
      origem: "tela",
      parametros,
      total_consultas: consultas.length,
      estimativa_seg: estimativa,
      ...(partes.length ? { partes_total: partes.length, cidades_total: parametros.cidades.length, cidades_prontas: 0, consultas_feitas: 0 } : {}),
    });
    // Partes: cada uma roda numa máquina do motor (mesma transação: ou tudo, ou nada).
    partes.forEach((parte, ordem) => {
      t.set(refsPartes[ordem], {
        tipo: "parte",
        mae_id: ref.id,
        dono_uid: usuario.uid,
        dono_email: usuario.email,
        equipe_id: equipeId,
        parametros: { termos: parametros.termos, extrair_email: parametros.extrair_email },
        cidades: parte.cidades,
        consultas: parte.consultas,
        ordem,
        status: "na_fila",
        criada_em: FieldValue.serverTimestamp(),
      });
    });
    return situacao;
  });

  await adicionarNaFila(db, partes.length
    ? partes.map((p, i) => ({ id: refsPartes[i].id, tipo: "comum", mae_id: ref.id,
      estimativa_seg: L.estimarConsultasSeg(p.consultas, parametros.extrair_email, metricas) }))
    : [{ id: ref.id, tipo: "comum", estimativa_seg: estimativa }], false);
  const disparado = await dispararMotor(ref.id);
  return json(201, {
    id: ref.id,
    ...resumoPlano,
    restantes_hoje: limite.limite - limite.contagem - 1,
    disparado,
  });
}

async function criarRnInteiro(db, usuario, corpo, metricas) {
  // Bloqueio no SERVIDOR: esconder o botão na tela não basta.
  if (!usuario.admin) throw new ErroHttp(403, "A busca Estado inteiro é exclusiva do administrador.");
  let plano;
  try {
    plano = L.prepararRnInteiro(corpo, metricas);
  } catch (erro) {
    throw new ErroHttp(400, erro.message);
  }
  const resumoPlano = {
    uf: plano.parametros.uf,
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
    equipe_id: L.EQUIPE_MASTER, // Estado inteiro é do master: área só dele até ele liberar
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
      equipe_id: L.EQUIPE_MASTER,
      parametros: { termos: plano.parametros.termos, extrair_email: plano.parametros.extrair_email, uf: plano.parametros.uf },
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
