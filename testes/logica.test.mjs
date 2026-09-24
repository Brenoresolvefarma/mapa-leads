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
    termos: ["home care"], cidades: ["Natal RN"], extrair_email: false, profundidade: "normal", sinonimos: [], categorias_aceitas: [],
  });
  const comSin = L.validarBuscaComum({ termos: "home care", sinonimos: ["casa de repouso", "Casa de Repouso", " ", "x".repeat(200)],
    categorias_aceitas: Array.from({ length: 100 }, (_, i) => `Categoria ${i}`) });
  assert.deepEqual(comSin.sinonimos, ["casa de repouso", "x".repeat(80)]);
  assert.equal(comSin.categorias_aceitas.length, 80);
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
    extrair_email: false, profundidade: "rapida", sinonimos: [], categorias_aceitas: [], tipo_regiao: "imediata", regioes: ["240001"],
  });
  assert.throws(() => L.validarPerfil({ termos: "x" }), /nome/);
  assert.throws(() => L.validarPerfil({ nome: "a", termos: "" }), /pelo menos um termo/);
  assert.throws(() => L.validarPerfil({ nome: "a".repeat(61), termos: "x" }), /60/);
  assert.equal(L.validarPerfil({ nome: "a", termos: "x", tipo_regiao: "outra" }).tipo_regiao, "micro");
});

test("despertador: dispara só com trabalho elegível ou órfã, e só se houver vaga livre", () => {
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
  // Uma máquina rodando e trabalho esperando: com 4 vagas dispara (as outras vagas pegam a fila);
  // com 1 vaga só (paralelismo reduzido) ou as 4 ocupadas, não dispara.
  const viva = { status: "rodando", tipo: "parte", batimento_em: min(-10) };
  assert.equal(d([viva, { status: "na_fila", tipo: "parte" }]).motivo, "fila_com_trabalho");
  assert.equal(L.decidirDespertar([viva, { status: "na_fila", tipo: "parte" }], agora, 1).motivo, "motor_rodando");
  assert.equal(d([viva, viva, viva, viva, { status: "na_fila", tipo: "parte" }]).motivo, "motor_rodando");
  assert.equal(d([viva]).motivo, "motor_rodando");
  // Busca comum dividida em partes (a "mãe") não roda direto: não conta como trabalho nem como máquina.
  assert.equal(d([{ status: "na_fila", tipo: "comum", partes_total: 3 }]).disparar, false);
  // Sem batimento há 45 min: órfã -> dispara para o motor recuperar.
  assert.deepEqual(d([{ status: "rodando", tipo: "comum", batimento_em: min(-46) }]), { disparar: true, motivo: "busca_orfa", elegiveis: 0, orfas: 1 });
  // Timestamp do Firestore (toMillis) também é aceito.
  assert.equal(d([{ status: "rodando", tipo: "comum", batimento_em: { toMillis: () => min(-5).getTime() } }]).motivo, "motor_rodando");
});

test("paralelismo: vagas efetivas espelham o motor (metade no sinal, +1 a cada 2 h, máx. 4)", () => {
  const agora = new Date("2026-09-24T12:00:00Z");
  const h = (x) => new Date(agora.getTime() + x * 3600000);
  assert.equal(L.vagasEfetivas({}, agora), 4);
  const doc = { vagas_base: 1, ultimo_sinal_em: agora };
  assert.equal(L.vagasEfetivas(doc, h(1.99)), 1);
  assert.equal(L.vagasEfetivas(doc, h(2)), 2);
  assert.equal(L.vagasEfetivas(doc, h(5)), 3);
  assert.equal(L.vagasEfetivas(doc, h(30)), 4);
  assert.equal(L.vagasEfetivas({ vagas_base: 2, ultimo_sinal_em: { toMillis: () => agora.getTime() } }, h(2)), 3);
});

test("paralelismo: partes por cidade, do mesmo tamanho, sem repetir nem perder consulta", () => {
  const p = { termos: ["a", "b", "c"], cidades: Array.from({ length: 30 }, (_, i) => `C${i} RN`), profundidade: "rapida", extrair_email: false };
  const partes = L.dividirEmPartes(p, 4);
  assert.equal(partes.length, 4);
  assert.deepEqual(partes.map((x) => x.cidades.length), [8, 8, 7, 7]);
  const textos = partes.flatMap((x) => x.consultas.map((c) => c.texto)).sort();
  assert.deepEqual(textos, L.consultasBuscaComum(p).map((c) => `${c.termo} ${c.cidade}`).sort());
  assert.equal(new Set(partes.flatMap((x) => x.consultas.map((c) => c.id))).size, 90);
  assert.deepEqual(L.dividirEmPartes({ ...p, cidades: ["Natal RN"] }, 4), []); // 1 cidade: não divide
  assert.equal(L.dividirEmPartes(p, 1).length, 0); // 1 vaga: não divide
  // 90 consultas (30 cidades × 3 termos, rápida): 4 máquinas levam ~1/4 do tempo de uma
  const plano = L.planoBuscaComum(p, {}, 4);
  assert.ok(plano.estimativa < plano.umMotor / 3.5, `${plano.estimativa} x ${plano.umMotor}`);
});

test("liberar busca: divisão entre vendedores sem repetir cidade (nem lead) e equilibrada", async () => {
  const { planoLiberacao, dividirCidades, contarPorCidade } = await import("../netlify/lib/logica.mjs");
  const leads = [...Array(6).fill("Natal"), ...Array(4).fill("Mossoró"), ...Array(3).fill("Caicó"), "Macau", "Macau", ""].map((cidade) => ({ cidade }));
  assert.deepEqual(contarPorCidade(leads).map((c) => c.cidade), ["Natal", "Mossoró", "Caicó", "Macau", "(sem cidade)"]);
  const partes = dividirCidades(contarPorCidade(leads), ["a", "b"]);
  const todas = partes.flatMap((p) => p.cidades);
  assert.equal(new Set(todas).size, todas.length); // nenhuma cidade em dois vendedores
  assert.equal(todas.length, 5);
  assert.deepEqual(partes.map((p) => p.leads), [8, 8]); // Natal+Macau(=8) x Mossoró+Caicó+sem cidade(=8)
  // Lista inteira sem dividir: cada um recebe tudo; só cidades escolhidas: recorte igual para todos.
  assert.deepEqual(planoLiberacao(leads, { vendedores: ["a", "b"] }).por_vendedor.map((p) => [p.modo, p.leads]), [["inteira", 16], ["inteira", 16]]);
  const so = planoLiberacao(leads, { vendedores: ["a"], modo: "cidades", cidades: ["Natal", "Macau"] }).por_vendedor[0];
  assert.deepEqual([so.modo, so.leads, so.cidades], ["recorte", 8, ["Macau", "Natal"]]);
  assert.throws(() => planoLiberacao(leads, { vendedores: ["a", "b", "c"], modo: "cidades", cidades: ["Natal", "Macau"], dividir: true }), /Só há 2 cidade/);
});

test("liberar dividindo respeita a carteira: lead de um vendedor vai só para ele; de quem não foi escolhido, para ninguém", async () => {
  const { planoLiberacao } = await import("../netlify/lib/logica.mjs");
  const leads = [
    { cidade: "Natal", id_lugar: "a" }, { cidade: "Natal", id_lugar: "b" }, { cidade: "Natal", id_lugar: "c" },
    { cidade: "Mossoró", id_lugar: "d" }, { cidade: "Mossoró", id_lugar: "e" }, { cidade: "Caicó", id_lugar: "f" },
  ];
  const donos = { a: "v2", f: "v9" }; // "a" é do v2 (escolhido); "f" é do v9 (não escolhido)
  const p = planoLiberacao(leads, { vendedores: ["v1", "v2"], dividir: true, donoDe: (l) => donos[l.id_lugar] || null });
  assert.equal(p.na_carteira_de_outros, 1);
  const [v1, v2] = p.por_vendedor;
  assert.equal(v1.leads + v2.leads, 5); // 6 menos o do v9
  assert.equal(v2.carteira, 1);
  assert.ok(!v1.cidades.some((c) => v2.cidades.includes(c)));
});
