// Lógica pura do MapaLeads usada pelas Netlify Functions (sem Firebase, testável).
// Os números de tempo espelham motor/tratamento.py — se mudar lá, mude aqui.

import municipiosRN from "../../dados/municipios_rn.json" with { type: "json" };
import bairrosRN from "../../dados/bairros_rn.json" with { type: "json" };

export const PROFUNDIDADES = ["rapida", "normal", "completa"];
export const FUSO = "America/Fortaleza";

// Tempo médio inicial por consulta (s), medido na execução real de 23/09/2026.
export const MEDIA_INICIAL_CONSULTA_SEG = { rapida: 40, normal: 110, completa: 180 };
export const FATOR_EMAIL = 1.6;
export const PAUSA_MEDIA_SEG = 30; // pausa aleatória de 20–40 s entre consultas
export const PARTIDA_EXECUCAO_SEG = 60; // máquina do GitHub ligar + preparar

// Uma busca comum precisa caber numa execução do motor (5h20, com folga).
export const LIMITE_BUSCA_COMUM_SEG = 5 * 60 * 60;
// Cada lote (busca-filha) do RN inteiro mira ~40 min.
export const ALVO_LOTE_RN_SEG = 40 * 60;
// Limite diário padrão de buscas comuns por usuário (aprovado: 20).
export const LIMITE_DIARIO_PADRAO = 20;

// Faixas de população (Censo 2022) do RN inteiro (aprovadas).
export const ATE_RAPIDA = 20000;
export const ATE_NORMAL = 100000;

// Proteção técnica contra texto gigante (não é regra de negócio).
const MAX_TAMANHO_TEXTO = 80;

/** "a, b , ,A" -> ["a", "b"] (sem vazios nem repetidos, mantendo a ordem). */
export function dividirLista(texto) {
  const vistos = new Set();
  const itens = [];
  for (const parte of String(texto ?? "").split(",")) {
    const item = parte.split(/\s+/).filter(Boolean).join(" ");
    const chave = item.toLowerCase();
    if (item && !vistos.has(chave)) {
      vistos.add(chave);
      itens.push(item);
    }
  }
  return itens;
}

/** Data (AAAA-MM-DD) no fuso de Fortaleza: define o "dia" do limite diário. */
export function diaFortaleza(data = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(data);
}

/** Próximas 22h no horário de Fortaleza (UTC-3, sem horário de verão). */
export function proximaNoite(agora = new Date()) {
  const [a, m, d] = diaFortaleza(agora).split("-").map(Number);
  let alvo = new Date(Date.UTC(a, m - 1, d, 22 + 3, 0, 0)); // 22h em Fortaleza = 01h UTC do dia seguinte
  if (alvo <= agora) alvo = new Date(alvo.getTime() + 24 * 3600 * 1000);
  return alvo;
}

export function chaveMetrica(profundidade, extrairEmail) {
  return `${profundidade}_${extrairEmail ? "email" : "sem_email"}`;
}

export function estimarConsultaSeg(profundidade, extrairEmail, metricas = {}) {
  const media = metricas?.[chaveMetrica(profundidade, extrairEmail)]?.media_seg;
  if (media) return Number(media);
  return MEDIA_INICIAL_CONSULTA_SEG[profundidade] * (extrairEmail ? FATOR_EMAIL : 1);
}

/** Estimativa de uma lista de consultas, com as pausas entre elas. */
export function estimarConsultasSeg(consultas, extrairEmail, metricas = {}) {
  const soma = consultas.reduce((t, c) => t + estimarConsultaSeg(c.profundidade, extrairEmail, metricas), 0);
  return Math.trunc(soma + PAUSA_MEDIA_SEG * Math.max(consultas.length - 1, 0));
}

/** Valida e normaliza o pedido de busca comum. Lança Error com mensagem clara. */
export function validarBuscaComum(corpo) {
  const termos = dividirLista(corpo?.termos);
  const cidades = dividirLista(corpo?.cidades);
  const profundidade = corpo?.profundidade || "normal";
  if (!termos.length) throw new Error("Informe pelo menos um termo de busca.");
  if ([...termos, ...cidades].some((t) => t.length > MAX_TAMANHO_TEXTO)) {
    throw new Error(`Cada termo ou cidade pode ter no máximo ${MAX_TAMANHO_TEXTO} caracteres.`);
  }
  if (!PROFUNDIDADES.includes(profundidade)) throw new Error("Profundidade inválida.");
  return {
    termos,
    cidades: cidades.length ? cidades : ["Natal RN"],
    extrair_email: corpo?.extrair_email === true,
    profundidade,
  };
}

/** Consultas termo × cidade de uma busca comum (mesma regra do motor). */
export function consultasBuscaComum(parametros) {
  const consultas = [];
  for (const termo of parametros.termos) {
    for (const cidade of parametros.cidades) {
      consultas.push({ profundidade: parametros.profundidade, termo, cidade });
    }
  }
  return consultas;
}

/** Profundidade automática do RN inteiro pela população (Censo 2022). */
export function profundidadePorPopulacao(populacao) {
  if (populacao <= ATE_RAPIDA) return "rapida";
  if (populacao <= ATE_NORMAL) return "normal";
  return "completa";
}

/**
 * Plano do RN inteiro: lista de consultas para os 167 municípios.
 * - até 20 mil hab.: rápida; 20–100 mil: normal;
 * - Natal, Mossoró e Parnamirim: uma consulta por bairro (normal);
 * - demais acima de 100 mil (São Gonçalo do Amarante): cidade inteira, completa.
 */
export function planoRnInteiro(termos, municipios = municipiosRN.municipios, bairros = bairrosRN.cidades) {
  const bairrosPorCidade = new Map(bairros.map((c) => [c.nome, c.bairros]));
  const consultas = [];
  for (const termo of termos) {
    for (const m of municipios) {
      const listaBairros = bairrosPorCidade.get(m.nome);
      if (listaBairros) {
        for (const bairro of listaBairros) {
          consultas.push({
            id: `c${consultas.length}`,
            termo,
            cidade: m.nome,
            bairro,
            texto: `${termo} ${bairro} ${m.nome} RN`,
            profundidade: "normal",
            criterio: "uf",
          });
        }
      } else {
        consultas.push({
          id: `c${consultas.length}`,
          termo,
          cidade: m.nome,
          texto: `${termo} ${m.nome} RN`,
          profundidade: profundidadePorPopulacao(m.populacao_2022),
          criterio: "uf",
        });
      }
    }
  }
  return consultas;
}

/** Divide as consultas em lotes de ~40 min estimados (cada lote vira uma busca-filha). */
export function dividirEmLotes(consultas, extrairEmail, metricas = {}, alvoSeg = ALVO_LOTE_RN_SEG) {
  const lotes = [];
  let atual = [];
  for (const c of consultas) {
    const comEsta = estimarConsultasSeg([...atual, c], extrairEmail, metricas);
    if (atual.length && comEsta > alvoSeg) {
      lotes.push(atual);
      atual = [];
    }
    atual.push(c);
  }
  if (atual.length) lotes.push(atual);
  return lotes;
}

/** Valida o pedido do RN inteiro e monta plano + lotes + estimativa. */
export function prepararRnInteiro(corpo, metricas = {}) {
  const termos = dividirLista(corpo?.termos);
  if (!termos.length) throw new Error("Informe pelo menos um termo (segmento).");
  if (termos.some((t) => t.length > MAX_TAMANHO_TEXTO)) {
    throw new Error(`Cada termo pode ter no máximo ${MAX_TAMANHO_TEXTO} caracteres.`);
  }
  const extrairEmail = corpo?.extrair_email === true;
  const consultas = planoRnInteiro(termos);
  const lotes = dividirEmLotes(consultas, extrairEmail, metricas);
  const soConsultas = estimarConsultasSeg(consultas, extrairEmail, metricas);
  // Cada execução do motor dura até ~5h20; cada uma tem ~1 min de partida.
  const execucoes = Math.max(1, Math.ceil(soConsultas / LIMITE_BUSCA_COMUM_SEG));
  const estimativa = soConsultas + PARTIDA_EXECUCAO_SEG * execucoes;
  return {
    parametros: { termos, extrair_email: extrairEmail, agendar_noite: corpo?.agendar_noite === true },
    consultas,
    lotes,
    estimativa_seg: estimativa,
  };
}

/**
 * Limite diário: retorna { permitido, contagem, limite, dia }.
 * usuario: documento /usuarios/{uid} (ou {}); geral: /config/geral (ou {}).
 */
export function conferirLimiteDiario(usuario = {}, geral = {}, agora = new Date()) {
  const dia = diaFortaleza(agora);
  const contagem = usuario.dia === dia ? Number(usuario.contagem_dia || 0) : 0;
  const limiteUsuario = usuario.limite_diario;
  const limite = Number.isInteger(limiteUsuario)
    ? limiteUsuario
    : Number.isInteger(geral.limite_padrao) ? geral.limite_padrao : LIMITE_DIARIO_PADRAO;
  return { permitido: contagem < limite, contagem, limite, dia };
}

/** Coloca itens novos no estado público da fila: comuns antes dos lotes do RN. */
export function inserirNaFila(estado, novos) {
  const itens = [...(estado?.itens || [])];
  for (const novo of novos) {
    if (novo.tipo === "comum") {
      const pos = itens.findIndex((i) => i.tipo !== "comum");
      itens.splice(pos === -1 ? itens.length : pos, 0, novo);
    } else {
      itens.push(novo);
    }
  }
  return { itens, rodando: estado?.rodando || [], aguardando: estado?.aguardando || [] };
}
