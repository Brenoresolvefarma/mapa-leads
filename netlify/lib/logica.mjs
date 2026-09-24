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

// Uma busca comum (ou cada parte dela) precisa caber numa execução do motor (5h20, com folga).
export const LIMITE_BUSCA_COMUM_SEG = 5 * 60 * 60;

// Paralelismo (aprovado pelo Breno em 24/09): até 4 vagas (máquinas) ao mesmo tempo, no total.
// Espelha motor/paralelismo.py — se mudar lá, mude aqui.
export const VAGAS_MAX = 4;
export const SOBE_UMA_VAGA_A_CADA_SEG = 2 * 60 * 60;
// Aviso de cidades pequenas na Nova busca (valor do Breno: menos de 5 mil hab., Censo 2022).
export const CIDADE_PEQUENA_ABAIXO_DE = 5000;
// Cada lote (busca-filha) do RN inteiro mira ~40 min.
export const ALVO_LOTE_RN_SEG = 40 * 60;
// Limite diário padrão de buscas comuns por usuário (aprovado: 20).
export const LIMITE_DIARIO_PADRAO = 20;

// Limites do VENDEDOR (não admin), valores do Breno (24/09), ajustáveis em Admin › Configurações (config/geral):
// por busca, no máximo 40 cidades OU 120 consultas; por dia, no máximo 300 consultas (também por usuário).
export const LIMITES_VENDEDOR_PADRAO = { max_cidades_busca: 40, max_consultas_busca: 120, max_consultas_dia: 300 };
// Máquinas do motor por vendedor quando outro vendedor está esperando (valor do Breno; espelha motor/fila.py).
export const MAQUINAS_POR_VENDEDOR = 2;

/** Limites do vendedor valendo agora: os de config/geral (inteiros ≥ 1) ou os padrões. */
export function limitesVendedor(geral = {}) {
  const valor = (k) => (Number.isInteger(geral?.[k]) && geral[k] >= 1 ? geral[k] : LIMITES_VENDEDOR_PADRAO[k]);
  return { max_cidades_busca: valor("max_cidades_busca"), max_consultas_busca: valor("max_consultas_busca"),
    max_consultas_dia: valor("max_consultas_dia") };
}

/** Busca grande demais para vendedor? Devolve a mensagem de erro (ou null). */
export function conferirTamanhoVendedor(cidades, consultas, limites) {
  if (cidades <= limites.max_cidades_busca && consultas <= limites.max_consultas_busca) return null;
  return `Busca grande demais para vendedor (${cidades} cidades / ${consultas} consultas). ` +
    `Máximo: ${limites.max_cidades_busca} cidades ou ${limites.max_consultas_busca} consultas. Divida por região ou peça ao admin.`;
}

/** Consultas do dia do vendedor (mesmo "dia" do limite de buscas): { permitido, usadas, limite, dia }. */
export function conferirConsultasDia(usuario = {}, geral = {}, novas = 0, agora = new Date()) {
  const dia = diaFortaleza(agora);
  const usadas = usuario.dia === dia ? Number(usuario.consultas_dia || 0) : 0;
  const limite = Number.isInteger(usuario.limite_consultas_dia) ? usuario.limite_consultas_dia : limitesVendedor(geral).max_consultas_dia;
  return { permitido: usadas + novas <= limite, usadas, limite, dia };
}

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

/** Vagas que podem trabalhar agora (config/paralelismo): base + 1 a cada 2 h sem novo sinal de bloqueio. */
export function vagasEfetivas(doc = {}, agora = new Date()) {
  const base = Math.max(1, Math.min(VAGAS_MAX, Number(doc?.vagas_base) || VAGAS_MAX));
  const sinal = doc?.ultimo_sinal_em;
  if (!sinal || base >= VAGAS_MAX) return base;
  const ts = typeof sinal.toMillis === "function" ? sinal.toMillis() : new Date(sinal).getTime();
  const subiu = Math.floor(Math.max(0, agora.getTime() - ts) / 1000 / SOBE_UMA_VAGA_A_CADA_SEG);
  return Math.min(VAGAS_MAX, base + subiu);
}

/**
 * Divide as cidades de uma busca comum em até `vagas` partes (uma por máquina).
 * Cidades distribuídas em rodízio (partes do mesmo tamanho); dentro de cada parte, cidade por cidade
 * (todos os termos de uma cidade seguidos: a cidade fica pronta de uma vez e já aparece na tela).
 * Com 1 cidade (ou 1 vaga) não divide: devolve [].
 */
export function dividirEmPartes(parametros, vagas) {
  const k = Math.min(VAGAS_MAX, Math.max(1, vagas), parametros.cidades.length);
  if (k <= 1) return [];
  const grupos = Array.from({ length: k }, () => []);
  parametros.cidades.forEach((cidade, i) => grupos[i % k].push(cidade));
  return grupos.map((cidades, parte) => {
    const consultas = [];
    for (const cidade of cidades) {
      for (const termo of parametros.termos) {
        consultas.push({ id: `p${parte}q${consultas.length}`, termo, cidade, texto: `${termo} ${cidade}`,
          profundidade: parametros.profundidade, criterio: "cidade" });
      }
    }
    return { cidades, consultas };
  });
}

/** Tempo real da busca com as partes rodando ao mesmo tempo: partida + a parte mais demorada. */
export function estimarComPartes(consultas, partes, extrairEmail, metricas = {}) {
  const umMotor = estimarConsultasSeg(consultas, extrairEmail, metricas);
  const maiorParte = partes.length
    ? Math.max(...partes.map((p) => estimarConsultasSeg(p.consultas, extrairEmail, metricas)))
    : umMotor;
  return { estimativa: maiorParte + PARTIDA_EXECUCAO_SEG, maiorParte, umMotor: umMotor + PARTIDA_EXECUCAO_SEG };
}

const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const POPULACAO_RN = new Map(municipiosRN.municipios.map((m) => [semAcento(m.nome), m.populacao_2022]));

/** Cidades do RN com menos de 5 mil hab. (Censo 2022) entre as pedidas ("Nome RN"); cidades de fora ficam de fora. */
export function cidadesPequenas(cidades, abaixoDe = CIDADE_PEQUENA_ABAIXO_DE) {
  return cidades.filter((c) => {
    const nome = semAcento(c).replace(/\s+rn$/, "");
    const pop = POPULACAO_RN.get(nome);
    return pop !== undefined && pop < abaixoDe;
  });
}

/**
 * Plano completo da busca comum: consultas, partes (paralelismo) e estimativa honesta.
 * Também diz quanto tempo tirar as cidades pequenas economizaria (para o aviso da Nova busca).
 */
export function planoBuscaComum(parametros, metricas = {}, vagas = VAGAS_MAX) {
  const consultas = consultasBuscaComum(parametros);
  const partes = dividirEmPartes(parametros, vagas);
  const tempo = estimarComPartes(consultas, partes, parametros.extrair_email, metricas);
  const pequenas = cidadesPequenas(parametros.cidades);
  let semPequenas = null;
  if (pequenas.length && pequenas.length < parametros.cidades.length) {
    const outras = { ...parametros, cidades: parametros.cidades.filter((c) => !pequenas.includes(c)) };
    const t2 = estimarComPartes(consultasBuscaComum(outras), dividirEmPartes(outras, vagas), parametros.extrair_email, metricas);
    semPequenas = { consultas: consultasBuscaComum(outras).length, estimativa_seg: t2.estimativa };
  }
  return { consultas, partes, vagas: Math.max(1, partes.length), ...tempo, pequenas, semPequenas };
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
    // Relevância (só marcam os leads; não mudam as consultas): sinônimos confirmados e categorias aceitas.
    sinonimos: listaCurta(corpo?.sinonimos, MAX_SINONIMOS),
    categorias_aceitas: listaCurta(corpo?.categorias_aceitas, MAX_CATEGORIAS_ACEITAS),
  };
}

// Limites técnicos (proteção contra abuso, não são regra de negócio).
const MAX_SINONIMOS = 20;
const MAX_CATEGORIAS_ACEITAS = 80;
/** Lista (array ou texto separado por vírgula) → itens limpos, sem repetidos, até N itens de até 80 caracteres. */
export function listaCurta(valor, max) {
  const itens = Array.isArray(valor) ? valor.map(String) : String(valor ?? "").split(",");
  const vistos = new Set(), saida = [];
  for (const bruto of itens) {
    const item = bruto.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_TAMANHO_TEXTO);
    const chave = item.toLowerCase();
    if (item && !vistos.has(chave)) { vistos.add(chave); saida.push(item); }
    if (saida.length >= max) break;
  }
  return saida;
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
  return { itens, rodando: estado?.rodando || [], aguardando: estado?.aguardando || [],
    ...(estado?.vagas ? { vagas: estado.vagas } : {}) };
}

// ---------------------------------------------------------------------------
// Perfis de busca salvos (Fase 3a). Guardados no servidor, por usuário.
// Limites técnicos (proteção contra abuso, não são regra de negócio).
export const MAX_PERFIS_POR_USUARIO = 50;
const MAX_NOME_PERFIL = 60;
const MAX_CIDADES_PERFIL = 167; // todos os municípios do RN

/** Valida um perfil salvo: nome + os mesmos campos de uma busca comum. */
export function validarPerfil(corpo) {
  const nome = String(corpo?.nome ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!nome) throw new Error("Dê um nome ao perfil.");
  if (nome.length > MAX_NOME_PERFIL) throw new Error(`O nome do perfil pode ter no máximo ${MAX_NOME_PERFIL} caracteres.`);
  const cidadesTexto = Array.isArray(corpo?.cidades) ? corpo.cidades.join(",") : corpo?.cidades;
  const busca = validarBuscaComum({ ...corpo, cidades: cidadesTexto });
  if (busca.cidades.length > MAX_CIDADES_PERFIL) throw new Error("Cidades demais no perfil.");
  const tipoRegiao = corpo?.tipo_regiao === "imediata" ? "imediata" : "micro";
  const regioes = (Array.isArray(corpo?.regioes) ? corpo.regioes : [])
    .map((r) => String(r).slice(0, 10)).filter((r) => /^\d+$/.test(r)).slice(0, 30);
  return { nome, ...busca, tipo_regiao: tipoRegiao, regioes };
}

// ---------------------------------------------------------------------------
// Despertador (Netlify Scheduled Function a cada 15 min): rede de segurança caso o
// agendamento do GitHub atrase ou não dispare. Espelha motor/fila.py (elegivel / órfãs).
export const MOTOR_VIVO_SEG = 45 * 60; // mesmo prazo de órfã do motor (ORFA_APOS_SEG)
// Busca que nunca roda direto: mãe do RN ou busca comum dividida em partes (espelha fila.eh_mae).
export const ehMae = (b) => b?.tipo === "rn_mae" || ((b?.tipo || "comum") === "comum" && Number(b?.partes_total) > 0);

const segundos = (valor) => {
  if (!valor) return 0;
  if (typeof valor.toMillis === "function") return valor.toMillis() / 1000;
  if (valor instanceof Date) return valor.getTime() / 1000;
  return Number(valor) || 0;
};

/** A busca pode rodar agora? (na fila, não é mãe, não agendada para depois, não pausada) */
export function elegivel(dados, agora = new Date()) {
  if (dados?.status !== "na_fila" || ehMae(dados)) return false;
  const ts = agora.getTime() / 1000;
  return segundos(dados.agendada_para) <= ts && segundos(dados.pausada_ate) <= ts;
}

/**
 * Decide se o despertador deve disparar o motor.
 * buscas: documentos com status na_fila ou rodando (sem precisar de termos/cidades).
 */
export function decidirDespertar(buscas, agora = new Date(), vagas = VAGAS_MAX) {
  const ts = agora.getTime() / 1000;
  const rodando = buscas.filter((b) => b.status === "rodando" && !ehMae(b));
  const vivas = rodando.filter((b) => ts - segundos(b.batimento_em || b.iniciada_em) < MOTOR_VIVO_SEG);
  const orfas = rodando.length - vivas.length;
  const elegiveis = buscas.filter((b) => elegivel(b, agora)).length;
  // Com vagas livres e trabalho esperando, dispara mesmo com outra máquina rodando (as vagas ocupadas
  // não são afetadas: cada vaga tem o seu grupo de concurrency no workflow).
  if (vivas.length >= vagas || (vivas.length && !elegiveis)) return { disparar: false, motivo: "motor_rodando", elegiveis, orfas };
  if (elegiveis) return { disparar: true, motivo: "fila_com_trabalho", elegiveis, orfas };
  if (orfas) return { disparar: true, motivo: "busca_orfa", elegiveis, orfas };
  return { disparar: false, motivo: "fila_vazia", elegiveis, orfas };
}
