"""
RN inteiro: busca-mãe e buscas-filhas (lotes).

A Netlify Function cria a busca-mãe e as filhas (cada filha com uma lista de
consultas de ~30–45 min). O motor processa as filhas pela fila e, quando a
última termina, junta os leads de todas, remove duplicados de todo o RN e
grava o resultado na busca-mãe (um único .xlsx segmento-RN-data).

O mesmo mecanismo serve à busca comum dividida em PARTES (paralelismo, 24/09):
a busca comum é a "mãe" (partes_total > 0) e cada parte (tipo "parte") é uma "filha".
"""

import time

from google.cloud.firestore_v1.base_query import FieldFilter

import tratamento
from fila import COLECAO, TIPO_COMUM, TIPO_FILHA, TIPO_MAE, TIPO_PARTE

STATUS_FINAIS = ("concluida", "erro", "cancelada")


def filhas_da_mae(db, mae_id):
    docs = db.collection(COLECAO).where(filter=FieldFilter("mae_id", "==", mae_id)).stream()
    return list(docs)


def ler_leads_da_busca(ref, qtd_lotes):
    """Lê os documentos-lote de uma busca (1 leitura por lote de até 300 leads)."""
    leads = []
    for indice in range(int(qtd_lotes or 0)):
        doc = ref.collection("lotes").document(str(indice)).get()
        if doc.exists:
            leads.extend((doc.to_dict() or {}).get("leads") or [])
    return leads


def criar_filha_restante(db, filha_dados, consultas_restantes, pausada_ate=None):
    """Consultas que não couberam (tempo, pausa do disjuntor ou vaga desligada) viram uma nova filha/parte."""
    from firebase_admin import firestore

    tipo = filha_dados.get("tipo") or TIPO_FILHA
    nova = {
        "tipo": tipo,
        "mae_id": filha_dados["mae_id"],
        "dono_uid": filha_dados["dono_uid"],
        "dono_email": filha_dados.get("dono_email", ""),
        **({"equipe_id": filha_dados["equipe_id"]} if filha_dados.get("equipe_id") else {}),
        "parametros": filha_dados.get("parametros") or {},
        "consultas": consultas_restantes,
        "ordem": int(filha_dados.get("ordem") or 0),
        "status": "na_fila",
        "criada_em": filha_dados.get("criada_em") or firestore.SERVER_TIMESTAMP,
    }
    if pausada_ate is not None:
        nova["pausada_ate"] = pausada_ate
    if filha_dados.get("agendada_para") is not None:
        nova["agendada_para"] = filha_dados["agendada_para"]
    if tipo == TIPO_PARTE:
        # Cidades ainda não prontas desta parte (as prontas já estão nos leads parciais).
        nova["cidades"] = list(dict.fromkeys(c.get("cidade") for c in consultas_restantes))
    _, ref = db.collection(COLECAO).add(nova)
    contador = "partes_total" if tipo == TIPO_PARTE else "filhas_total"
    db.collection(COLECAO).document(filha_dados["mae_id"]).update({contador: firestore.Increment(1)})
    return ref.id


def pausar_rn(db, mae_id, ate):
    """Disjuntor: pausa a busca-mãe e todas as filhas que ainda estão na fila."""
    db.collection(COLECAO).document(mae_id).update({
        "pausada_ate": ate,
        "aviso": "Pausada por 30 min: 3 consultas seguidas sem nenhum lead (possível bloqueio do Google).",
    })
    docs = (db.collection(COLECAO)
            .where(filter=FieldFilter("mae_id", "==", mae_id))
            .where(filter=FieldFilter("status", "==", "na_fila"))
            .stream())
    for doc in docs:
        doc.reference.update({"pausada_ate": ate})


def cancelar_filhas_na_fila(db, mae_id):
    from firebase_admin import firestore

    docs = (db.collection(COLECAO)
            .where(filter=FieldFilter("mae_id", "==", mae_id))
            .where(filter=FieldFilter("status", "==", "na_fila"))
            .stream())
    for doc in docs:
        doc.reference.update({"status": "cancelada", "finalizada_em": firestore.SERVER_TIMESTAMP})


TRAVA_CONSOLIDACAO_SEG = 10 * 60


def pegar_trava_consolidacao(db, mae_ref):
    """True se esta execução pode consolidar a mãe agora (grava consolidando_em na transação)."""
    from datetime import datetime, timezone

    from firebase_admin import firestore

    @firestore.transactional
    def pegar(transacao):
        doc = mae_ref.get(transaction=transacao)
        dados = doc.to_dict() or {}
        if not doc.exists or dados.get("status") in STATUS_FINAIS:
            return False
        agora = datetime.now(timezone.utc)
        travada = dados.get("consolidando_em")
        if travada is not None and (agora - travada).total_seconds() < TRAVA_CONSOLIDACAO_SEG:
            return False
        transacao.update(mae_ref, {"consolidando_em": agora})
        return True

    return pegar(db.transaction())


def finalizar_mae_se_pronta(db, mae_id, gravar_resultado, log):
    """Se nenhuma filha está na fila ou rodando, consolida os leads na mãe.

    gravar_resultado: função do motor que grava lotes + resumo + status.
    """
    mae_ref = db.collection(COLECAO).document(mae_id)
    mae_doc = mae_ref.get()
    if not mae_doc.exists:
        return False
    mae = mae_doc.to_dict() or {}
    if mae.get("status") in STATUS_FINAIS:
        return False
    if mae.get("cancelar_solicitado"):
        cancelar_filhas_na_fila(db, mae_id)

    filhas = filhas_da_mae(db, mae_id)
    if any((f.to_dict() or {}).get("status") not in STATUS_FINAIS for f in filhas):
        return False
    # Com várias vagas, duas partes podem terminar juntas: só UMA consolida (trava por transação;
    # se quem pegou a trava morrer, outra execução pode retomar depois de 10 min).
    if not pegar_trava_consolidacao(db, mae_ref):
        return False

    comum = mae.get("tipo", TIPO_COMUM) == TIPO_COMUM
    nome = "parte(s)" if comum else "lote(s)"
    listas = []
    erros = 0
    for filha in filhas:
        dados = filha.to_dict() or {}
        if dados.get("status") == "erro":
            erros += 1
        listas.append(ler_leads_da_busca(filha.reference, dados.get("qtd_lotes")))
    leads = tratamento.deduplicar_leads(listas)
    resumo = tratamento.calcular_resumo(leads)

    if mae.get("cancelar_solicitado"):
        status, aviso = "cancelada", "Cancelada pelo usuário; leads coletados até o cancelamento."
    elif not leads and filhas and erros == len(filhas):
        status, aviso = "erro", ""
    else:
        status = "concluida"
        aviso = f"{erros} {nome} terminaram com erro; o resultado pode estar incompleto." if erros else ""
        if comum and not leads and not erros:
            aviso = ("Nenhum lugar encontrado. Confira os termos e a cidade; se persistir, "
                     "pode ser um bloqueio temporário do Google.")
    mensagem_erro = (f"Todas as {nome.replace('(s)', 's')} terminaram com erro." if status == "erro" else None)
    duracao = None
    if comum and mae.get("iniciada_em") is not None:
        try:
            duracao = max(0, time.time() - mae["iniciada_em"].timestamp())
        except AttributeError:
            duracao = None
    gravar_resultado(mae_ref, mae, mae.get("dono_uid") or "", leads, resumo, aviso,
                     duracao, status=status, mensagem_erro=mensagem_erro)
    if status != "erro":
        from fila import registrar_estatisticas
        registrar_estatisticas(db, mae.get("dono_uid"), resumo, log, mae.get("equipe_id"))
    log(f"Busca {'comum' if comum else 'mãe'} consolidada: {len(filhas)} {nome}, {len(leads)} lead(s) sem duplicados.")
    return True


def finalizar_maes_pendentes(db, gravar_resultado, log):
    """Mães que ficaram prontas sem filha/parte rodando (ex.: canceladas enquanto na fila)."""
    for tipo in (TIPO_MAE, TIPO_COMUM):
        for status in ("na_fila", "rodando"):
            docs = (db.collection(COLECAO)
                    .where(filter=FieldFilter("tipo", "==", tipo))
                    .where(filter=FieldFilter("status", "==", status))
                    .stream())
            for doc in docs:
                if tipo == TIPO_COMUM and not int((doc.to_dict() or {}).get("partes_total") or 0):
                    continue  # busca comum sem partes: roda direto, não é mãe
                finalizar_mae_se_pronta(db, doc.id, gravar_resultado, log)
