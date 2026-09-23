// GET /api/config-publica
// Configuração PÚBLICA do Firebase para o login no navegador (apiKey web não é segredo:
// quem protege os dados são as regras do Firestore e as Functions). Fica em variável
// de ambiente só para não ficar fixa no código.

import { handler, json } from "../lib/servidor.mjs";

export default handler(async () => {
  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  return json(200, {
    apiKey: process.env.FIREBASE_WEB_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (projectId ? `${projectId}.firebaseapp.com` : ""),
    projectId,
  });
}, { metodo: "GET" });

export const config = { path: "/api/config-publica" };
