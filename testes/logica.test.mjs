// Testes da lógica pura das Netlify Functions (node --test). Dados fictícios.
import assert from "node:assert/strict";
import { test } from "node:test";
import municipios from "../dados/municipios_rn.json" with { type: "json" };
import bairros from "../dados/bairros_rn.json" with { type: "json" };
import regioes from "../dados/microrregioes_rn.json" with { type: "json" };
import * as L from "../netlify/lib/logica.mjs";

test("dados do IBGE: 167 municípios, população do Censo 2022 e bairros das 3 maiores", () => {
  assert.equal(municipios.municipios.length, 167);
  const total = municipios.municipios.reduce((t, m) => t + m.populacao_2022, 0);
  assert.equal(total, 3302729); // população oficial do RN no Censo 2022
  const natal = municipios.municipios.find((m) => m.nome === "Natal");
  assert.equal(natal.populacao_2022, 751300);
  assert.deepEqual(bairros.cidades.map((c) => [c.nome, c.bairros.length]), [
    ["Natal", 36], ["Mossoró", 27], ["Parnamirim", 22],
  ]);
});

test("dividirLista remove vazios e repetidos", () => {
  assert.deepEqual(L.dividirLista(" dentista, odontologia , ,Dentista"), ["dentista", "odontologia"]);
  assert.deepEqual(L.dividirLista(undefined), []);
});

test("dia do limite diário vira à meia-noite de Fortaleza (UTC-3)", () => {
  assert.equal(L.diaFortaleza(new Date("2026-09-24T02:59:00Z")), "2026-09-23"); // 23h59 em Fortaleza
  assert.equal(L.diaFortaleza(new Date("2026-09-24T03:00:00Z")), "2026-09-24"); // 00h00 em Fortaleza
});

test("agendar para a noite: próximas 22h de Fortaleza", () => {
  assert.equal(L.proximaNoite(new Date("2026-09-23T15:00:00Z")).toISOString(), "2026-09-24T01:00:00.000Z");
  // Depois das 22h (23h em Fortaleza = 02h UTC): vai para a noite seguinte.
  assert.equal(L.proximaNoite(new Date("2026-09-24T02:00:00Z")).toISOString(), "2026-09-25T01:00:00.000Z");
});

test("limite diário: padrão 20, por usuário, e zera no dia seguinte", () => {
  const agora = new Date("2026-09-23T15:00:00Z");
  assert.deepEqual(L.conferirLimiteDiario({}, {}, agora), { permitido: true, contagem: 0, limite: 20, dia: "2026-09-23" });
  assert.equal(L.conferirLimiteDiario({ dia: "2026-09-23", contagem_dia: 20 }, {}, agora).permitido, false);
  assert.equal(L.conferirLimiteDiario({ dia: "2026-09-22", contagem_dia: 20 }, {}, agora).permitido, true);
  assert.equal(L.conferirLimiteDiario({ dia: "2026-09-23", contagem_dia: 5, limite_diario: 5 }, {}, agora).permitido, false);
  assert.equal(L.conferirLimiteDiario({ dia: "2026-09-23", contagem_dia: 0, limite_diario: 0 }, {}, agora).permitido, false);
  assert.equal(L.conferirLimiteDiario({ dia: "2026-09-23", contagem_dia: 25 }, { limite_padrao: 30 }, agora).permitido, true);
});

test("validação da busca comum", () => {
  assert.deepEqual(L.validarBuscaComum({ termos: "home care" }), {
    termos: ["home care"], cidades: ["Natal RN"], extrair_email: false, profundidade: "normal",
  });
  assert.throws(() => L.validarBuscaComum({ termos: " , " }), /pelo menos um termo/);
  assert.throws(() => L.validarBuscaComum({ termos: "x", profundidade: "turbo" }), /Profundidade/);
  assert.throws(() => L.validarBuscaComum({ termos: "x".repeat(81) }), /80 caracteres/);
  assert.equal(L.validarBuscaComum({ termos: "x", extrair_email: "true" }).extrair_email, false); // só booleano true
});

test("estimativas espelham o motor (motor/tratamento.py)", () => {
  const consultas = L.consultasBuscaComum({ termos: ["a", "b"], cidades: ["Natal RN"], profundidade: "rapida" });
  assert.equal(L.estimarConsultasSeg(consultas, false), 110); // 2 × 40 + 1 pausa de 30
  assert.equal(L.estimarConsultasSeg(consultas, true), Math.trunc(2 * 40 * 1.6 + 30));
  assert.equal(L.estimarConsultasSeg(consultas, false, { rapida_sem_email: { media_seg: 50 } }), 130);
});

test("profundidade por população: faixas aprovadas", () => {
  assert.equal(L.profundidadePorPopulacao(20000), "rapida");
  assert.equal(L.profundidadePorPopulacao(20001), "normal");
  assert.equal(L.profundidadePorPopulacao(100000), "normal");
  assert.equal(L.profundidadePorPopulacao(100001), "completa");
});

test("plano do RN inteiro: bairros nas 3 maiores, SGA completa, resto por população", () => {
  const plano = L.planoRnInteiro(["dentista"]);
  const porCidade = (nome) => plano.filter((c) => c.cidade === nome);
  assert.equal(porCidade("Natal").length, 36);
  assert.equal(porCidade("Mossoró").length, 27);
  assert.equal(porCidade("Parnamirim").length, 22);
  assert.ok(porCidade("Natal").every((c) => c.profundidade === "normal" && c.bairro && c.texto.endsWith("Natal RN")));
  assert.deepEqual(porCidade("São Gonçalo do Amarante").map((c) => c.profundidade), ["completa"]);
  assert.deepEqual(porCidade("Caicó").map((c) => [c.profundidade, c.texto]), [["normal", "dentista Caicó RN"]]);
  assert.deepEqual(porCidade("Viçosa").map((c) => c.profundidade), ["rapida"]);
  // 164 municípios sem bairros + 85 bairros = 249 consultas por termo
  assert.equal(plano.length, 249);
  assert.ok(plano.every((c) => c.criterio === "uf"));
  assert.equal(new Set(plano.map((c) => c.id)).size, plano.length);
  assert.equal(L.planoRnInteiro(["a", "b"]).length, 498);
});

test("lotes do RN de ~40 min, sem perder nem repetir consultas", () => {
  const plano = L.planoRnInteiro(["dentista"]);
  const lotes = L.dividirEmLotes(plano, false);
  assert.deepEqual(lotes.flat().map((c) => c.id), plano.map((c) => c.id));
  for (const lote of lotes) assert.ok(L.estimarConsultasSeg(lote, false) <= L.ALVO_LOTE_RN_SEG);
  assert.ok(lotes.length >= 6 && lotes.length <= 12, `lotes: ${lotes.length}`);
});

test("prepararRnInteiro: estimativa total e parâmetros", () => {
  const p = L.prepararRnInteiro({ termos: "dentista", agendar_noite: true });
  assert.equal(p.consultas.length, 249);
  assert.equal(p.parametros.agendar_noite, true);
  const horas = p.estimativa_seg / 3600;
  assert.ok(horas > 5 && horas < 8, `estimativa ${horas.toFixed(1)} h`);
  assert.throws(() => L.prepararRnInteiro({ termos: "" }), /pelo menos um termo/);
});

test("estado da fila: busca comum entra antes dos lotes do RN", () => {
  const estado = { itens: [{ id: "c1", tipo: "comum" }, { id: "f1", tipo: "rn_filha" }] };
  const novo = L.inserirNaFila(estado, [{ id: "c2", tipo: "comum" }, { id: "f2", tipo: "rn_filha" }]);
  assert.deepEqual(novo.itens.map((i) => i.id), ["c1", "c2", "f1", "f2"]);
});

test("regiões do IBGE: 19 microrregiões e 11 regiões imediatas cobrindo os 167 municípios", () => {
  const codigos = new Set(municipios.municipios.map((m) => m.codigo_ibge));
  for (const [chave, qtd] of [["microrregioes", 19], ["regioes_imediatas", 11]]) {
    const lista = regioes[chave];
    assert.equal(lista.length, qtd);
    const todos = lista.flatMap((r) => r.municipios);
    assert.equal(todos.length, 167); // cada município em exatamente uma região
    assert.deepEqual(new Set(todos), codigos);
  }
  const natal = regioes.microrregioes.find((r) => r.nome === "Natal");
  assert.deepEqual(natal.municipios, ["2403251", "2403608", "2408102"]); // Parnamirim, Extremoz, Natal
});

test("perfil salvo: nome obrigatório, mesmos campos validados da busca comum", () => {
  const p = L.validarPerfil({ nome: "  Clínicas  Natal ", termos: "clínica, dentista", cidades: ["Natal RN", "Parnamirim RN"],
    profundidade: "rapida", tipo_regiao: "imediata", regioes: ["240001", "x"] });
  assert.deepEqual(p, {
    nome: "Clínicas Natal", termos: ["clínica", "dentista"], cidades: ["Natal RN", "Parnamirim RN"],
    extrair_email: false, profundidade: "rapida", tipo_regiao: "imediata", regioes: ["240001"],
  });
  assert.throws(() => L.validarPerfil({ termos: "x" }), /nome/);
  assert.throws(() => L.validarPerfil({ nome: "a", termos: "" }), /pelo menos um termo/);
  assert.throws(() => L.validarPerfil({ nome: "a".repeat(61), termos: "x" }), /60/);
  assert.equal(L.validarPerfil({ nome: "a", termos: "x", tipo_regiao: "outra" }).tipo_regiao, "micro");
});

test("despertador: dispara só com trabalho elegível ou órfã, e nunca com o motor vivo", () => {
  const agora = new Date("2026-09-23T15:00:00Z");
  const min = (m) => new Date(agora.getTime() + m * 60000);
  const d = (buscas) => L.decidirDespertar(buscas, agora);
  assert.deepEqual(d([]), { disparar: false, motivo: "fila_vazia", elegiveis: 0, orfas: 0 });
  assert.equal(d([{ status: "na_fila", tipo: "comum" }]).motivo, "fila_com_trabalho");
  // Agendada para a noite, pausada pelo disjuntor ou mãe do RN: não conta.
  assert.equal(d([{ status: "na_fila", tipo: "rn_filha", agendada_para: min(60) }]).disparar, false);
  assert.equal(d([{ status: "na_fila", tipo: "rn_filha", pausada_ate: min(10) }]).disparar, false);
  assert.equal(d([{ status: "na_fila", tipo: "rn_filha", pausada_ate: min(-1) }]).disparar, true);
  assert.equal(d([{ status: "na_fila", tipo: "rn_mae" }]).disparar, false);
  // Motor rodando (batimento recente): não dispara mesmo com fila.
  assert.equal(d([{ status: "rodando", tipo: "comum", batimento_em: min(-10) }, { status: "na_fila", tipo: "comum" }]).motivo, "motor_rodando");
  // Sem batimento há 45 min: órfã -> dispara para o motor recuperar.
  assert.deepEqual(d([{ status: "rodando", tipo: "comum", batimento_em: min(-46) }]), { disparar: true, motivo: "busca_orfa", elegiveis: 0, orfas: 1 });
  // Timestamp do Firestore (toMillis) também é aceito.
  assert.equal(d([{ status: "rodando", tipo: "comum", batimento_em: { toMillis: () => min(-5).getTime() } }]).motivo, "motor_rodando");
});
