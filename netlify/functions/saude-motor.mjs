// POST /api/saude-motor  — SÓ admin. Painel "Saúde do motor" (Fase 3a).
// Junta: últimas execuções do workflow do motor no GitHub (status, duração, gatilho),
// último "acordar" do despertador, métricas de tempo, situação da fila (na fila, rodando,
// pausadas pelo disjuntor, agendadas, órfãs) e números do dia.
// Não devolve termos, cidades nem dados de leads.

import { decidirDespertar, diaFortaleza, MOTOR_VIVO_SEG } from "../lib/logica.mjs";
import { ErroHttp, firebase, handler, json, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  if (!usuario.admin) throw new ErroHttp(403, "Acesso exclusivo do administrador.");
  const { db } = firebase();
  const agora = new Date();
  const col = db.collection("buscas");
  const campos = ["status", "tipo", "agendada_para", "pausada_ate", "batimento_em", "iniciada_em", "mae_id"];

  const [naFila, rodando, despertador, metricas, hoje, execucoes] = await Promise.all([
    col.where("status", "==", "na_fila").select(...campos).limit(300).get(),
    col.where("status", "==", "rodando").select(...campos).limit(100).get(),
    db.doc("config/despertador").get(),
    db.doc("config/metricas").get(),
    db.doc(`estatisticas/${diaFortaleza(agora)}__geral`).get(),
    execucoesDoGitHub(),
  ]);

  const ts = agora.getTime() / 1000;
  const seg = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() / 1000 : 0);
  const fila = naFila.docs.map((d) => d.data());
  const ativos = rodando.docs.map((d) => d.data()).filter((b) => b.tipo !== "rn_mae");
  const situacao = {
    na_fila: fila.filter((b) => b.tipo !== "rn_mae").length,
    rodando: ativos.length,
    pausadas: fila.filter((b) => seg(b.pausada_ate) > ts).length,
    pausada_ate: maior(fila.map((b) => seg(b.pausada_ate)).filter((s) => s > ts)),
    agendadas: fila.filter((b) => seg(b.agendada_para) > ts).length,
    orfas: ativos.filter((b) => ts - seg(b.batimento_em || b.iniciada_em) >= MOTOR_VIVO_SEG).length,
    ultimo_batimento: maior(ativos.map((b) => seg(b.batimento_em))),
    rn_em_andamento: new Set([...fila, ...ativos].filter((b) => b.mae_id).map((b) => b.mae_id)).size,
  };
  const desp = despertador.data() || null;
  return json(200, {
    agora: agora.toISOString(),
    fila: situacao,
    decisao_agora: decidirDespertar([...fila, ...ativos], agora),
    despertador: desp && {
      ultima_execucao: desp.ultima_execucao?.toDate?.().toISOString() ?? null,
      motivo: desp.motivo ?? null,
      disparou: desp.disparou === true,
    },
    metricas: metricas.data() || {},
    hoje: hoje.data() || {},
    execucoes,
  });
});

export const config = { path: "/api/saude-motor" };

const maior = (lista) => (lista.length ? new Date(Math.max(...lista) * 1000).toISOString() : null);

/** Últimas 15 execuções do motor.yml (usa o mesmo token fine-grained, só Actions). */
async function execucoesDoGitHub() {
  const token = process.env.MAPALEADS_GITHUB_TOKEN;
  const repo = process.env.MAPALEADS_GITHUB_REPO;
  if (!token || !repo) return { erro: "Token do GitHub não configurado no Netlify." };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/motor.yml/runs?per_page=15`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!r.ok) return { erro: `GitHub respondeu HTTP ${r.status}.` };
    const dados = await r.json();
    return {
      lista: (dados.workflow_runs || []).map((e) => ({
        numero: e.run_number,
        gatilho: e.event, // schedule | workflow_dispatch
        status: e.status,
        conclusao: e.conclusion,
        inicio: e.run_started_at || e.created_at,
        fim: e.status === "completed" ? e.updated_at : null,
        link: e.html_url,
      })),
    };
  } catch {
    return { erro: "Não foi possível consultar o GitHub agora." };
  }
}
