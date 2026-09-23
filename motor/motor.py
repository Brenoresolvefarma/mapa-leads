"""
Motor do MapaLeads (roda no GitHub Actions).

O que ele faz:
  1. Se foi disparado pelo formulário do GitHub com termos, cria a busca na fila.
  2. Esvazia a fila: pega a busca "na_fila" mais antiga, processa e repete
     até não sobrar nenhuma. Assim nenhuma busca se perde, mesmo que o
     GitHub descarte uma execução pendente (limitação do "concurrency").
  3. Para cada busca: roda o scraper uma vez por consulta (termo × cidade),
     trata os dados e grava os leads em lotes no Firestore.

IMPORTANTE (repositório público, logs visíveis para qualquer pessoa):
  - nunca imprimir dados de leads, termos, conteúdo da busca ou tokens;
  - só imprimir contagens e status.
"""

import json
import os
import shutil
import sys
import tempfile
import time

import firebase_admin
from firebase_admin import credentials, firestore

import tratamento
import vigia

# Imagem do scraper com versão FIXA (nunca "latest").
IMAGEM_SCRAPER = os.environ.get("SCRAPER_IMAGE", "gosom/google-maps-scraper:v1.18.1")

# Tempo máximo do job no workflow é 350 min; paramos de pegar novas buscas
# antes disso para dar tempo de gravar resultados e marcar status.
LIMITE_TOTAL_SEG = 320 * 60
# O limite de cada consulta depende da profundidade: ver tratamento.LIMITE_CONSULTA_MIN.

COLECAO = "buscas"


def log(mensagem):
    """Log público: só contagens e status."""
    print(f"[motor] {mensagem}", flush=True)


class ErroBusca(Exception):
    """Erro com mensagem clara em português, gravada na busca para o usuário ver."""


# ---------------------------------------------------------------- Firestore

def conectar_firestore():
    conteudo = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not conteudo:
        log("ERRO: secret FIREBASE_SERVICE_ACCOUNT não configurado.")
        sys.exit(1)
    try:
        cred = credentials.Certificate(json.loads(conteudo))
    except (ValueError, KeyError):
        log("ERRO: secret FIREBASE_SERVICE_ACCOUNT inválido (precisa ser o JSON inteiro da chave).")
        sys.exit(1)
    firebase_admin.initialize_app(cred)
    return firestore.client()


def ler_inputs_do_disparo():
    """Lê os campos do formulário direto do evento do GitHub.

    Lemos do arquivo do evento (e não de variáveis de ambiente) para que
    os valores não apareçam no cabeçalho dos logs públicos.
    """
    caminho = os.environ.get("GITHUB_EVENT_PATH")
    if not caminho or not os.path.exists(caminho):
        return {}
    with open(caminho, encoding="utf-8") as arquivo:
        evento = json.load(arquivo)
    return evento.get("inputs") or {}


def criar_busca_manual(db, inputs):
    """Fase 1: cria a busca a partir do formulário do "Run workflow"."""
    termos = tratamento.dividir_lista(inputs.get("termos"))
    if not termos:
        return None
    dono = os.environ.get("MAPALEADS_ADMIN_UID", "").strip()
    if not dono:
        log("ERRO: variável MAPALEADS_ADMIN_UID não configurada; busca não criada.")
        sys.exit(1)
    cidades = tratamento.dividir_lista(inputs.get("cidades")) or ["Natal RN"]
    profundidade = inputs.get("profundidade") or "normal"
    if profundidade not in tratamento.PROFUNDIDADES:
        profundidade = "normal"
    extrair_email = str(inputs.get("extrair_email")).lower() == "true"

    _, ref = db.collection(COLECAO).add({
        "dono_uid": dono,
        "criada_em": firestore.SERVER_TIMESTAMP,
        "status": "na_fila",
        "origem": "github_manual",
        "parametros": {
            "termos": termos,
            "cidades": cidades,
            "extrair_email": extrair_email,
            "profundidade": profundidade,
        },
    })
    log(f"Busca criada na fila: {len(termos)} termo(s) x {len(cidades)} cidade(s).")
    return ref.id


def marcar_orfas_como_erro(db):
    """Buscas "rodando" no início de uma execução ficaram órfãs.

    Só roda uma execução do motor por vez (concurrency), então se algo está
    "rodando" agora é porque a execução anterior foi interrompida.
    """
    orfas = list(db.collection(COLECAO).where("status", "==", "rodando").stream())
    for doc in orfas:
        doc.reference.update({
            "status": "erro",
            "mensagem_erro": "A execução anterior foi interrompida antes de terminar. Dispare a busca novamente.",
            "finalizada_em": firestore.SERVER_TIMESTAMP,
        })
    if orfas:
        log(f"{len(orfas)} busca(s) interrompida(s) marcada(s) como erro.")


def reservar_proxima_busca(db):
    """Pega a busca mais antiga "na_fila" e marca como "rodando" (transação)."""
    consulta = db.collection(COLECAO).where("status", "==", "na_fila").limit(20)

    @firestore.transactional
    def reservar(transacao):
        docs = list(consulta.stream(transaction=transacao))
        if not docs:
            return None
        # Ordena por data no Python (evita criar índice composto no Firestore).
        def data_criacao(d):
            data = (d.to_dict() or {}).get("criada_em")
            return (data is None, data.timestamp() if data else 0)

        docs.sort(key=data_criacao)
        escolhido = docs[0]
        transacao.update(escolhido.reference, {
            "status": "rodando",
            "iniciada_em": firestore.SERVER_TIMESTAMP,
            "mensagem_erro": firestore.DELETE_FIELD,
        })
        return escolhido

    return reservar(db.transaction())


# ------------------------------------------------------------------ Scraper

def rodar_consulta(consulta, parametros, pasta, limite_seg):
    """Roda o scraper (Docker) para UMA consulta, sob a vigia de tempo.

    Retorna (itens, motivo, codigo). "motivo" diz se o scraper terminou
    sozinho ou se a vigia o encerrou (ver vigia.py).

    A saída do scraper (que contém nomes de lugares) vai para um arquivo
    no runner, NUNCA para o log público. No log só vai o diagnóstico em números.
    """
    entrada = os.path.join(pasta, f"{consulta['id']}.txt")
    with open(entrada, "w", encoding="utf-8") as arquivo:
        arquivo.write(f"{consulta['texto']} #!#{consulta['id']}\n")

    resultado_nome = f"{consulta['id']}.json"
    arquivo_resultado = os.path.join(pasta, resultado_nome)
    arquivo_log = os.path.join(pasta, f"{consulta['id']}.log")
    # Nome único do container, para a vigia conseguir encerrá-lo de verdade.
    nome_container = f"mapaleads-{consulta['id']}-{int(time.time())}"
    comando = [
        "docker", "run", "--rm",
        "--name", nome_container,
        "-e", "DISABLE_TELEMETRY=1",  # desliga a telemetria do scraper
        "-v", f"{pasta}:/dados",
        IMAGEM_SCRAPER,
        "-input", f"/dados/{consulta['id']}.txt",
        "-results", f"/dados/{resultado_nome}",
        "-json",
        "-depth", str(tratamento.PROFUNDIDADES[parametros["profundidade"]]),
        "-c", "4",
        "-lang", "pt-BR",
        "-exit-on-inactivity", "3m",
    ]
    if parametros.get("extrair_email"):
        comando.append("-email")

    motivo, codigo, segundos = vigia.executar_com_vigia(
        comando,
        arquivo_resultado=arquivo_resultado,
        arquivo_log=arquivo_log,
        parar=vigia.parar_container(nome_container),
        limite_total=limite_seg,
        limite_primeiro=tratamento.LIMITE_PRIMEIRO_LEAD_MIN * 60,
        limite_sem_novo=tratamento.LIMITE_SEM_LEAD_NOVO_MIN * 60,
    )

    # Diagnóstico seguro: só números e sim/não.
    try:
        with open(arquivo_log, encoding="utf-8", errors="replace") as arquivo:
            diag = vigia.diagnosticar_log(arquivo.read())
    except OSError:
        diag = vigia.diagnosticar_log("")
    log(f"  {vigia.resumo_diagnostico(motivo, codigo, segundos, diag)}")

    return ler_resultados(arquivo_resultado), motivo, codigo


def ler_resultados(caminho):
    """Lê o arquivo de saída do scraper (um objeto JSON por linha)."""
    if not os.path.exists(caminho):
        return []
    itens = []
    with open(caminho, encoding="utf-8") as arquivo:
        conteudo = arquivo.read().strip()
    if not conteudo:
        return []
    # Aceita tanto JSON por linha quanto uma lista JSON única.
    if conteudo.startswith("["):
        dados = json.loads(conteudo)
        return [d for d in dados if isinstance(d, dict)]
    for linha in conteudo.splitlines():
        linha = linha.strip()
        if not linha:
            continue
        try:
            obj = json.loads(linha)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            itens.append(obj)
    return itens


# ------------------------------------------------------------ Processamento

def processar_busca(db, doc, inicio_execucao):
    """Processa uma busca do começo ao fim e grava o resultado."""
    ref = doc.reference
    dados = doc.to_dict() or {}
    parametros = dados.get("parametros") or {}
    dono = dados.get("dono_uid") or ""
    inicio = time.time()

    termos = parametros.get("termos") or []
    cidades = parametros.get("cidades") or []
    if not termos or not cidades or parametros.get("profundidade") not in tratamento.PROFUNDIDADES:
        raise ErroBusca("Parâmetros inválidos: informe pelo menos um termo, uma cidade e a profundidade.")
    if not dono:
        raise ErroBusca("Busca sem dono definido.")

    consultas = tratamento.gerar_consultas(termos, cidades)
    total = len(consultas)
    log(f"Busca iniciada: {total} consulta(s).")
    ref.update({"progresso": f"0/{total}"})

    pasta = tempfile.mkdtemp(prefix="mapaleads-")
    itens = []
    falhas = 0     # consultas sem nenhum lead por erro/travamento
    parciais = 0   # consultas encerradas pela vigia, mas com leads aproveitados
    limite_consulta = tratamento.limite_consulta_seg(
        parametros["profundidade"], parametros.get("extrair_email")
    )
    try:
        for numero, consulta in enumerate(consultas, start=1):
            restante = LIMITE_TOTAL_SEG - (time.time() - inicio_execucao)
            if restante < 120:
                raise ErroBusca(
                    f"Tempo limite excedido: a busca foi grande demais para uma execução "
                    f"(parou na consulta {numero} de {total}). Divida em buscas menores."
                )
            log(f"Consulta {numero}/{total} iniciada.")
            try:
                encontrados, motivo, codigo = rodar_consulta(
                    consulta, parametros, pasta, min(limite_consulta, restante - 60)
                )
                itens.extend((e, consulta["termo"]) for e in encontrados)
                if motivo != vigia.TERMINOU and encontrados:
                    parciais += 1
                elif not encontrados and (motivo != vigia.TERMINOU or codigo != 0):
                    falhas += 1
                log(f"Consulta {numero}/{total}: {len(encontrados)} lugar(es).")
            except Exception as erro:  # noqa: BLE001 - uma consulta com falha não derruba a busca
                falhas += 1
                log(f"Consulta {numero}/{total}: falhou ({type(erro).__name__}).")
            ref.update({"progresso": f"{numero}/{total}"})
    finally:
        # Arquivos temporários (com dados de leads) são apagados do runner.
        shutil.rmtree(pasta, ignore_errors=True)

    if falhas == total:
        raise ErroBusca(
            "O extrator falhou ou travou em todas as consultas, sem trazer nenhum lugar. "
            "Pode ser um bloqueio temporário "
            "do Google ou instabilidade; tente novamente mais tarde."
        )

    leads = tratamento.tratar_resultados(itens)
    resumo = tratamento.calcular_resumo(leads)
    log(f"{len(itens)} lugar(es) brutos, {len(leads)} após remover duplicados.")

    avisos = []
    if falhas:
        avisos.append(f"{falhas} de {total} consulta(s) falharam.")
    if parciais:
        avisos.append(f"{parciais} de {total} consulta(s) encerrada(s) por tempo.")
    if avisos:
        avisos.append("O resultado pode estar incompleto.")
    elif not leads:
        avisos.append("Nenhum lugar encontrado. Confira os termos e a cidade; se persistir, "
                      "pode ser um bloqueio temporário do Google.")
    aviso = " ".join(avisos)

    gravar_resultado(db, ref, dados, dono, leads, resumo, aviso, time.time() - inicio)
    log("Busca concluída e gravada.")


def gravar_resultado(db, ref, dados, dono, leads, resumo, aviso, duracao):
    """Grava os leads em documentos-lote e fecha a busca, tudo num único batch."""
    lotes = tratamento.dividir_em_lotes(leads)
    lotes_antigos = int(dados.get("qtd_lotes") or 0)

    lote_firestore = db.batch()
    for indice, lote in enumerate(lotes):
        lote_firestore.set(ref.collection("lotes").document(str(indice)), {
            "dono_uid": dono,
            "indice": indice,
            "leads": lote,
        })
    # Se a busca for reprocessada e tiver menos lotes, apaga os que sobraram.
    for indice in range(len(lotes), lotes_antigos):
        lote_firestore.delete(ref.collection("lotes").document(str(indice)))

    lote_firestore.update(ref, {
        "status": "concluida",
        "resumo": resumo,
        "qtd_lotes": len(lotes),
        "aviso": aviso,
        "duracao_segundos": int(duracao),
        "finalizada_em": firestore.SERVER_TIMESTAMP,
    })
    try:
        lote_firestore.commit()
    except Exception as erro:  # noqa: BLE001
        raise ErroBusca("Falha ao gravar os resultados no banco de dados. Tente novamente.") from erro


def marcar_erro(ref, mensagem, inicio):
    try:
        ref.update({
            "status": "erro",
            "mensagem_erro": mensagem,
            "duracao_segundos": int(time.time() - inicio),
            "finalizada_em": firestore.SERVER_TIMESTAMP,
        })
    except Exception:  # noqa: BLE001
        log("Não foi possível gravar o status de erro.")


# --------------------------------------------------------------------- Main

def main():
    inicio_execucao = time.time()
    db = conectar_firestore()

    inputs = ler_inputs_do_disparo()
    criar_busca_manual(db, inputs)
    marcar_orfas_como_erro(db)

    processadas = 0
    while time.time() - inicio_execucao < LIMITE_TOTAL_SEG - 300:
        doc = reservar_proxima_busca(db)
        if doc is None:
            break
        processadas += 1
        inicio = time.time()
        try:
            processar_busca(db, doc, inicio_execucao)
        except ErroBusca as erro:
            log("Busca terminou com erro (mensagem gravada no banco).")
            marcar_erro(doc.reference, str(erro), inicio)
        except Exception as erro:  # noqa: BLE001
            log(f"Busca terminou com erro inesperado ({type(erro).__name__}).")
            marcar_erro(doc.reference, "Erro inesperado no motor. Tente novamente; se persistir, avise o administrador.", inicio)

    log(f"Fila vazia. Buscas processadas nesta execução: {processadas}.")


if __name__ == "__main__":
    main()
