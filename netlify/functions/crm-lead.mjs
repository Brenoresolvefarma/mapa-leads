// POST /api/crm-lead — status de cada lead (mini-CRM) e carteira do vendedor. O navegador não grava nada no Firestore.
// Ações:
//  - status     { busca_id, chave, status, motivo?, anotacao?, proximo? }  (vendedor: só lead de busca dele ou liberada p/ ele;
//                                                                            gestor: também das buscas da equipe)
//  - transferir { chave, para_uid }                                        (master; gestor só dentro da equipe dele)
//  - transferir_carteira { de_uid, para_uid }  → todos os leads da carteira de um preposto para outro (mesma equipe)
//  - liberar_carteira    { uid }               → a carteira do preposto fica livre (antes de desativar)
//  - carteiras  {}                                                         (master: todas; gestor: só a equipe dele)
//
// Onde fica (sem dados de lead além da chave do estabelecimento):
//  - crm/{uid}__{fatia}  { dono_uid, equipe_id, leads: { chave: { s, m, n, p, em, busca, h: [{d, u, s, m, n, p}] } } }
//      s = status, m = motivo do descarte, n = última anotação, p = próximo contato (AAAA-MM-DD), h = histórico (10 últimos)
//      Regra: o próprio vendedor (pelo id do documento), o gestor da equipe e o master leem.
//  - carteira/{equipe}__{fatia} { leads: { chave: { uid, nome, s, desde, ultimo } } } — cada equipe tem a sua: equipes
//      diferentes podem trabalhar o mesmo estabelecimento sem se ver. Os logados da equipe leem.
// Marcar Contatado/Negociando/Cliente põe o lead na carteira do vendedor; Descartado (ou Novo) tira; sem contato há
// config/geral.carteira_dias (padrão 60) volta a ficar livre. Lead na carteira de outro → 409.
// Log: só números (nunca a chave, o nome do lead ou a anotação).

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import {
  EQUIPE_PADRAO, FATIAS_CRM, HISTORICO_MAX, MOTIVOS_DESCARTE, STATUS_CRM, STATUS_DA_CARTEIRA, carteiraAtiva, chaveLead, diasCarteira, equipeDaBusca,
  fatiaDe, idCarteira,
} from "../lib/logica.mjs";
import { getAuth } from "firebase-admin/auth";
import { nomeDe } from "../lib/equipes.mjs";
import { ErroHttp, firebase, handler, json, lerCorpo, logPrivado, usuarioDoToken } from "../lib/servidor.mjs";

export default handler(async (req) => {
  const usuario = await usuarioDoToken(req);
  const corpo = await lerCorpo(req);
  const { auth, db } = firebase();
  switch (corpo.acao) {
    case "status": return json(200, await mudarStatus(auth, db, usuario, corpo));
    case "transferir":
      if (!usuario.admin && !usuario.gestor) throw new ErroHttp(403, "Só o administrador ou o representante transferem leads de carteira.");
      return json(200, await transferir(auth, db, usuario, corpo));
    case "transferir_carteira":
    case "liberar_carteira":
      if (!usuario.admin && !usuario.gestor) throw new ErroHttp(403, "Só o administrador ou o representante mexem na carteira de outro.");
      return json(200, await moverCarteira(auth, db, usuario, corpo));
    case "carteiras":
      if (!usuario.admin && !usuario.gestor) throw new ErroHttp(403, "Acesso exclusivo do administrador ou do representante.");
      return json(200, await carteiras(auth, db, usuario));
    default: throw new ErroHttp(400, "Ação inválida.");
  }
});

export const config = { path: "/api/crm-lead" };

const chaveValida = (c) => typeof c === "string" && /^[ptn]_[A-Za-z0-9_-]{1,200}$/.test(c);
const dataValida = (d) => d === "" || (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));

/** Equipe de um usuário: a das claims da conta; senão usuarios/{uid}.equipe_id; senão a equipe padrão. Removido = null. */
async function equipeDoUsuario(db, uid) {
  const [conta, perfil] = await Promise.all([getAuth().getUser(uid).catch(() => null), db.doc(`usuarios/${uid}`).get()]);
  const p = perfil.data() || {};
  if (!conta || p.removido) return null;
  return conta.customClaims?.equipe_id || p.equipe_id || EQUIPE_PADRAO;
}

/** O vendedor só mexe em lead de busca dele ou liberada para ele; o gestor, também nas da equipe (e o lead precisa estar nela). */
async function conferirAcesso(db, usuario, buscaId, chave) {
  if (usuario.admin) return;
  if (!buscaId || typeof buscaId !== "string" || buscaId.includes("/")) throw new ErroHttp(400, "Informe a busca do lead.");
  const ref = db.doc(`buscas/${buscaId}`);
  const doc = await ref.get();
  const b = doc.data();
  const dono = b?.dono_uid === usuario.uid, liberada = (b?.liberada_para || []).includes(usuario.uid);
  const daEquipe = usuario.gestor && b && (equipeDaBusca(b) === usuario.equipe_id || (b.liberada_equipes || []).includes(usuario.equipe_id));
  if (!doc.exists || (!dono && !liberada && !daEquipe)) throw new ErroHttp(403, "Você só muda o status dos seus leads.");
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
  const refCart = db.doc(`carteira/${idCarteira(usuario.equipe_id, fatia)}`), refCrm = db.doc(`crm/${usuario.uid}__${fatia}`);

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
    t.set(refCrm, { dono_uid: usuario.uid, equipe_id: usuario.equipe_id, leads: { [chave]: reg } }, { merge: true });

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
  const conta = typeof para === "string" && !para.includes("/") ? await auth.getUser(para).catch(() => null) : null;
  if (!conta || conta.disabled || conta.customClaims?.admin || conta.customClaims?.papel === "master") throw new ErroHttp(400, "Escolha um vendedor válido.");
  // A carteira é a da equipe de quem recebe; o gestor só transfere dentro da equipe dele.
  const equipe = await equipeDoUsuario(db, para);
  if (!equipe) throw new ErroHttp(400, "Escolha um vendedor válido.");
  if (!usuario.admin && equipe !== usuario.equipe_id) throw new ErroHttp(403, "Você só transfere leads entre os prepostos da sua equipe.");
  const [nomePara, nomeAdmin] = await Promise.all([nomeDe(auth, db, para), nomeDe(auth, db, usuario.uid)]);
  const fatia = fatiaDe(chave);
  const refCart = db.doc(`carteira/${idCarteira(equipe, fatia)}`), refPara = db.doc(`crm/${para}__${fatia}`);
  return db.runTransaction(async (t) => {
    const cart = await t.get(refCart);
    const entrada = cart.data()?.leads?.[chave];
    const refDe = entrada?.uid && entrada.uid !== para ? db.doc(`crm/${entrada.uid}__${fatia}`) : null;
    const [crmPara, crmDe] = await Promise.all([t.get(refPara), refDe ? t.get(refDe) : null]);
    const agora = Date.now();
    const s = STATUS_DA_CARTEIRA.includes(entrada?.s) ? entrada.s : "contatado";
    const nota = `Transferido por ${nomeAdmin}${entrada?.nome ? ` (antes: ${entrada.nome})` : ""}`;
    const antes = crmPara.data()?.leads?.[chave] || {};
    t.set(refPara, { dono_uid: para, equipe_id: equipe, leads: { [chave]: { ...antes, s, m: "", em: agora, n: antes.n || "", p: antes.p || "",
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

/**
 * Painel "Carteiras": por vendedor, leads na carteira (ativos) e contagem por status; conversão = Cliente ÷ Contatado+.
 * Master: todas as equipes; gestor: só a equipe dele (16 documentos da carteira da equipe + o CRM da equipe).
 */
async function carteiras(auth, db, usuario) {
  const soEquipe = usuario.admin ? null : usuario.equipe_id;
  const refsCart = soEquipe ? Array.from({ length: FATIAS_CRM }, (_, i) => db.doc(`carteira/${idCarteira(soEquipe, String(i).padStart(2, "0"))}`)) : null;
  const [cartDocs, crms, geral, contas, perfis] = await Promise.all([
    soEquipe ? db.getAll(...refsCart) : db.collection("carteira").get().then((r) => r.docs),
    (soEquipe ? db.collection("crm").where("equipe_id", "==", soEquipe) : db.collection("crm")).get(),
    db.doc("config/geral").get(), auth.listUsers(1000),
    (soEquipe ? db.collection("usuarios").where("equipe_id", "==", soEquipe) : db.collection("usuarios")).get(),
  ]);
  const cart = { docs: cartDocs.filter((d) => d.exists) };
  const equipeDe = new Map(perfis.docs.map((d) => [d.id, d.data().equipe_id || EQUIPE_PADRAO]));
  const dias = diasCarteira(geral.data()), agora = Date.now();
  const vend = new Map();
  const de = (uid) => {
    if (!vend.has(uid)) vend.set(uid, { uid, nome: "", equipe_id: equipeDe.get(uid) || null, carteira: 0, por_status: Object.fromEntries(STATUS_CRM.map((s) => [s, 0])) });
    return vend.get(uid);
  };
  const doMaster = (u) => u.customClaims?.admin || u.customClaims?.papel === "master";
  for (const u of contas.users) if (!doMaster(u) && (!soEquipe || equipeDe.get(u.uid) === soEquipe)) de(u.uid).nome = u.displayName || u.email || "vendedor";
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

/**
 * Antes de desativar um preposto (decisão do Breno): a carteira dele vai inteira para outro preposto da mesma equipe
 * (transferir_carteira) ou fica livre (liberar_carteira). Uma transação por fatia (16 documentos da carteira da equipe).
 * No transferir, quem recebe ganha o registro do CRM com uma nota no histórico dos dois.
 */
async function moverCarteira(auth, db, usuario, corpo) {
  const de = corpo.acao === "liberar_carteira" ? corpo.uid : corpo.de_uid;
  const para = corpo.acao === "transferir_carteira" ? corpo.para_uid : null;
  if (!de || typeof de !== "string" || de.includes("/")) throw new ErroHttp(400, "Informe o preposto.");
  const equipe = await equipeDoUsuario(db, de);
  if (!equipe || (!usuario.admin && equipe !== usuario.equipe_id)) throw new ErroHttp(403, "Este preposto não é da sua equipe.");
  if (para !== null) {
    if (typeof para !== "string" || para.includes("/") || para === de) throw new ErroHttp(400, "Escolha outro preposto para receber.");
    const conta = await auth.getUser(para).catch(() => null);
    if (!conta || conta.disabled || (await equipeDoUsuario(db, para)) !== equipe) throw new ErroHttp(400, "Escolha um preposto ativo da mesma equipe.");
  }
  const [nomePara, nomeAdmin, nomeDeQuem] = await Promise.all([para ? nomeDe(auth, db, para) : "", nomeDe(auth, db, usuario.uid), nomeDe(auth, db, de)]);
  let movidos = 0;
  for (let i = 0; i < FATIAS_CRM; i++) {
    const fatia = String(i).padStart(2, "0");
    const refCart = db.doc(`carteira/${idCarteira(equipe, fatia)}`), refDe = db.doc(`crm/${de}__${fatia}`);
    const refPara = para ? db.doc(`crm/${para}__${fatia}`) : null;
    movidos += await db.runTransaction(async (t) => {
      const [cart, crmDe, crmPara] = await Promise.all([t.get(refCart), t.get(refDe), refPara ? t.get(refPara) : null]);
      const agora = Date.now();
      const chaves = Object.entries(cart.data()?.leads || {}).filter(([, e]) => e.uid === de).map(([k]) => k);
      if (!chaves.length) return 0;
      const nota = para ? `Carteira transferida para ${nomePara} por ${nomeAdmin}` : `Carteira liberada por ${nomeAdmin}`;
      const novosDe = {}, novosPara = {};
      for (const k of chaves) {
        const velho = crmDe.data()?.leads?.[k];
        if (velho) novosDe[k] = { ...velho, h: [{ d: agora, u: nomeAdmin, s: velho.s, m: "", n: nota, p: "" }, ...(velho.h || [])].slice(0, HISTORICO_MAX) };
        if (para) {
          const e = cart.data().leads[k], antes = crmPara.data()?.leads?.[k] || {};
          const s = STATUS_DA_CARTEIRA.includes(e.s) ? e.s : "contatado";
          novosPara[k] = { ...antes, s, m: "", em: agora, n: antes.n || velho?.n || "", p: antes.p || velho?.p || "", busca: antes.busca || velho?.busca || "",
            h: [{ d: agora, u: nomeAdmin, s, m: "", n: `Recebido da carteira de ${nomeDeQuem}`, p: "" }, ...(antes.h || [])].slice(0, HISTORICO_MAX) };
        }
      }
      if (Object.keys(novosDe).length) t.set(refDe, { leads: novosDe }, { merge: true });
      if (para) {
        t.set(refPara, { dono_uid: para, equipe_id: equipe, leads: novosPara }, { merge: true });
        const cartNova = Object.fromEntries(chaves.map((k) => [k, { ...cart.data().leads[k], uid: para, nome: nomePara, ultimo: agora }]));
        t.set(refCart, { leads: cartNova }, { merge: true });
      } else {
        t.update(refCart, ...chaves.flatMap((k) => [new FieldPath("leads", k), FieldValue.delete()]));
      }
      return chaves.length;
    });
  }
  logPrivado(`crm-lead: carteira ${para ? "transferida" : "liberada"} (${movidos} lead(s)) na equipe ${equipe}`);
  return { resultado: para ? "transferida" : "liberada", leads: movidos };
}
