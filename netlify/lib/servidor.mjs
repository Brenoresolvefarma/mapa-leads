// Utilidades de servidor das Netlify Functions: Firebase Admin, token, respostas, disparo do motor.
// As credenciais vêm SÓ das variáveis de ambiente do Netlify (nunca do código).

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export function firebase() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // O Netlify guarda a chave com "\n" literais: convertemos para quebras de linha.
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    if (!projectId || !clientEmail || !privateKey) {
      throw new ErroHttp(500, "Servidor sem credenciais do Firebase configuradas.");
    }
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return { auth: getAuth(), db: getFirestore() };
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
