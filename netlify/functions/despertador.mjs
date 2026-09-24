// Despertador (Netlify Scheduled Function, a cada 15 min) — rede de segurança do motor.
// O agendamento do GitHub Actions pode atrasar ou nem disparar; este relógio do Netlify
// olha a fila e, SÓ se houver trabalho (ou busca órfã) e houver vaga livre (até 4 máquinas),
// dispara o motor. Custo: 2 consultas (fila vazia ≈ 2 leituras) + 1 gravação por vez.
// Não recebe pedidos pela internet (Functions agendadas não têm URL pública).

import { decidirDespertar, vagasEfetivas } from "../lib/logica.mjs";
import { dispararMotor, firebase, resumoDoErro } from "../lib/servidor.mjs";

export async function acordar({ db, agora = new Date(), disparar = dispararMotor }) {
  const col = db.collection("buscas");
  // Só os campos necessários (sem termos, cidades ou dono).
  const campos = ["status", "tipo", "agendada_para", "pausada_ate", "batimento_em", "iniciada_em", "partes_total"];
  const [naFila, rodando, paralelismo] = await Promise.all([
    col.where("status", "==", "na_fila").select(...campos).limit(200).get(),
    col.where("status", "==", "rodando").select(...campos).limit(50).get(),
    db.doc("config/paralelismo").get(),
  ]);
  const buscas = [...naFila.docs, ...rodando.docs].map((d) => d.data());
  const decisao = decidirDespertar(buscas, agora, vagasEfetivas(paralelismo.data() || {}, agora));
  const disparou = decisao.disparar ? await disparar("") : false;
  const registro = { ...decisao, disparou, ultima_execucao: agora };
  await db.doc("config/despertador").set(registro);
  return { ...decisao, disparou };
}

export default async () => {
  try {
    const { db } = firebase();
    const r = await acordar({ db });
    console.log(`Despertador: ${r.motivo}, elegíveis=${r.elegiveis}, órfãs=${r.orfas}, disparou=${r.disparou}`);
  } catch (erro) {
    console.error("Despertador falhou:", JSON.stringify(resumoDoErro(erro)));
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: "*/15 * * * *" };
