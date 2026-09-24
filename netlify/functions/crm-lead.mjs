// POST /api/crm-lead — status de cada lead (mini-CRM) e carteira do vendedor. O navegador não grava nada no Firestore.
// Ações:
//  - status     { busca_id, chave, status, motivo?, anotacao?, proximo? }  (vendedor: só lead de busca dele ou liberada p/ ele)
//  - transferir { chave, para_uid }                                        (só admin)
//  - carteiras  {}                                                         (só admin: leads por vendedor/status, conversão)
//
// Onde fica (sem dados de lead além da chave do estabelecimento):
//  - crm/{uid}__{fatia}  { dono_uid, leads: { chave: { s, m, n, p, em, busca, h: [{d, u, s, m, n, p}] } } }
//      s = status, m = motivo do descarte, n = última anotação, p = próximo contato (AAAA-MM-DD), h = histórico (10 últimos)
//      Regra: o próprio vendedor (pelo id do documento) e o admin leem.
//  - carteira/{fatia}    { leads: { chave: { uid, nome, s, desde, ultimo } } }  — logados leem ("Na carteira de <nome>").
// Marcar Contatado/Negociando/Cliente põe o lead na carteira do vendedor; Descartado (ou Novo) tira; sem contato há
// config/geral.carteira_dias (padrão 60) volta a ficar livre. Lead na carteira de outro → 409.
// Log: só números (nunca a chave, o nome do lead ou a anotação).

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import {
  HISTORICO_MAX, MOTIVOS_DESCARTE, STATUS_CRM, STATUS_DA_CARTEIRA, carteiraAtiva, chaveLead, diasCarteira, fatiaDe,
} from "../lib/logica.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();
  switch (corpo.acao) {
    case "status": return json(200, await mudarStatus(auth, db, usuario, corpo));
    case "transferir":
      if (!usuario.admin) throw new ErroHttp(403, "Só o administrador transfere leads de carteira.");
      return json(200, await transferir(auth, db, usuario, corpo));
    case "carteiras":
      if (!usuario.admin) throw new ErroHttp(403, "Acesso exclusivo do administrador.");
      return json(200, await carteiras(auth, db));
    default: throw new ErroHttp(400, "Ação inválida.");
  }
});

export const config = { path: "/api/crm-lead" };

const chaveValida = (c) => typeof c === "string" && /^[ptn]_[A-Za-z0-9_-]{1,200}$/.test(c);
const dataValida = (d) => d === "" || (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));

async function nomeDe(auth, db, uid) {
  const [conta, perfil] = await Promise.all([auth.getUser(uid).catch(() => null), db.doc(`usuarios/${uid}`).get()]);
  return String(perfil.data()?.nome || conta?.displayName || conta?.email?.split("@")[0] || "vendedor").slice(0, 60);
}

/** O vendedor só mexe em lead de busca dele ou liberada para ele (e o lead precisa estar nela). */
async function conferirAcesso(db, usuario, buscaId, chave) {
  if (usuario.admin) return;
  if (!buscaId || typeof buscaId !== "string" || buscaId.includes("/")) throw new ErroHttp(400, "Informe a busca do lead.");
  const ref = db.doc(`buscas/${buscaId}`);
  const doc = await ref.get();
  const b = doc.data();
  const dono = b?.dono_uid === usuario.uid, liberada = (b?.liberada_para || []).includes(usuario.uid);
  if (!doc.exists || (!dono && !liberada)) throw new ErroHttp(403, "Você só muda o status dos seus leads.");
  let refs;
  const lib = b.liberacoes?.[usuario.uid];
  if (!dono && lib?.modo === "recorte") refs = Array.from({ length: lib.qtd_lotes || 0 }, (_, n) => ref.collection("liberacoes").doc(usuario.uid).collection("lotes").doc(String(n)));
  else if (b.qtd_lotes > 0) refs = Array.from({ length: b.qtd_lotes }, (_, n) => ref.collection("lotes").doc(String(n)));
  else refs = Object.entries(b.parciais || {}).flatMap(([parte, n]) => Array.from({ length: n || 0 }, (_, k) => db.doc(`buscas/${parte}/lotes/${k}`)));
  const lotes = refs.length ? await db.getAll(...refs) : [];
  if (!lotes.some((l) => (l.data()?.leads || []).some((x) => chaveLead(x) === chave))) throw new ErroHttp(403, "Você só muda o status dos seus leads.");
}

async function mudarStatus(auth, db, usuario, corpo) {
  const { chave, status } = corpo;
  if (!chaveValida(chave)) throw new ErroHttp(400, "Lead inválido.");
  if (!STATUS_CRM.includes(status)) throw new ErroHttp(400, "Status inválido.");
  const motivo = status === "descartado" ? corpo.motivo : "";
  if (status === "descartado" && !MOTIVOS_DESCARTE.includes(motivo)) throw new ErroHttp(400, "Escolha o motivo do descarte.");
  const anotacao = corpo.anotacao === undefined ? undefined : String(corpo.anotacao).trim();
  if (anotacao && anotacao.length > 500) throw new ErroHttp(400, "Anotação com no máximo 500 caracteres.");
  const proximo = corpo.proximo === undefined ? undefined : String(corpo.proximo);
  if (proximo !== undefined && !dataValida(proximo)) throw new ErroHttp(400, "Data do próximo contato inválida.");

  await conferirAcesso(db, usuario, corpo.busca_id, chave);
  const [nome, geral] = await Promise.all([nomeDe(auth, db, usuario.uid), db.doc("config/geral").get()]);
  const dias = diasCarteira(geral.data());
  const fatia = fatiaDe(chave);
  const refCart = db.doc(`carteira/${fatia}`), refCrm = db.doc(`crm/${usuario.uid}__${fatia}`);

  return db.runTransaction(async (t) => {
    const [cart, crm] = await Promise.all([t.get(refCart), t.get(refCrm)]);
    const agora = Date.now();
    const entrada = cart.data()?.leads?.[chave];
    const ativa = carteiraAtiva(entrada, agora, dias);
    if (ativa && entrada.uid !== usuario.uid) throw new ErroHttp(409, `Este lead está na carteira de ${entrada.nome}.`);

    const antes = crm.data()?.leads?.[chave] || {};
    const reg = {
      s: status, m: motivo || "",
      n: anotacao ? anotacao : antes.n || "",
      p: proximo !== undefined ? proximo : status === "descartado" || status === "cliente" ? "" : antes.p || "",
      em: agora, busca: String(corpo.busca_id || antes.busca || ""),
      h: [{ d: agora, u: nome, s: status, m: motivo || "", n: anotacao || "", p: proximo || "" }, ...(antes.h || [])].slice(0, HISTORICO_MAX),
    };
    t.set(refCrm, { dono_uid: usuario.uid, leads: { [chave]: reg } }, { merge: true });

    let nova = entrada && ativa ? entrada : null;
    if (STATUS_DA_CARTEIRA.includes(status)) {
      nova = { uid: usuario.uid, nome, s: status, desde: ativa ? entrada.desde : agora, ultimo: agora };
      t.set(refCart, { leads: { [chave]: nova } }, { merge: true });
    } else if (entrada) {
      // Descartado/Novo: sai da carteira (e uma entrada vencida de outro vendedor também é limpa).
      t.update(refCart, new FieldPath("leads", chave), FieldValue.delete());
      nova = null;
    }
    return { registro: reg, carteira: nova, dias };
  });
}

async function transferir(auth, db, usuario, corpo) {
  const { chave, para_uid: para } = corpo;
  if (!chaveValida(chave)) throw new ErroHttp(400, "Lead inválido.");
  const conta = typeof para === "string" ? await auth.getUser(para).catch(() => null) : null;
  if (!conta || conta.disabled || conta.customClaims?.admin) throw new ErroHttp(400, "Escolha um vendedor válido.");
  const [nomePara, nomeAdmin] = await Promise.all([nomeDe(auth, db, para), nomeDe(auth, db, usuario.uid)]);
  const fatia = fatiaDe(chave);
  const refCart = db.doc(`carteira/${fatia}`), refPara = db.doc(`crm/${para}__${fatia}`);
  return db.runTransaction(async (t) => {
    const cart = await t.get(refCart);
    const entrada = cart.data()?.leads?.[chave];
    const refDe = entrada?.uid && entrada.uid !== para ? db.doc(`crm/${entrada.uid}__${fatia}`) : null;
    const [crmPara, crmDe] = await Promise.all([t.get(refPara), refDe ? t.get(refDe) : null]);
    const agora = Date.now();
    const s = STATUS_DA_CARTEIRA.includes(entrada?.s) ? entrada.s : "contatado";
    const nota = `Transferido por ${nomeAdmin}${entrada?.nome ? ` (antes: ${entrada.nome})` : ""}`;
    const antes = crmPara.data()?.leads?.[chave] || {};
    t.set(refPara, { dono_uid: para, leads: { [chave]: { ...antes, s, m: "", em: agora, n: antes.n || "", p: antes.p || "",
      busca: antes.busca || crmDe?.data()?.leads?.[chave]?.busca || "",
      h: [{ d: agora, u: nomeAdmin, s, m: "", n: nota, p: "" }, ...(antes.h || [])].slice(0, HISTORICO_MAX) } } }, { merge: true });
    if (refDe && crmDe?.exists && crmDe.data()?.leads?.[chave]) {
      const velho = crmDe.data().leads[chave];
      t.set(refDe, { leads: { [chave]: { ...velho, h: [{ d: agora, u: nomeAdmin, s: velho.s, m: "", n: `Transferido para ${nomePara}`, p: "" }, ...(velho.h || [])].slice(0, HISTORICO_MAX) } } }, { merge: true });
    }
    const nova = { uid: para, nome: nomePara, s, desde: agora, ultimo: agora };
    t.set(refCart, { leads: { [chave]: nova } }, { merge: true });
    return { carteira: nova };
  });
}

/** Painel "Carteiras": por vendedor, leads na carteira (ativos) e contagem por status; conversão = Cliente ÷ Contatado+. */
async function carteiras(auth, db) {
  const [cart, crms, geral, contas] = await Promise.all([
    db.collection("carteira").get(), db.collection("crm").get(), db.doc("config/geral").get(), auth.listUsers(1000),
  ]);
  const dias = diasCarteira(geral.data()), agora = Date.now();
  const vend = new Map();
  const de = (uid) => {
    if (!vend.has(uid)) vend.set(uid, { uid, nome: "", carteira: 0, por_status: Object.fromEntries(STATUS_CRM.map((s) => [s, 0])) });
    return vend.get(uid);
  };
  for (const u of contas.users) if (!u.customClaims?.admin) de(u.uid).nome = u.displayName || u.email || "vendedor";
  for (const d of cart.docs) for (const e of Object.values(d.data().leads || {})) if (carteiraAtiva(e, agora, dias)) { const v = de(e.uid); v.carteira++; if (!v.nome) v.nome = e.nome; }
  for (const d of crms.docs) {
    const v = de(d.data().dono_uid || d.id.split("__")[0]);
    for (const r of Object.values(d.data().leads || {})) if (v.por_status[r.s] !== undefined) v.por_status[r.s]++;
  }
  const vendedores = [...vend.values()].filter((v) => v.nome || v.carteira).map((v) => {
    const contatados = v.por_status.contatado + v.por_status.negociando + v.por_status.cliente;
    return { ...v, nome: v.nome || "vendedor", contatados, conversao: contatados ? v.por_status.cliente / contatados : null };
  }).sort((a, b) => b.carteira - a.carteira || a.nome.localeCompare(b.nome, "pt-BR"));
  return { dias, vendedores };
}
