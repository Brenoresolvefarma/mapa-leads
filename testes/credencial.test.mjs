// Testes da leitura da chave privada do Firebase vinda do Netlify (chave FALSA gerada no teste).
// Motivo: em produção (24/09) o criar-busca dava 500 "app/invalid-credential" porque a
// FIREBASE_PRIVATE_KEY colada no Netlify não era lida como PEM válido.
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { cert } from "firebase-admin/app";
import { descreverFormatoDaChave, normalizarChavePrivada } from "../netlify/lib/servidor.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }); // com quebras reais e "\n" no fim
const literal = PEM.replace(/\n/g, "\\n"); // como aparece dentro do JSON

const formas = {
  "quebras reais": PEM,
  "\\n literal (valor do JSON sem aspas)": literal,
  "com aspas duplas": `"${literal}"`,
  "com aspas simples": `'${literal}'`,
  "linha inteira do JSON": `"private_key": "${literal}",`,
  "JSON completo da conta": JSON.stringify({ type: "service_account", private_key: PEM, client_email: "x@y.iam.gserviceaccount.com" }),
  "quebras CRLF (Windows)": PEM.replace(/\n/g, "\r\n"),
  "espaços nas pontas": `  ${literal}  `,
};

for (const [nome, valor] of Object.entries(formas)) {
  test(`chave aceita: ${nome}`, () => {
    const chave = normalizarChavePrivada(valor);
    assert.equal(chave.trim(), PEM.trim());
    assert.doesNotThrow(() => createPrivateKey(chave));
    assert.doesNotThrow(() => cert({ projectId: "p", clientEmail: "x@y.iam.gserviceaccount.com", privateKey: chave }));
  });
}

test("formato descrito sem expor a chave", () => {
  const texto = descreverFormatoDaChave("abc-chave-quebrada");
  assert.match(texto, /começa com BEGIN PRIVATE KEY: não/);
  assert.ok(!texto.includes("abc-chave-quebrada"));
  const ok = descreverFormatoDaChave(`"${literal}"`);
  assert.match(ok, /BEGIN PRIVATE KEY: sim.*END PRIVATE KEY: sim/);
  assert.ok(!ok.includes(literal.slice(40, 80)));
});
