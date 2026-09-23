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
