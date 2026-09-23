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
      console.error("Erro inesperado na Function:", erro?.name || "Erro"); // sem dados do usuário
      return json(500, { erro: "Erro inesperado no servidor. Tente novamente." });
    }
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
