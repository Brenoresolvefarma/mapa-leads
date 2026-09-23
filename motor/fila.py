"""
Fila do MapaLeads.

Regras (aprovadas pelo Breno):
  - buscas comuns passam na frente dos lotes (buscas-filhas) do RN inteiro;
  - entre as buscas comuns, a fila alterna por dono (quem disparou 5 buscas
    não passa na frente de quem disparou 1);
  - lotes do RN respeitam o agendamento ("agendar para a noite") e a pausa
    do disjuntor;
  - a busca-mãe do RN nunca é processada diretamente: só as filhas.

As funções de ordenação são puras (testáveis sem Firestore). As que falam com
o Firestore ficam no fim do arquivo.
"""

import json
import os
import urllib.request
from datetime import datetime, timezone

from google.cloud.firestore_v1.base_query import FieldFilter

import tratamento

COLECAO = "buscas"
DOC_ESTADO_FILA = ("fila", "estado")
DOC_METRICAS = ("config", "metricas")

TIPO_COMUM = "comum"
TIPO_MAE = "rn_mae"
TIPO_FILHA = "rn_filha"

# Com mais de um motor em paralelo, uma busca "rodando" só é órfã depois disto sem sinal de vida.
ORFA_APOS_SEG = 45 * 60


def agora_utc():
    return datetime.now(timezone.utc)


def _segundos(valor):
    """Timestamp do Firestore (ou None) -> segundos desde 1970 (None vira 0)."""
    if valor is None:
        return 0.0
    try:
        return valor.timestamp()
    except AttributeError:
        return float(valor)


def elegivel(dados, agora):
    """A busca pode rodar agora? (na fila, não agendada para depois, não pausada)."""
    if dados.get("status") != "na_fila" or dados.get("tipo", TIPO_COMUM) == TIPO_MAE:
        return False
    ts_agora = _segundos(agora)
    if _segundos(dados.get("agendada_para")) > ts_agora:
        return False
    if _segundos(dados.get("pausada_ate")) > ts_agora:
        return False
    return True


def ordenar_fila(buscas, agora):
    """Recebe [{"id":..., **dados}] e devolve as elegíveis na ordem de execução."""
    elegiveis = [b for b in buscas if elegivel(b, agora)]
    comuns = sorted(
        (b for b in elegiveis if b.get("tipo", TIPO_COMUM) == TIPO_COMUM),
        key=lambda b: _segundos(b.get("criada_em")),
    )
    # Rodízio por dono: 1ª busca de cada dono, depois a 2ª de cada dono...
    rodada_por_dono = {}
    com_rodada = []
    for b in comuns:
        dono = b.get("dono_uid") or ""
        rodada = rodada_por_dono.get(dono, 0)
        rodada_por_dono[dono] = rodada + 1
        com_rodada.append((rodada, _segundos(b.get("criada_em")), b))
    comuns_ordenadas = [b for _, _, b in sorted(com_rodada, key=lambda x: (x[0], x[1]))]

    filhas = sorted(
        (b for b in elegiveis if b.get("tipo") == TIPO_FILHA),
        key=lambda b: (_segundos(b.get("criada_em")), b.get("ordem", 0)),
    )
    return comuns_ordenadas + filhas


def consultas_da_busca(dados):
    """Lista de consultas de uma busca (comum: termo × cidade; filha: já vem pronta)."""
    if dados.get("tipo") == TIPO_FILHA:
        return list(dados.get("consultas") or [])
    parametros = dados.get("parametros") or {}
    profundidade = parametros.get("profundidade") or "normal"
    if profundidade not in tratamento.PROFUNDIDADES:
        profundidade = "normal"
    return tratamento.gerar_consultas(
        parametros.get("termos") or [], parametros.get("cidades") or [], profundidade
    )


def estimar_busca_seg(dados, metricas=None):
    email = bool((dados.get("parametros") or {}).get("extrair_email"))
    return tratamento.estimar_consultas_seg(consultas_da_busca(dados), email, metricas)


def montar_estado_fila(buscas, agora, metricas=None):
    """Documento público da fila: só IDs, tipo e tempo estimado (sem dono, termos ou cidades)."""
    ordem = ordenar_fila(buscas, agora)
    itens = []
    for b in ordem:
        item = {"id": b["id"], "tipo": b.get("tipo", TIPO_COMUM), "estimativa_seg": estimar_busca_seg(b, metricas)}
        if b.get("mae_id"):
            item["mae_id"] = b["mae_id"]
        itens.append(item)
    rodando = []
    for b in buscas:
        if b.get("status") == "rodando" and b.get("tipo", TIPO_COMUM) != TIPO_MAE:
            total = estimar_busca_seg(b, metricas)
            passou = max(0.0, _segundos(agora) - _segundos(b.get("iniciada_em"))) if b.get("iniciada_em") else 0
            rodando.append({"id": b["id"], "restante_seg": int(max(30, total - passou))})
    # Buscas agendadas/pausadas aparecem à parte (não entram na contagem de posição).
    aguardando = [
        {"id": b["id"], "tipo": b.get("tipo", TIPO_COMUM), **({"mae_id": b["mae_id"]} if b.get("mae_id") else {})}
        for b in buscas
        if b.get("status") == "na_fila" and b.get("tipo", TIPO_COMUM) != TIPO_MAE and not elegivel(b, agora)
    ]
    return {"itens": itens, "rodando": rodando, "aguardando": aguardando}


def aplicar_disjuntor(vazias_seguidas, teve_leads, limite=3):
    """Conta consultas seguidas sem nenhum lead. Retorna (novo_contador, disparou)."""
    if teve_leads:
        return 0, False
    vazias_seguidas += 1
    return vazias_seguidas, vazias_seguidas >= limite


# ------------------------------------------------------------- Firestore

def _com_id(doc):
    dados = doc.to_dict() or {}
    dados["id"] = doc.id
    return dados


def carregar_pendentes(db, limite=200):
    """Buscas na fila ou rodando (1 leitura por documento)."""
    col = db.collection(COLECAO)
    na_fila = col.where(filter=FieldFilter("status", "==", "na_fila")).limit(limite).stream()
    rodando = col.where(filter=FieldFilter("status", "==", "rodando")).limit(limite).stream()
    return [_com_id(d) for d in na_fila] + [_com_id(d) for d in rodando]


def reservar_proxima(db, agora, somente_comum=False):
    """Pega a próxima busca pela regra de prioridade e marca como "rodando" (transação)."""
    from firebase_admin import firestore

    consulta = db.collection(COLECAO).where(filter=FieldFilter("status", "==", "na_fila")).limit(200)

    @firestore.transactional
    def reservar(transacao):
        docs = list(consulta.stream(transaction=transacao))
        buscas = [_com_id(d) for d in docs]
        ordem = ordenar_fila(buscas, agora)
        if somente_comum:
            ordem = [b for b in ordem if b.get("tipo", TIPO_COMUM) == TIPO_COMUM]
        if not ordem:
            return None
        escolhido = next(d for d in docs if d.id == ordem[0]["id"])
        transacao.update(escolhido.reference, {
            "status": "rodando",
            "iniciada_em": firestore.SERVER_TIMESTAMP,
            "batimento_em": firestore.SERVER_TIMESTAMP,
            "mensagem_erro": firestore.DELETE_FIELD,
        })
        return escolhido

    return reservar(db.transaction())


def existe_comum_na_fila(db, agora):
    """Preempção: há busca comum esperando? (1 leitura)"""
    docs = (db.collection(COLECAO)
            .where(filter=FieldFilter("status", "==", "na_fila"))
            .where(filter=FieldFilter("tipo", "==", TIPO_COMUM))
            .limit(1).stream())
    return any(True for _ in docs)


def carregar_metricas(db):
    doc = db.collection(DOC_METRICAS[0]).document(DOC_METRICAS[1]).get()
    return (doc.to_dict() or {}) if doc.exists else {}


def atualizar_metricas(db, metricas, duracoes):
    """Recalibra o tempo médio por consulta com os tempos reais (1 gravação)."""
    if not duracoes:
        return metricas
    novas = dict(metricas)
    for chave, lista in duracoes.items():
        atual = novas.get(chave) or {}
        n = int(atual.get("n") or 0)
        media = float(atual.get("media_seg") or 0)
        soma = media * n + sum(lista)
        n_novo = n + len(lista)
        novas[chave] = {"media_seg": round(soma / n_novo, 1), "n": min(n_novo, 50)}
    db.collection(DOC_METRICAS[0]).document(DOC_METRICAS[1]).set(novas)
    return novas


def publicar_estado_fila(db, metricas, ultimo=None):
    """Grava fila/estado se mudou. Retorna o estado publicado."""
    from firebase_admin import firestore

    buscas = carregar_pendentes(db)
    estado = montar_estado_fila(buscas, agora_utc(), metricas)
    ref = db.collection(DOC_ESTADO_FILA[0]).document(DOC_ESTADO_FILA[1])
    if ultimo is None:
        # 1ª publicação da execução: compara com o que já está no banco (1 leitura)
        # para não gravar à toa a cada 15 min com a fila vazia.
        atual = ref.get().to_dict() or {}
        ultimo = {k: atual.get(k) for k in ("itens", "rodando", "aguardando")}
    if estado != ultimo:
        ref.set({**estado, "atualizado_em": firestore.SERVER_TIMESTAMP})
    return estado


def recuperar_orfas(db, paralelo, log):
    """Buscas "rodando" cujo motor morreu.

    - Sem paralelo (padrão): só existe um motor, então toda busca "rodando"
      no início de uma execução é órfã.
    - Com paralelo: órfã só depois de 45 min sem sinal de vida.
    Lote do RN órfão volta para a fila (1 nova tentativa); busca comum vira erro.
    """
    from firebase_admin import firestore

    agora = agora_utc()
    docs = db.collection(COLECAO).where(filter=FieldFilter("status", "==", "rodando")).stream()
    recuperadas = 0
    for doc in docs:
        dados = doc.to_dict() or {}
        if dados.get("tipo") == TIPO_MAE:
            continue
        if paralelo and _segundos(agora) - _segundos(dados.get("batimento_em")) < ORFA_APOS_SEG:
            continue
        recuperadas += 1
        if dados.get("tipo") == TIPO_FILHA and int(dados.get("tentativas") or 0) < 1:
            doc.reference.update({
                "status": "na_fila",
                "tentativas": int(dados.get("tentativas") or 0) + 1,
                "progresso": firestore.DELETE_FIELD,
            })
        else:
            doc.reference.update({
                "status": "erro",
                "mensagem_erro": "A execução anterior foi interrompida antes de terminar. Dispare a busca novamente.",
                "finalizada_em": firestore.SERVER_TIMESTAMP,
            })
    if recuperadas:
        log(f"{recuperadas} busca(s) interrompida(s) recuperada(s).")
    return recuperadas


def ha_pendentes_elegiveis(db):
    buscas = carregar_pendentes(db)
    return bool(ordenar_fila(buscas, agora_utc()))


def disparar_nova_execucao(log):
    """Dispara o próprio workflow para continuar a fila (GITHUB_TOKEN com actions: write)."""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not token or not repo:
        log("Sem GITHUB_TOKEN/GITHUB_REPOSITORY: a próxima execução fica para o agendamento.")
        return False
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/workflows/motor.yml/dispatches",
        data=json.dumps({"ref": os.environ.get("GITHUB_REF_NAME") or "main"}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30):
            pass
        log("Próxima execução disparada para continuar a fila.")
        return True
    except Exception as erro:  # noqa: BLE001
        log(f"Não foi possível disparar a próxima execução ({type(erro).__name__}); o agendamento cobre.")
        return False
