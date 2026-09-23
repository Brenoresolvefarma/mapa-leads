// TEMPORÁRIO (removido antes do merge): aplica a relevância nova à busca "HOME CARE" de 30 cidades
// do Breno. A saída vai para um arquivo que o workflow CIFRA antes de publicar (nada legível no log).
import { writeFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { R } from "../testes/relevancia-bloco.mjs";

const db = getFirestore(initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }));
const buscas = (await db.collection("buscas").where("tipo", "==", "comum").get()).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((b) => (b.parametros?.termos || []).some((t) => R.semAcento(t) === "home care") && (b.parametros?.cidades || []).length >= 20);
const linhas = [];
for (const b of buscas) {
  const leads = [];
  for (let n = 0; n < (b.qtd_lotes || 0); n++) leads.push(...((await db.doc(`buscas/${b.id}/lotes/${n}`).get()).data()?.leads || []));
  const sin = R.sugerirSinonimos(b.parametros.termos);
  const auto = R.criterioSegmento({ termos: b.parametros.termos, sinonimos: sin });
  const catsBreno = ["Serviço de assistência médica domiciliar", "Serviços de cuidados para idosos", "Casa de repouso para idosos", "Residência geriátrica", "Consultório de enfermagem"];
  const comLista = R.criterioSegmento({ termos: b.parametros.termos, sinonimos: sin, categorias: catsBreno });
  const naCidade = (l) => l.cidade_confere !== "nao" && l.cidade;
  const cats = new Map();
  for (const l of leads) {
    const c = l.categoria || "(sem categoria)";
    const x = cats.get(c) || { n: 0, auto: 0, lista: 0 };
    x.n++; if (R.noSegmento(l, auto)) x.auto++; if (R.noSegmento(l, comLista)) x.lista++;
    cats.set(c, x);
  }
  const conta = (f) => leads.filter(f).length;
  linhas.push(`BUSCA ${b.id} | termos: ${b.parametros.termos.join(", ")} | ${b.parametros.cidades.length} cidades | criada ${b.criada_em?.toDate?.().toISOString()}`);
  linhas.push(`total de leads: ${leads.length}`);
  linhas.push(`sem cidade no endereço: ${conta((l) => !l.cidade)} | cidade não confere: ${conta((l) => l.cidade_confere === "nao")}`);
  linhas.push(`sinônimos usados: ${sin.join(", ")}`);
  linhas.push(`NO SEGMENTO (automático: termo + sinônimos no nome/categoria): ${conta((l) => R.noSegmento(l, auto))}`);
  linhas.push(`NO SEGMENTO (automático + suas 5 categorias): ${conta((l) => R.noSegmento(l, comLista))}`);
  linhas.push(`... e na cidade pedida (com cidade): ${conta((l) => R.noSegmento(l, comLista) && naCidade(l))}`);
  linhas.push(`CATEGORIAS (${cats.size}): nome | leads | no segmento (auto) | no segmento (auto+lista)`);
  for (const [c, x] of [...cats].sort((a, b) => b[1].n - a[1].n)) linhas.push(`  ${c} | ${x.n} | ${x.auto} | ${x.lista}`);
  linhas.push(`LEADS NO SEGMENTO (auto+lista): nome | categoria | cidade`);
  for (const l of leads.filter((l) => R.noSegmento(l, comLista))) linhas.push(`  ${l.nome} | ${l.categoria} | ${l.cidade || "(sem cidade)"}`);
  linhas.push("");
}
writeFileSync(process.env.SAIDA, linhas.join("\n") || "nenhuma busca encontrada");
console.log(`buscas analisadas: ${buscas.length}`);
