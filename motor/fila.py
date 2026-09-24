"""
Fila do MapaLeads.

Regras (aprovadas pelo Breno):
  - buscas comuns passam na frente dos lotes (buscas-filhas) do RN inteiro;
  - busca comum com várias cidades é dividida em PARTES (até 4, por cidade) na criação;
    cada parte roda numa vaga (máquina) diferente ao mesmo tempo e, quando a última
    termina, os leads são juntados sem duplicados na busca (a "mãe" comum);
  - partes entram no rodízio por dono junto com as buscas comuns: buscas de
    vendedores diferentes andam ao mesmo tempo;
  - o Estado inteiro ocupa no máximo 2 vagas (paralelismo.VAGAS_RN_MAX);
  - com outro vendedor esperando, cada vendedor usa no máximo 2 máquinas ao mesmo tempo
    (MAQUINAS_POR_VENDEDOR; o admin não tem esse limite) — valor do Breno, 24/09;
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
TIPO_PARTE = "parte"  # pedaço de uma busca comum (algumas cidades), roda numa vaga

# Com mais de um motor em paralelo, uma busca "rodando" só é órfã depois disto sem sinal de vida.
ORFA_APOS_SEG = 45 * 60


def orfa_apos_seg(dados):
    """Prazo sem sinal de vida para considerar a busca órfã.

    A parte dá sinal de vida a cada CIDADE pronta (todas as consultas daquela cidade):
    prazo = nº de termos × (limite de uma consulta + 1 min) + 10 min de folga.
    """
    if dados.get("tipo") != TIPO_PARTE:
        return ORFA_APOS_SEG
    parametros = dados.get("parametros") or {}
    consultas = dados.get("consultas") or []
    termos = max(1, len({c.get("termo") for c in consultas}) or len(parametros.get("termos") or []))
    profundidade = (consultas[0].get("profundidade") if consultas else None) or "normal"
    if profundidade not in tratamento.PROFUNDIDADES:
        profundidade = "normal"
    limite = tratamento.limite_consulta_seg(profundidade, bool(parametros.get("extrair_email")))
    return termos * (limite + 60) + 600


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


def eh_mae(dados):
    """Busca que nunca roda direto: mãe do RN ou busca comum dividida em partes."""
    tipo = dados.get("tipo", TIPO_COMUM)
    return tipo == TIPO_MAE or (tipo == TIPO_COMUM and int(dados.get("partes_total") or 0) > 0)


def elegivel(dados, agora):
    """A busca pode rodar agora? (na fila, não agendada para depois, não pausada)."""
    if dados.get("status") != "na_fila" or eh_mae(dados):
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
        (b for b in elegiveis if b.get("tipo", TIPO_COMUM) in (TIPO_COMUM, TIPO_PARTE)),
        key=lambda b: (_segundos(b.get("criada_em")), b.get("ordem", 0)),
    )
    # Rodízio por dono: 1ª busca de cada dono, depois a 2ª de cada dono...
    rodada_por_dono = {}
    com_rodada = []
    for b in comuns:
        dono = b.get("dono_uid") or ""
        rodada = rodada_por_dono.get(dono, 0)
        rodada_por_dono[dono] = rodada + 1
        com_rodada.append((rodada, _segundos(b.get("criada_em")), b.get("ordem", 0), b))
    comuns_ordenadas = [b for _, _, _, b in sorted(com_rodada, key=lambda x: (x[0], x[1], x[2]))]

    filhas = sorted(
        (b for b in elegiveis if b.get("tipo") == TIPO_FILHA),
        key=lambda b: (_segundos(b.get("criada_em")), b.get("ordem", 0)),
    )
    return comuns_ordenadas + filhas


MAQUINAS_POR_VENDEDOR = 2


def limitar_por_vendedor(ordem, rodando, isento=lambda uid: False, limite=MAQUINAS_POR_VENDEDOR):
    """Tira da vez as buscas/partes de quem já usa `limite` máquinas, se OUTRO dono estiver esperando.

    ordem: elegíveis na ordem da fila; rodando: buscas/partes rodando agora; isento(uid): admin.
    """
    def de_vendedor(b):
        return b.get("tipo", TIPO_COMUM) in (TIPO_COMUM, TIPO_PARTE)

    por_dono = {}
    for b in rodando:
        if de_vendedor(b) and not eh_mae(b):
            por_dono[b.get("dono_uid")] = por_dono.get(b.get("dono_uid"), 0) + 1
    esperando = {b.get("dono_uid") for b in ordem if de_vendedor(b)}
    saida = []
    for b in ordem:
        dono = b.get("dono_uid")
        if (de_vendedor(b) and por_dono.get(dono, 0) >= limite and (esperando - {dono})
                and not isento(dono)):
            continue
        saida.append(b)
    return saida


def consultas_da_busca(dados):
    """Lista de consultas de uma busca (comum: termo × cidade; filha e parte: já vem pronta)."""
    if dados.get("tipo") in (TIPO_FILHA, TIPO_PARTE):
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
        if b.get("status") == "rodando" and not eh_mae(b):
            total = estimar_busca_seg(b, metricas)
            passou = max(0.0, _segundos(agora) - _segundos(b.get("iniciada_em"))) if b.get("iniciada_em") else 0
            rodando.append({"id": b["id"], "restante_seg": int(max(30, total - passou))})
    # Buscas agendadas/pausadas aparecem à parte (não entram na contagem de posição).
    aguardando = [
        {"id": b["id"], "tipo": b.get("tipo", TIPO_COMUM), **({"mae_id": b["mae_id"]} if b.get("mae_id") else {})}
        for b in buscas
        if b.get("status") == "na_fila" and not eh_mae(b) and not elegivel(b, agora)
    ]
    return {"itens": itens, "rodando": rodando, "aguardando": aguardando}


def aplicar_disjuntor(vazias_seguidas, teve_leads, limite=3, vazia_conta=True):
    """Conta consultas seguidas sem nenhum lead. Retorna (novo_contador, disparou).

    vazia_conta=False (cidade pequena sem resultado, scraper sem falha): não é sinal de
    bloqueio — a contagem fica como está (nem sobe nem zera).
    """
    if teve_leads:
        return 0, False
    if not vazia_conta:
        return vazias_seguidas, False
    vazias_seguidas += 1
    return vazias_seguidas, vazias_seguidas >= limite


# População do Censo 2022 (dados/municipios_<uf>.json), para o disjuntor saber o porte da cidade.
_POPULACAO = None
CIDADE_GRANDE_ACIMA_DE = 20000  # aprovado pelo Breno (24/09)
UFS_COM_DADOS = ("rn", "pb")  # PB ativada em 24/09


def populacao_da_cidade(nome, uf=None):
    """População (Censo 2022) de um município pelo nome e estado ("Natal", "RN"; ou "João Pessoa PB").
    Sem estado: RN (buscas antigas). None se não achar."""
    global _POPULACAO
    if _POPULACAO is None:
        _POPULACAO = {}
        for sigla in UFS_COM_DADOS:
            caminho = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dados", f"municipios_{sigla}.json")
            try:
                with open(caminho, encoding="utf-8") as arquivo:
                    dados = json.load(arquivo)
                for m in dados["municipios"]:
                    _POPULACAO[(sigla.upper(), tratamento.normalizar_nome(m["nome"]))] = m["populacao_2022"]
            except (OSError, ValueError, KeyError):
                pass
    uf = (uf or tratamento.uf_da_cidade(nome) or "RN").upper()
    return _POPULACAO.get((uf, tratamento.cidade_sem_uf(nome)))


def vazia_conta_para_disjuntor(consulta, falhou):
    """Consulta vazia só é sinal de bloqueio se o scraper falhou OU a cidade é grande.

    Regra do Breno (24/09): cidade pequena (até 20 mil hab.) sem resultado não conta.
    Consulta por bairro (Natal, Mossoró, Parnamirim) conta como cidade grande.
    Cidade que não está na lista do IBGE conta (por segurança).
    """
    if falhou or consulta.get("bairro"):
        return True
    populacao = populacao_da_cidade(consulta.get("cidade"), consulta.get("uf"))
    return populacao is None or populacao > CIDADE_GRANDE_ACIMA_DE


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


def reservar_proxima(db, agora, somente_comum=False, vagas_rn=None, isento=lambda uid: False):
    """Pega a próxima busca pela regra de prioridade e marca como "rodando" (transação).

    vagas_rn: quantos lotes do Estado inteiro podem rodar ao mesmo tempo (None = sem limite).
    isento(uid): dono sem o limite de máquinas por vendedor (admin).
    """
    from firebase_admin import firestore

    consulta = db.collection(COLECAO).where(filter=FieldFilter("status", "==", "na_fila")).limit(200)
    rodando = db.collection(COLECAO).where(filter=FieldFilter("status", "==", "rodando")).limit(50)

    @firestore.transactional
    def reservar(transacao):
        docs = list(consulta.stream(transaction=transacao))
        buscas = [_com_id(d) for d in docs]
        ativos = [_com_id(d) for d in rodando.stream(transaction=transacao)]
        ordem = limitar_por_vendedor(ordenar_fila(buscas, agora), ativos, isento)
        if somente_comum:
            ordem = [b for b in ordem if b.get("tipo", TIPO_COMUM) in (TIPO_COMUM, TIPO_PARTE)]
        elif vagas_rn is not None:
            if sum(1 for b in ativos if b.get("tipo") == TIPO_FILHA) >= vagas_rn:
                ordem = [b for b in ordem if b.get("tipo") != TIPO_FILHA]
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
    """Preempção: há busca comum (ou parte dela) esperando? (até 2 leituras pequenas)"""
    for tipo in (TIPO_PARTE, TIPO_COMUM):
        docs = (db.collection(COLECAO)
                .where(filter=FieldFilter("status", "==", "na_fila"))
                .where(filter=FieldFilter("tipo", "==", tipo))
                .limit(5).stream())
        if any(elegivel(_com_id(d), agora) for d in docs):
            return True
    return False


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

    import paralelismo

    buscas = carregar_pendentes(db)
    estado = montar_estado_fila(buscas, agora_utc(), metricas)
    estado["vagas"] = paralelismo.efetivas_agora(db)  # máquinas que podem trabalhar ao mesmo tempo (tela: espera)
    ref = db.collection(DOC_ESTADO_FILA[0]).document(DOC_ESTADO_FILA[1])
    if ultimo is None:
        # 1ª publicação da execução: compara com o que já está no banco (1 leitura)
        # para não gravar à toa a cada 15 min com a fila vazia.
        atual = ref.get().to_dict() or {}
        ultimo = {k: atual.get(k) for k in ("itens", "rodando", "aguardando", "vagas")}
    if estado != ultimo:
        ref.set({**estado, "atualizado_em": firestore.SERVER_TIMESTAMP})
    return estado


def recuperar_orfas(db, paralelo, log):
    """Buscas "rodando" cujo motor morreu.

    - Sem paralelo (padrão): só existe um motor, então toda busca "rodando"
      no início de uma execução é órfã.
    - Com paralelo: órfã só depois de 45 min sem sinal de vida.
    Lote do RN ou parte órfã volta para a fila (1 nova tentativa); busca comum vira erro.
    """
    from firebase_admin import firestore

    agora = agora_utc()
    docs = db.collection(COLECAO).where(filter=FieldFilter("status", "==", "rodando")).stream()
    recuperadas = 0
    for doc in docs:
        dados = doc.to_dict() or {}
        if eh_mae(dados):
            continue
        if paralelo and _segundos(agora) - _segundos(dados.get("batimento_em")) < orfa_apos_seg(dados):
            continue
        recuperadas += 1
        if dados.get("tipo") in (TIPO_FILHA, TIPO_PARTE) and int(dados.get("tentativas") or 0) < 1:
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


def dia_fortaleza(agora=None):
    """Data AAAA-MM-DD no fuso de Fortaleza/Natal (mesmo "dia" do limite diário)."""
    from zoneinfo import ZoneInfo

    return (agora or agora_utc()).astimezone(ZoneInfo("America/Fortaleza")).strftime("%Y-%m-%d")


def registrar_estatisticas(db, dono_uid, resumo, log=None):
    """Soma a busca concluída nas estatísticas do dia (painel "Hoje"): 2 gravações.

    estatisticas/{dia}__{uid}  -> o próprio usuário lê (regra do Firestore);
    estatisticas/{dia}__geral  -> só o admin lê.
    """
    from firebase_admin import firestore

    if not dono_uid:
        return
    dia = dia_fortaleza()
    soma = {
        "buscas": firestore.Increment(1),
        "leads": firestore.Increment(int(resumo.get("total") or 0)),
        "com_whatsapp": firestore.Increment(int(resumo.get("com_whatsapp") or 0)),
        "com_telefone": firestore.Increment(int(resumo.get("com_telefone") or 0)),
        "dia": dia,
    }
    try:
        col = db.collection("estatisticas")
        col.document(f"{dia}__{dono_uid}").set({**soma, "dono_uid": dono_uid}, merge=True)
        col.document(f"{dia}__geral").set(soma, merge=True)
    except Exception as erro:  # noqa: BLE001 - estatística não pode derrubar a busca
        if log:
            log(f"Não foi possível gravar as estatísticas ({type(erro).__name__}).")


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
