// O bloco <crm> da tela e netlify/lib/logica.mjs precisam dar a MESMA chave/fatia/carteira
// (a tela lê crm/{uid}__{fatia} e carteira/{fatia} com a chave que o servidor gravou).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as L from "../netlify/lib/logica.mjs";

const html = readFileSync(new URL("../publico/index.html", import.meta.url), "utf8");
const bloco = html.match(/\/\/ <crm>[\s\S]*?\/\/ <\/crm>/)[0];
const T = await import(`data:text/javascript;base64,${Buffer.from(`${bloco}\nexport { chaveCrm, fatiaDe, carteiraAtiva, STATUS_CRM, MOTIVOS_DESCARTE, STATUS_DA_CARTEIRA };`).toString("base64")}`);

test("chave do lead e fatia: tela e servidor iguais (place_id; senão telefone + nome; senão nome + cidade)", () => {
  const leads = [
    { id_lugar: "ChIJN1t_tDeuEmsRUsoyG83frY4" }, { id_lugar: "0x7b3:0x1a2 b" }, { id_lugar: " x " },
    { telefone: "(84) 99999-0001", nome: "Clínica Ágil & Cia" }, { telefone: "+55 84 3333-2222", nome: "Loja" },
    { telefone: "", nome: "São João Pet", cidade: "Mossoró" }, {},
  ];
  for (const l of leads) {
    assert.equal(T.chaveCrm(l), L.chaveLead(l));
    assert.equal(T.fatiaDe(T.chaveCrm(l)), L.fatiaDe(L.chaveLead(l)));
  }
  assert.equal(T.chaveCrm({ telefone: "+55 84 3333-2222", nome: "Loja" }), "t_8433332222_loja");
  assert.match(T.fatiaDe("p_x"), /^(0\d|1[0-5])$/);
});

test("carteira ativa: status da carteira e prazo; descartado nunca", () => {
  const agora = Date.UTC(2026, 8, 24);
  for (const [e, dias, esperado] of [
    [{ uid: "a", s: "contatado", ultimo: agora - 59 * 86400000 }, 60, true],
    [{ uid: "a", s: "cliente", ultimo: agora - 61 * 86400000 }, 60, false],
    [{ uid: "a", s: "cliente", ultimo: agora - 61 * 86400000 }, 90, true],
    [{ uid: "a", s: "descartado", ultimo: agora }, 60, false],
    [null, 60, false],
  ]) {
    assert.equal(T.carteiraAtiva(e, agora, dias), esperado);
    assert.equal(L.carteiraAtiva(e, agora, dias), esperado);
  }
  assert.deepEqual(T.STATUS_CRM.map(([k]) => k), L.STATUS_CRM);
  assert.deepEqual(T.MOTIVOS_DESCARTE.map(([k]) => k), L.MOTIVOS_DESCARTE);
  assert.deepEqual(T.STATUS_DA_CARTEIRA, L.STATUS_DA_CARTEIRA);
});
