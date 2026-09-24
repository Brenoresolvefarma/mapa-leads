// Testes das regras do Firestore no emulador (sem custo, sem dados reais).
// Rodar: npm run test:regras   (precisa de Java; o CI já tem)
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails, assertSucceeds, initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";

let amb;

before(async () => {
  amb = await initializeTestEnvironment({
    projectId: "demo-mapaleads",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

after(async () => {
  await amb?.cleanup();
});

beforeEach(async () => {
  await amb.clearFirestore();
  // Dados fictícios gravados "pelo servidor" (sem regras).
  await amb.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "buscas/ana1"), { dono_uid: "ana", lista: true, status: "concluida", criada_em: new Date() });
    await setDoc(doc(db, "buscas/ana1/lotes/0"), { dono_uid: "ana", leads: [{ nome: "Fictício" }] });
    await setDoc(doc(db, "buscas/bia1"), { dono_uid: "bia", lista: true, status: "concluida", criada_em: new Date() });
    await setDoc(doc(db, "buscas/bia1/lotes/0"), { dono_uid: "bia", leads: [{ nome: "Outro" }] });
    await setDoc(doc(db, "usuarios/ana"), { email: "ana@x.example", contagem_dia: 1 });
    await setDoc(doc(db, "usuarios/bia"), { email: "bia@x.example" });
    await setDoc(doc(db, "fila/estado"), { itens: [{ id: "ana1", tipo: "comum", estimativa_seg: 40 }] });
    await setDoc(doc(db, "config/geral"), { limite_padrao: 20 });
    await setDoc(doc(db, "config/metricas"), { rapida_sem_email: { media_seg: 40 } });
    await setDoc(doc(db, "estatisticas/2026-09-23__ana"), { dono_uid: "ana", leads: 10 });
    await setDoc(doc(db, "estatisticas/2026-09-23__bia"), { dono_uid: "bia", leads: 5 });
    await setDoc(doc(db, "estatisticas/2026-09-23__geral"), { leads: 15 });
    await setDoc(doc(db, "usuarios/ana/perfis/p1"), { nome: "Perfil", termos: ["x"] });
  });
});

const ana = () => amb.authenticatedContext("ana", { email: "ana@x.example" }).firestore();
const admin = () => amb.authenticatedContext("breno", { admin: true }).firestore();
const anonimo = () => amb.unauthenticatedContext().firestore();

test("usuário comum lê só as próprias buscas e leads", async () => {
  await assertSucceeds(getDoc(doc(ana(), "buscas/ana1")));
  await assertSucceeds(getDoc(doc(ana(), "buscas/ana1/lotes/0")));
  await assertFails(getDoc(doc(ana(), "buscas/bia1")));
  await assertFails(getDoc(doc(ana(), "buscas/bia1/lotes/0")));
});

test("lista 'Minhas buscas' só funciona filtrando pelo próprio dono", async () => {
  const col = collection(ana(), "buscas");
  await assertSucceeds(getDocs(query(col, where("lista", "==", true), where("dono_uid", "==", "ana"), orderBy("criada_em", "desc"), limit(20))));
  await assertFails(getDocs(query(col, where("lista", "==", true), orderBy("criada_em", "desc"), limit(20))));
  await assertFails(getDocs(query(col, where("dono_uid", "==", "bia"))));
});

test("admin (claim) lê buscas e leads de todos e filtra por usuário", async () => {
  await assertSucceeds(getDoc(doc(admin(), "buscas/bia1")));
  await assertSucceeds(getDoc(doc(admin(), "buscas/bia1/lotes/0")));
  await assertSucceeds(getDocs(query(collection(admin(), "buscas"), where("lista", "==", true), orderBy("criada_em", "desc"))));
  await assertSucceeds(getDocs(query(collection(admin(), "buscas"), where("dono_uid", "==", "bia"))));
});

test("claim admin=false ou ausente não dá acesso de admin", async () => {
  const falso = amb.authenticatedContext("mal", { admin: false }).firestore();
  await assertFails(getDoc(doc(falso, "buscas/ana1")));
  const texto = amb.authenticatedContext("mal2", { admin: "true" }).firestore();
  await assertFails(getDoc(doc(texto, "buscas/ana1")));
});

test("ninguém grava pelo navegador: nem leads, nem buscas, nem usuários (nem o admin)", async () => {
  for (const db of [ana(), admin()]) {
    await assertFails(setDoc(doc(db, "buscas/ana1/lotes/9"), { dono_uid: "ana", leads: [] }));
    await assertFails(setDoc(doc(db, "buscas/nova"), { dono_uid: "ana", status: "na_fila" }));
    await assertFails(updateDoc(doc(db, "buscas/ana1"), { status: "na_fila" }));
    await assertFails(updateDoc(doc(db, "usuarios/ana"), { contagem_dia: 0 }));
    await assertFails(setDoc(doc(db, "usuarios/ana"), { limite_diario: 999 }));
    await assertFails(setDoc(doc(db, "fila/estado"), { itens: [] }));
    await assertFails(setDoc(doc(db, "config/geral"), { limite_padrao: 999 }));
  }
});

test("perfil: próprio usuário ou admin", async () => {
  await assertSucceeds(getDoc(doc(ana(), "usuarios/ana")));
  await assertFails(getDoc(doc(ana(), "usuarios/bia")));
  await assertSucceeds(getDoc(doc(admin(), "usuarios/bia")));
});

test("fila e config geral: só logado; métricas e resto: bloqueado", async () => {
  await assertSucceeds(getDoc(doc(ana(), "fila/estado")));
  await assertSucceeds(getDoc(doc(ana(), "config/geral")));
  await assertFails(getDoc(doc(anonimo(), "fila/estado")));
  await assertFails(getDoc(doc(anonimo(), "buscas/ana1")));
  await assertFails(getDoc(doc(ana(), "config/metricas")));
  await assertFails(getDoc(doc(ana(), "qualquer/coisa")));
});

test("estatísticas do dia: usuário lê só as próprias (mesmo sem documento); admin lê todas", async () => {
  await assertSucceeds(getDoc(doc(ana(), "estatisticas/2026-09-23__ana")));
  await assertSucceeds(getDoc(doc(ana(), "estatisticas/2026-09-20__ana"))); // dia sem busca
  await assertFails(getDoc(doc(ana(), "estatisticas/2026-09-23__bia")));
  await assertFails(getDoc(doc(ana(), "estatisticas/2026-09-23__geral")));
  await assertFails(getDoc(doc(ana(), "estatisticas/x__ana__bia")));
  await assertFails(getDocs(collection(ana(), "estatisticas")));
  await assertSucceeds(getDoc(doc(admin(), "estatisticas/2026-09-23__geral")));
  await assertSucceeds(getDoc(doc(admin(), "estatisticas/2026-09-23__bia")));
  await assertFails(getDoc(doc(anonimo(), "estatisticas/2026-09-23__ana")));
  for (const db of [ana(), admin()]) {
    await assertFails(setDoc(doc(db, "estatisticas/2026-09-23__ana"), { leads: 999 }));
  }
});

test("perfis salvos e despertador: só pelo servidor (nem o dono lê direto)", async () => {
  await assertFails(getDoc(doc(ana(), "usuarios/ana/perfis/p1")));
  await assertFails(setDoc(doc(ana(), "usuarios/ana/perfis/p2"), { nome: "x" }));
  await assertFails(getDoc(doc(ana(), "config/despertador")));
});

test("busca liberada pelo admin: vendedor liberado lê; não liberado recebe negado; recorte só o dele; revogar tira", async () => {
  await amb.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // bia1 liberada inteira para a Ana e em recorte (dividida) para Caio e Duda.
    await setDoc(doc(db, "buscas/bia1"), { dono_uid: "bia", lista: true, status: "concluida", criada_em: new Date(),
      liberada_para: ["ana", "caio", "duda"], liberacoes: { ana: { modo: "inteira" }, caio: { modo: "recorte", qtd_lotes: 1 }, duda: { modo: "recorte", qtd_lotes: 1 } } });
    await setDoc(doc(db, "buscas/bia1/lotes/0"), { dono_uid: "bia", liberada_para: ["ana"], leads: [{ nome: "Outro" }] });
    await setDoc(doc(db, "buscas/bia1/liberacoes/caio/lotes/0"), { vendedor_uid: "caio", leads: [{ nome: "Do Caio" }] });
    await setDoc(doc(db, "buscas/bia1/liberacoes/duda/lotes/0"), { vendedor_uid: "duda", leads: [{ nome: "Da Duda" }] });
  });
  const caio = () => amb.authenticatedContext("caio").firestore();
  const edu = () => amb.authenticatedContext("edu").firestore();
  // Liberado (lista inteira): documento e lotes da busca; a lista dele funciona com array-contains.
  await assertSucceeds(getDoc(doc(ana(), "buscas/bia1")));
  await assertSucceeds(getDoc(doc(ana(), "buscas/bia1/lotes/0")));
  await assertSucceeds(getDocs(query(collection(ana(), "buscas"), where("lista", "==", true), where("liberada_para", "array-contains", "ana"), orderBy("criada_em", "desc"), limit(50))));
  await assertFails(getDocs(query(collection(ana(), "buscas"), where("lista", "==", true), where("liberada_para", "array-contains", "bia"), orderBy("criada_em", "desc"), limit(50))));
  // Recorte: só a cópia dele; nem os lotes inteiros nem a cópia de outro vendedor.
  await assertSucceeds(getDoc(doc(caio(), "buscas/bia1")));
  await assertSucceeds(getDoc(doc(caio(), "buscas/bia1/liberacoes/caio/lotes/0")));
  await assertFails(getDoc(doc(caio(), "buscas/bia1/lotes/0")));
  await assertFails(getDoc(doc(caio(), "buscas/bia1/liberacoes/duda/lotes/0")));
  await assertFails(getDoc(doc(ana(), "buscas/bia1/liberacoes/caio/lotes/0")));
  // Não liberado: negado em tudo.
  await assertFails(getDoc(doc(edu(), "buscas/bia1")));
  await assertFails(getDoc(doc(edu(), "buscas/bia1/lotes/0")));
  await assertFails(getDoc(doc(edu(), "buscas/bia1/liberacoes/caio/lotes/0")));
  // Admin lê tudo; ninguém grava pelo navegador (nem o liberado, nem o admin).
  await assertSucceeds(getDoc(doc(admin(), "buscas/bia1/liberacoes/duda/lotes/0")));
  await assertFails(updateDoc(doc(ana(), "buscas/bia1"), { liberada_para: ["ana", "edu"] }));
  await assertFails(setDoc(doc(caio(), "buscas/bia1/liberacoes/caio/lotes/1"), { leads: [] }));
  await assertFails(setDoc(doc(admin(), "buscas/bia1/liberacoes/edu/lotes/0"), { leads: [] }));
  // Revogar (servidor tira o uid): acesso some.
  await amb.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await updateDoc(doc(db, "buscas/bia1"), { liberada_para: ["caio", "duda"] });
    await updateDoc(doc(db, "buscas/bia1/lotes/0"), { liberada_para: [] });
  });
  await assertFails(getDoc(doc(ana(), "buscas/bia1")));
  await assertFails(getDoc(doc(ana(), "buscas/bia1/lotes/0")));
});

test("mini-CRM e carteira: cada vendedor lê só o próprio CRM; carteira: todos da equipe leem; ninguém grava (vendedor B não escreve no lead do A)", async () => {
  await amb.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "crm/ana__03"), { dono_uid: "ana", leads: { p_x: { s: "contatado", n: "ligar sexta" } } });
    await setDoc(doc(db, "carteira/resolve-farma__03"), { leads: { p_x: { uid: "ana", nome: "Ana", s: "contatado", desde: 1, ultimo: 1 } } });
  });
  const bia = () => amb.authenticatedContext("bia", { papel: "vendedor", equipe_id: "resolve-farma" }).firestore();
  await assertSucceeds(getDoc(doc(ana(), "crm/ana__03")));
  await assertSucceeds(getDoc(doc(ana(), "crm/ana__07"))); // ainda não existe: lê mesmo assim (pelo id)
  await assertFails(getDoc(doc(bia(), "crm/ana__03")));
  await assertFails(getDocs(query(collection(bia(), "crm"))));
  await assertSucceeds(getDocs(query(collection(admin(), "crm"))));
  await assertSucceeds(getDoc(doc(bia(), "carteira/resolve-farma__03")));
  await assertFails(getDoc(doc(anonimo(), "carteira/resolve-farma__03")));
  // Gravação: ninguém pelo navegador — nem o dono, nem o vendedor B tomando o lead, nem o admin.
  await assertFails(setDoc(doc(bia(), "carteira/resolve-farma__03"), { leads: { p_x: { uid: "bia", nome: "Bia", s: "cliente" } } }));
  await assertFails(updateDoc(doc(bia(), "carteira/resolve-farma__03"), { "leads.p_x.uid": "bia" }));
  await assertFails(setDoc(doc(bia(), "crm/ana__03"), { leads: {} }));
  await assertFails(setDoc(doc(bia(), "crm/bia__03"), { dono_uid: "bia", leads: { p_x: { s: "cliente" } } }));
  await assertFails(setDoc(doc(ana(), "crm/ana__03"), { leads: {} }));
  await assertFails(setDoc(doc(admin(), "carteira/resolve-farma__03"), { leads: {} }));
});

// ------------------------------------------------------------ EQUIPES (master › gestor › vendedor)
test("equipes: gestor lê só a equipe dele (buscas, lotes, CRM, carteira, usuários); vendedor não vê outra equipe; master vê tudo", async () => {
  await amb.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // Equipe A (gestor Gil, preposta Paula) e equipe B (preposto Beto); busca do master na área dele.
    await setDoc(doc(db, "equipes/eqa"), { nome: "Equipe A", cotas: { max_usuarios: 10 } });
    await setDoc(doc(db, "equipes/eqb"), { nome: "Equipe B" });
    await setDoc(doc(db, "usuarios/paula"), { equipe_id: "eqa", papel: "vendedor" });
    await setDoc(doc(db, "usuarios/beto"), { equipe_id: "eqb", papel: "vendedor" });
    await setDoc(doc(db, "buscas/pa1"), { dono_uid: "paula", equipe_id: "eqa", lista: true, criada_em: new Date() });
    await setDoc(doc(db, "buscas/pa1/lotes/0"), { dono_uid: "paula", equipe_id: "eqa", leads: [{ nome: "Fictício A" }] });
    await setDoc(doc(db, "buscas/be1"), { dono_uid: "beto", equipe_id: "eqb", lista: true, criada_em: new Date() });
    await setDoc(doc(db, "buscas/be1/lotes/0"), { dono_uid: "beto", equipe_id: "eqb", leads: [{ nome: "Fictício B" }] });
    await setDoc(doc(db, "buscas/ms1"), { dono_uid: "breno", equipe_id: "_master", lista: true, criada_em: new Date() });
    await setDoc(doc(db, "buscas/ms1/lotes/0"), { dono_uid: "breno", equipe_id: "_master", leads: [{ nome: "Do master" }] });
    await setDoc(doc(db, "crm/paula__03"), { dono_uid: "paula", equipe_id: "eqa", leads: {} });
    await setDoc(doc(db, "crm/beto__03"), { dono_uid: "beto", equipe_id: "eqb", leads: {} });
    await setDoc(doc(db, "carteira/eqa__03"), { leads: { p_x: { uid: "paula", nome: "Paula", s: "contatado", ultimo: 1 } } });
    await setDoc(doc(db, "carteira/eqb__03"), { leads: { p_x: { uid: "beto", nome: "Beto", s: "cliente", ultimo: 1 } } });
  });
  const gil = () => amb.authenticatedContext("gil", { papel: "gestor", equipe_id: "eqa" }).firestore();
  const paula = () => amb.authenticatedContext("paula", { papel: "vendedor", equipe_id: "eqa" }).firestore();
  const beto = () => amb.authenticatedContext("beto", { papel: "vendedor", equipe_id: "eqb" }).firestore();
  const master = () => amb.authenticatedContext("breno", { papel: "master", equipe_id: "resolve-farma" }).firestore();
  // Gestor: a equipe dele sim; a outra e a área do master não.
  await assertSucceeds(getDoc(doc(gil(), "buscas/pa1")));
  await assertSucceeds(getDoc(doc(gil(), "buscas/pa1/lotes/0")));
  await assertFails(getDoc(doc(gil(), "buscas/be1")));
  await assertFails(getDoc(doc(gil(), "buscas/be1/lotes/0")));
  await assertFails(getDoc(doc(gil(), "buscas/ms1")));
  await assertSucceeds(getDocs(query(collection(gil(), "buscas"), where("lista", "==", true), where("equipe_id", "==", "eqa"), orderBy("criada_em", "desc"))));
  await assertFails(getDocs(query(collection(gil(), "buscas"), where("lista", "==", true), where("equipe_id", "==", "eqb"), orderBy("criada_em", "desc"))));
  await assertSucceeds(getDocs(query(collection(gil(), "crm"), where("equipe_id", "==", "eqa"))));
  await assertFails(getDocs(query(collection(gil(), "crm"), where("equipe_id", "==", "eqb"))));
  await assertFails(getDoc(doc(gil(), "crm/beto__03")));
  await assertSucceeds(getDoc(doc(gil(), "usuarios/paula")));
  await assertFails(getDoc(doc(gil(), "usuarios/beto")));
  await assertSucceeds(getDoc(doc(gil(), "equipes/eqa")));
  await assertFails(getDoc(doc(gil(), "equipes/eqb")));
  // Carteira isolada: cada equipe lê só a dela (o mesmo estabelecimento p_x está nas duas).
  await assertSucceeds(getDoc(doc(paula(), "carteira/eqa__03")));
  await assertFails(getDoc(doc(paula(), "carteira/eqb__03")));
  await assertSucceeds(getDoc(doc(beto(), "carteira/eqb__03")));
  await assertFails(getDoc(doc(beto(), "carteira/eqa__03")));
  // Preposto: nada da outra equipe, nem da própria equipe que não seja dele.
  await assertFails(getDoc(doc(beto(), "buscas/pa1")));
  await assertFails(getDoc(doc(beto(), "buscas/pa1/lotes/0")));
  await assertFails(getDoc(doc(beto(), "crm/paula__03")));
  await assertFails(getDoc(doc(beto(), "usuarios/paula")));
  await assertFails(getDocs(query(collection(paula(), "buscas"), where("lista", "==", true), where("equipe_id", "==", "eqa"), orderBy("criada_em", "desc"))));
  // Master (papel=master, sem a claim antiga): tudo.
  for (const c of ["buscas/pa1", "buscas/be1/lotes/0", "buscas/ms1", "crm/beto__03", "carteira/eqa__03", "carteira/eqb__03", "equipes/eqb", "usuarios/beto"]) {
    await assertSucceeds(getDoc(doc(master(), c)));
  }
  // Ninguém grava pelo navegador (nem o gestor na própria equipe).
  await assertFails(setDoc(doc(gil(), "equipes/eqa"), { cotas: { max_usuarios: 999 } }));
  await assertFails(setDoc(doc(gil(), "usuarios/paula"), { limite_diario: 999 }));
  await assertFails(updateDoc(doc(gil(), "carteira/eqa__03"), { "leads.p_x.uid": "gil" }));
});

test("equipes: lista do master liberada para uma equipe — o gestor lê; outra equipe e os prepostos não (até o gestor repassar)", async () => {
  await amb.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "buscas/est1"), { dono_uid: "breno", equipe_id: "_master", lista: true, liberada_equipes: ["eqa"], criada_em: new Date() });
    await setDoc(doc(db, "buscas/est1/lotes/0"), { dono_uid: "breno", equipe_id: "_master", liberada_equipes: ["eqa"], leads: [{ nome: "Farmácia" }] });
  });
  const gil = () => amb.authenticatedContext("gil", { papel: "gestor", equipe_id: "eqa" }).firestore();
  const gui = () => amb.authenticatedContext("gui", { papel: "gestor", equipe_id: "eqb" }).firestore();
  const paula = () => amb.authenticatedContext("paula", { papel: "vendedor", equipe_id: "eqa" }).firestore();
  await assertSucceeds(getDoc(doc(gil(), "buscas/est1")));
  await assertSucceeds(getDoc(doc(gil(), "buscas/est1/lotes/0")));
  await assertSucceeds(getDocs(query(collection(gil(), "buscas"), where("lista", "==", true), where("liberada_equipes", "array-contains", "eqa"), orderBy("criada_em", "desc"))));
  await assertFails(getDoc(doc(gui(), "buscas/est1")));
  await assertFails(getDoc(doc(paula(), "buscas/est1/lotes/0")));
  // O gestor repassa à Paula (lista inteira): o lote ganha liberada_para e ela passa a ler.
  await amb.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), "buscas/est1"), { liberada_para: ["paula"] });
    await updateDoc(doc(ctx.firestore(), "buscas/est1/lotes/0"), { liberada_para: ["paula"] });
  });
  await assertSucceeds(getDoc(doc(paula(), "buscas/est1/lotes/0")));
});
