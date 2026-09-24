"""
Paralelismo do motor (aprovado pelo Breno em 24/09).

- Até 4 "vagas" (trabalhadores) ao mesmo tempo, no total, somando todas as buscas.
  Cada vaga é um job da matrix do workflow, com um grupo de concurrency próprio:
  o GitHub nunca roda duas execuções da mesma vaga.
- Cada máquina mantém o MESMO ritmo de antes (pausa de 20–40 s entre consultas, -c 4):
  o paralelismo não acelera uma máquina, só usa mais máquinas (cada uma com outro IP).
- Sinal de bloqueio (tela de consentimento/captcha OU consultas vazias em sequência pela
  regra do disjuntor): as vagas caem para a METADE (4 → 2 → 1) e a parte que viu o sinal
  pausa 30 min. A cada 2 h sem novo sinal, volta +1 vaga (até 4).
- "Estado inteiro" usa no máximo 2 vagas; buscas de vendedor sempre passam na frente.

O documento config/paralelismo guarda só números e datas (nada de leads):
  {"vagas_base": 4, "ultimo_sinal_em": <timestamp>, "motivo": "consentimento" | "vazias"}
As vagas "efetivas" são calculadas na hora (base + 1 a cada 2 h desde o último sinal),
sem precisar de nenhum agendamento para subir de volta.
"""

from datetime import datetime, timezone

DOC = ("config", "paralelismo")
VAGAS_MAX = 4
VAGAS_RN_MAX = 2
SOBE_UMA_VAGA_A_CADA_SEG = 2 * 60 * 60
PAUSA_APOS_SINAL_SEG = 30 * 60

MOTIVO_CONSENTIMENTO = "consentimento"
MOTIVO_VAZIAS = "vazias"
DESCRICAO_MOTIVO = {
    MOTIVO_CONSENTIMENTO: "tela de consentimento/captcha",
    MOTIVO_VAZIAS: "consultas vazias em sequência",
}


def _segundos(valor):
    if valor is None:
        return None
    try:
        return valor.timestamp()
    except AttributeError:
        return float(valor)


def vagas_efetivas(doc, agora):
    """Quantas vagas podem trabalhar agora (1 a 4)."""
    doc = doc or {}
    base = int(doc.get("vagas_base") or VAGAS_MAX)
    base = max(1, min(VAGAS_MAX, base))
    sinal = _segundos(doc.get("ultimo_sinal_em"))
    if sinal is None or base >= VAGAS_MAX:
        return base
    subiu = int(max(0.0, _segundos(agora) - sinal) // SOBE_UMA_VAGA_A_CADA_SEG)
    return min(VAGAS_MAX, base + subiu)


def reduzir(doc, agora, motivo):
    """Novo documento depois de um sinal de bloqueio: metade das vagas efetivas (mínimo 1)."""
    antes = vagas_efetivas(doc, agora)
    depois = max(1, antes // 2)
    return {"vagas_base": depois, "ultimo_sinal_em": agora, "motivo": motivo}, antes, depois


def vagas_rn(efetivas):
    """Vagas que o Estado inteiro pode ocupar (no máximo 2, e nunca mais que as efetivas)."""
    return max(1, min(VAGAS_RN_MAX, efetivas))


def sinal_de_bloqueio(consentimento, vazias_seguidas, limite_vazias):
    """Motivo do sinal (ou None): consentimento/captcha vale na hora; vazias pela regra do disjuntor."""
    if consentimento:
        return MOTIVO_CONSENTIMENTO
    if vazias_seguidas >= limite_vazias:
        return MOTIVO_VAZIAS
    return None


# ------------------------------------------------------------- Firestore

def ler(db):
    doc = db.collection(DOC[0]).document(DOC[1]).get()
    return (doc.to_dict() or {}) if doc.exists else {}


def efetivas_agora(db):
    return vagas_efetivas(ler(db), datetime.now(timezone.utc))


def registrar_sinal(db, motivo, log):
    """Reduz as vagas pela metade (transação) e registra no log só números."""
    from firebase_admin import firestore

    ref = db.collection(DOC[0]).document(DOC[1])

    @firestore.transactional
    def aplicar(transacao):
        atual = ref.get(transaction=transacao)
        novo, antes, depois = reduzir(atual.to_dict() if atual.exists else {}, datetime.now(timezone.utc), motivo)
        transacao.set(ref, novo)
        return antes, depois

    antes, depois = aplicar(db.transaction())
    log(f"Sinal de bloqueio ({DESCRICAO_MOTIVO.get(motivo, motivo)}): paralelismo {antes} → {depois}; "
        f"a parte pausa 30 min e volta +1 vaga a cada 2 h sem novo sinal.")
    return depois
