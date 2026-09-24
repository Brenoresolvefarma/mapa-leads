// Testes da relevância do segmento (bloco puro da tela). Dados fictícios.
import assert from "node:assert/strict";
import { test } from "node:test";
import { R } from "./relevancia-bloco.mjs";

const crit = R.criterioSegmento({ termos: ["HOME CARE"], sinonimos: R.sugerirSinonimos(["HOME CARE"]) });
const lead = (nome, categoria) => ({ nome, categoria });

test("sinônimos sugeridos: por termo, sem acento/maiúsculas, sem repetir o próprio termo", () => {
  const s = R.sugerirSinonimos(["Home Care"]);
  assert.ok(s.includes("atendimento domiciliar") && s.includes("casa de repouso"));
  assert.deepEqual(R.sugerirSinonimos(["dentista", "odontologia"]).includes("odontologia"), false);
  assert.deepEqual(R.sugerirSinonimos(["termo sem dicionario"]), []);
});

test("home care: casa lojas e prefeituras como FORA; cuidados de idosos como DENTRO", () => {
  assert.equal(R.noSegmento(lead("Vida Home Care", "Serviço de saúde"), crit), true);
  assert.equal(R.noSegmento(lead("Recanto", "Serviço de assistência médica domiciliar"), crit), true);
  assert.equal(R.noSegmento(lead("Lar Feliz", "Serviços de cuidados para idosos"), crit), true);
  assert.equal(R.noSegmento(lead("Vovó Maria", "Casa de repouso para idosos"), crit), true);
  assert.equal(R.noSegmento(lead("Espaço Sênior", "Residência geriátrica"), crit), true);
  // Google devolve "parecidos" em cidade pequena:
  assert.equal(R.noSegmento(lead("C J Home Center | Materiais para Construção", "Loja de materiais de construção"), crit), false);
  assert.equal(R.noSegmento(lead("Casa França | Móveis", "Loja de móveis"), crit), false);
  assert.equal(R.noSegmento(lead("Magazine Luiza", "Loja de departamentos"), crit), false);
  assert.equal(R.noSegmento(lead("Prefeitura Municipal", "Prefeitura"), crit), false);
  assert.equal(R.noSegmento(lead("Funerária Paz", "Funerária"), crit), false);
  assert.equal(R.noSegmento(lead("Net House Provedor", "Provedor de serviços de Internet"), crit), false);
  assert.equal(R.noSegmento(lead("CARETAS HOME", "Complexo habitacional"), crit), false); // "care" não casa "caretas"
});

test("categorias aceitas marcam como DENTRO mesmo sem o termo no nome", () => {
  const c = R.criterioSegmento({ termos: ["home care"], categorias: ["Consultório de enfermagem"] });
  assert.equal(R.noSegmento(lead("Dra. Ana", "Consultório de Enfermagem"), c), true);
  assert.equal(R.noSegmento(lead("Dra. Ana", "Consultório médico"), c), false);
  // categorias extras (lista completa do Google), quando existirem
  assert.equal(R.noSegmento({ nome: "X", categoria: "Clínica", categorias: ["Clínica", "Consultório de enfermagem"] }, c), true);
});

test("frase exige todas as palavras; plural aceito", () => {
  const p = R.palavras("Serviços de cuidados para idosos");
  assert.equal(R.casaFrase("cuidado de idosos", p), true);
  assert.equal(R.casaFrase("casa de repouso", R.palavras("Casa de Material de Construção")), false);
  assert.equal(R.casaFrase("", p), false);
});

test("termo com ponto ou ponto e vírgula vira frases separadas (\"HOME CARE. CUIDADO DE IDOSOS\")", () => {
  const c = R.criterioSegmento({ termos: ["HOME CARE. CUIDADO DE IDOSOS"] });
  assert.deepEqual(c.frases, ["HOME CARE", "CUIDADO DE IDOSOS"]);
  assert.equal(R.noSegmento({ nome: "Vida Home Care", categoria: "Serviço de saúde" }, c), true);
  assert.equal(R.noSegmento({ nome: "Lar Feliz", categoria: "Cuidado de idosos" }, c), true);
  assert.equal(R.noSegmento({ nome: "Loja Construção", categoria: "Loja de materiais de construção" }, c), false);
  assert.deepEqual(R.criterioSegmento({ termos: ["dentista; odontologia"] }).frases, ["dentista", "odontologia"]);
});
