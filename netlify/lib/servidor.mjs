// Utilidades de servidor das Netlify Functions: Firebase Admin, token, respostas, disparo do motor.
// As credenciais vêm SÓ das variáveis de ambiente do Netlify (nunca do código).

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createPrivateKey } from "node:crypto";

let firestoreConfigurado = false;

/**
 * Normaliza a chave privada colada no Netlify. Aceita os jeitos comuns de colar:
 * com "\n" literais, com quebras de linha reais, com aspas nas pontas, com a linha
 * inteira `"private_key": "..."` ou até o JSON completo da conta de serviço.
 */
export function normalizarChavePrivada(bruta) {
  let chave = String(bruta ?? "").trim();
  if (chave.startsWith("{")) {
    try {
      chave = String(JSON.parse(chave).private_key ?? chave);
    } catch {
      /* não era JSON completo */
    }
  }
  chave = chave.replace(/^"?private_key"?\s*:\s*/, "").replace(/,\s*$/, "").trim();
  while (/^(["']).*\1$/s.test(chave)) chave = chave.slice(1, -1).trim();
  chave = chave.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (chaveValida(chave)) return `${chave}\n`;
  // Reconstrói o PEM: ignora o que vier antes do cabeçalho (ou um cabeçalho mal colado)
  // e usa só as linhas base64 do corpo, quebrando de 64 em 64 como manda o formato.
  const reconstruida = reconstruirPem(chave);
  return reconstruida && chaveValida(reconstruida) ? reconstruida : chave;
}

function chaveValida(pem) {
  // O firebase-admin exige o PEM começando exatamente pelo cabeçalho.
  if (!/^-----BEGIN PRIVATE KEY-----\n/.test(pem)) return false;
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

function reconstruirPem(texto) {
  const fim = texto.search(/-+\s*END\s+PRIVATE\s+KEY\s*-+/);
  if (fim < 0) return null;
  let antes = texto.slice(0, fim);
  const inicio = antes.match(/-+\s*BEGIN\s+PRIVATE\s+KEY\s*-+/);
  if (inicio) antes = antes.slice(inicio.index + inicio[0].length);
  const corpo = antes.split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).join("");
  if (!corpo) return null;
  const linhas = corpo.match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${linhas}\n-----END PRIVATE KEY-----\n`;
}

/** Descreve o FORMATO da chave (nunca o conteúdo) para uma mensagem de erro útil. */
export function descreverFormatoDaChave(bruta) {
  const texto = String(bruta ?? "");
  const chave = normalizarChavePrivada(texto);
  const partes = [
    `tamanho ${texto.length}`,
    `começa com BEGIN PRIVATE KEY: ${chave.startsWith("-----BEGIN PRIVATE KEY-----") ? "sim" : "não"}`,
    `termina com END PRIVATE KEY: ${/-----END PRIVATE KEY-----\s*$/.test(chave) ? "sim" : "não"}`,
    `linhas: ${chave.split("\n").length}`,
    `BEGIN na posição: ${String(bruta ?? "").search(/BEGIN\s+PRIVATE\s+KEY/)}`,
    `chave válida após normalizar: ${chaveValida(chave) ? "sim" : "não"}`,
  ];
  return partes.join(", ");
}

export function firebase() {
  if (!getApps().length) {
    const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
    const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || "").trim().replace(/^"|"$/g, "");
    const bruta = process.env.FIREBASE_PRIVATE_KEY || "";
    const privateKey = normalizarChavePrivada(bruta);
    if (!projectId || !clientEmail || !privateKey) {
      throw new ErroHttp(500, "Servidor sem credenciais do Firebase configuradas.");
    }
    try {
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    } catch (erro) {
      // Mensagem acionável para o admin, sem expor a chave (só o formato).
      console.error("Credencial do Firebase inválida:", JSON.stringify({ codigo: erro?.code, formato: descreverFormatoDaChave(bruta) }));
      throw new ErroHttp(500,
        "Credencial do Firebase inválida no Netlify (FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL). " +
        `Formato recebido: ${descreverFormatoDaChave(bruta)}.`);
    }
  }
  const db = getFirestore();
  if (!firestoreConfigurado) {
    // Firestore via REST (HTTP/1.1) em vez de gRPC (HTTP/2): recomendado pelo Google para
    // ambientes serverless e evita a camada gRPC no runtime das Functions do Netlify.
    // (Só "ouvir em tempo real" exige gRPC, e as Functions não usam isso.)
    db.settings({ preferRest: true });
    firestoreConfigurado = true;
  }
  return { auth: getAuth(), db };
}

export class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

export function json(status, corpo) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Envolve o handler: trata método, erros e nunca expõe detalhes internos. */
export function handler(fn, { metodo = "POST" } = {}) {
  return async (req) => {
    if (req.method !== metodo) return json(405, { erro: "Método não permitido." });
    try {
      return await fn(req);
    } catch (erro) {
      if (erro instanceof ErroHttp) return json(erro.status, { erro: erro.message });
      // Log técnico (vai só para o log privado do Netlify): nome, código e mensagem do erro.
      // Nunca inclui o corpo do pedido, o token nem dados de leads.
      console.error("Erro inesperado na Function:", JSON.stringify(resumoDoErro(erro)));
      // Para quem chamou, só o código técnico (ex.: 7 = PERMISSION_DENIED do Firestore).
      return json(500, {
        erro: "Erro inesperado no servidor. Tente novamente.",
        codigo: erro?.code === undefined ? null : String(erro.code).slice(0, 40),
      });
    }
  };
}

/** Resumo seguro de um erro para o log: nome, código, mensagem e detalhes (cortados). */
export function resumoDoErro(erro) {
  const cortar = (v, n = 400) => (v === undefined || v === null ? null : String(v).slice(0, n));
  return {
    nome: cortar(erro?.name, 80),
    codigo: cortar(erro?.code, 80),
    mensagem: cortar(erro?.message),
    detalhes: cortar(erro?.details),
    causa: cortar(erro?.cause?.message ?? erro?.cause?.code),
  };
}

/** Valida o ID token do Firebase (cabeçalho Authorization: Bearer ...). */
export async function usuarioDoToken(req) {
  const cabecalho = req.headers.get("authorization") || "";
  const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : "";
  if (!token) throw new ErroHttp(401, "Faça login para continuar.");
  const { auth } = firebase();
  try {
    // checkRevoked: usuário removido/desativado perde o acesso na hora.
    const decodificado = await auth.verifyIdToken(token, true);
    return { uid: decodificado.uid, email: decodificado.email || "", admin: decodificado.admin === true };
  } catch {
    throw new ErroHttp(401, "Sessão inválida ou expirada. Entre novamente.");
  }
}

export async function lerCorpo(req) {
  try {
    return await req.json();
  } catch {
    throw new ErroHttp(400, "Pedido inválido.");
  }
}

/** Dispara o motor no GitHub Actions. Se falhar, o agendamento (a cada 15 min) pega a busca. */
export async function dispararMotor(buscaId = "") {
  const token = process.env.MAPALEADS_GITHUB_TOKEN;
  const repo = process.env.MAPALEADS_GITHUB_REPO;
  if (!token || !repo) return false;
  try {
    const resposta = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/motor.yml/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: buscaId ? { busca_id: buscaId } : {} }),
    });
    return resposta.ok;
  } catch {
    return false;
  }
}
