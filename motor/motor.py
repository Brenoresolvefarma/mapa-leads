"""
Motor do MapaLeads (roda no GitHub Actions).

O que ele faz:
  1. Se foi disparado pelo formulário do GitHub com termos, cria uma busca comum na fila.
  2. Recupera buscas interrompidas e consolida buscas-mãe do RN que já terminaram.
  3. Esvazia a fila pela regra de prioridade (ver fila.py): buscas comuns primeiro
     (alternando por dono), depois os lotes do RN inteiro. Durante um lote do RN,
     antes de cada consulta o motor olha a fila e atende as buscas comuns que
     chegaram (preempção) — ninguém espera o RN inteiro terminar.
  4. Para cada consulta (termo × cidade/bairro): pausa aleatória de 20–40 s,
     roda o scraper sob a vigia de tempo, trata os dados.
  5. Grava os leads em lotes no Firestore, publica o estado da fila e, se sobrou
     trabalho quando o tempo da execução acabou, dispara a próxima execução.

IMPORTANTE (repositório público, logs visíveis para qualquer pessoa):
  - nunca imprimir dados de leads, termos, cidades, conteúdo da busca ou tokens;
  - só imprimir contagens e status.
"""

import json
import os
import random
import shutil
import sys
import tempfile
import time
from collections import defaultdict
from datetime import timedelta

import firebase_admin
from firebase_admin import auth, credentials, firestore

import fila
import rn_inteiro
import tratamento
import vigia

# Imagem do scraper com versão FIXA (nunca "latest").
IMAGEM_SCRAPER = os.environ.get("SCRAPER_IMAGE", "gosom/google-maps-scraper:v1.18.1")

# Tempo máximo do job no workflow é 350 min; paramos de pegar trabalho novo
# antes disso para dar tempo de gravar resultados e marcar status.
LIMITE_TOTAL_SEG = 320 * 60
# Não começa uma busca/lote se restar menos que isto.
MARGEM_NOVA_BUSCA_SEG = 10 * 60

# Disjuntor do RN inteiro (aprovado): 3 consultas seguidas sem lead -> pausa de 30 min.
DISJUNTOR_VAZIAS = 3
DISJUNTOR_PAUSA = timedelta(minutes=30)

COLECAO = fila.COLECAO


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
    """Busca comum criada pelo formulário do "Run workflow" (uso do admin)."""
    termos = tratamento.dividir_lista(inputs.get("termos"))
    if not termos:
        return None
    dono = os.environ.get("MAPALEADS_ADMIN_UID", "").strip()
    if not dono:
        log("ERRO: secret MAPALEADS_ADMIN_UID não configurado; busca não criada.")
        sys.exit(1)
    cidades = tratamento.dividir_lista(inputs.get("cidades")) or ["Natal RN"]
    profundidade = inputs.get("profundidade") or "normal"
    if profundidade not in tratamento.PROFUNDIDADES:
        profundidade = "normal"
    extrair_email = str(inputs.get("extrair_email")).lower() == "true"

    _, ref = db.collection(COLECAO).add({
        "tipo": fila.TIPO_COMUM,
        "lista": True,  # aparece em "Minhas buscas"
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


def gravar_resultado(ref, dados, dono, leads, resumo, aviso, duracao,
                     status="concluida", mensagem_erro=None):
    """Grava os leads em documentos-lote e fecha a busca, tudo num único batch."""
    db = ref._client
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

    campos = {
        "status": status,
        "resumo": resumo,
        "qtd_lotes": len(lotes),
        "aviso": aviso,
        "finalizada_em": firestore.SERVER_TIMESTAMP,
    }
    if duracao is not None:
        campos["duracao_segundos"] = int(duracao)
    if mensagem_erro:
        campos["mensagem_erro"] = mensagem_erro
    lote_firestore.update(ref, campos)
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


# ------------------------------------------------------------------ Scraper

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


_IMAGEM_BAIXADA = False


def garantir_imagem():
    """Baixa a imagem do scraper só quando há trabalho (o agendamento de 15 em 15 min
    com fila vazia não gasta tempo com isso)."""
    global _IMAGEM_BAIXADA
    if _IMAGEM_BAIXADA:
        return
    import subprocess
    subprocess.run(["docker", "pull", "-q", IMAGEM_SCRAPER], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=600, check=True)
    _IMAGEM_BAIXADA = True


def rodar_consulta(consulta, extrair_email, pasta, limite_seg, nome_arquivo):
    """Roda o scraper (Docker) para UMA consulta, sob a vigia de tempo.

    Retorna (itens, motivo, codigo, segundos).
    A saída do scraper (que contém nomes de lugares) vai para um arquivo
    no runner, NUNCA para o log público. No log só vai o diagnóstico em números.
    """
    entrada = os.path.join(pasta, f"{nome_arquivo}.txt")
    with open(entrada, "w", encoding="utf-8") as arquivo:
        arquivo.write(f"{consulta['texto']} #!#{nome_arquivo}\n")

    arquivo_resultado = os.path.join(pasta, f"{nome_arquivo}.json")
    arquivo_log = os.path.join(pasta, f"{nome_arquivo}.log")
    # Nome único do container, para a vigia conseguir encerrá-lo de verdade.
    nome_container = f"mapaleads-{nome_arquivo}-{int(time.time())}"
    comando = [
        "docker", "run", "--rm",
        "--name", nome_container,
        "-e", "DISABLE_TELEMETRY=1",  # desliga a telemetria do scraper
        "-v", f"{pasta}:/dados",
        IMAGEM_SCRAPER,
        "-input", f"/dados/{nome_arquivo}.txt",
        "-results", f"/dados/{nome_arquivo}.json",
        "-json",
        "-depth", str(tratamento.PROFUNDIDADES[consulta["profundidade"]]),
        "-c", "4",
        "-lang", "pt-BR",
        "-exit-on-inactivity", "3m",
    ]
    if extrair_email:
        comando.append("-email")

    garantir_imagem()
    motivo, codigo, segundos, diag = vigia.executar_com_vigia(
        comando,
        arquivo_resultado=arquivo_resultado,
        arquivo_log=arquivo_log,
        parar=vigia.parar_container(nome_container),
        limite_total=limite_seg,
        limite_primeiro=tratamento.LIMITE_PRIMEIRO_LEAD_MIN * 60,
        limite_sem_atividade=tratamento.sem_atividade_seg(extrair_email),
    )
    log(f"  {vigia.resumo_diagnostico(motivo, codigo, segundos, diag)}")
    return ler_resultados(arquivo_resultado), motivo, codigo, segundos


# ------------------------------------------------------------ Processamento

class Motor:
    def __init__(self, db, paralelo=False):
        self.db = db
        self.paralelo = paralelo
        self.inicio = time.time()
        self.ultimo_fim_consulta = None
        self.metricas = fila.carregar_metricas(db)
        self.duracoes = defaultdict(list)
        self.estado_fila = None
        self.admins = {}
        self.parou_por_tempo = False

    def restante_seg(self):
        return LIMITE_TOTAL_SEG - (time.time() - self.inicio)

    def pausar_entre_consultas(self):
        """Pausa aleatória de 20–40 s desde o fim da última consulta."""
        if self.ultimo_fim_consulta is None:
            return
        pausa = random.uniform(*tratamento.PAUSA_ENTRE_CONSULTAS_SEG)
        falta = self.ultimo_fim_consulta + pausa - time.time()
        if falta > 0:
            time.sleep(falta)

    def publicar_fila(self):
        try:
            self.estado_fila = fila.publicar_estado_fila(self.db, self.metricas, self.estado_fila)
        except Exception as erro:  # noqa: BLE001
            log(f"Não foi possível publicar o estado da fila ({type(erro).__name__}).")

    def eh_admin(self, uid):
        if uid not in self.admins:
            try:
                claims = auth.get_user(uid).custom_claims or {}
                self.admins[uid] = bool(claims.get("admin"))
            except Exception:  # noqa: BLE001
                self.admins[uid] = False
        return self.admins[uid]

    # ------------------------------------------------ consultas

    def executar_consultas(self, ref, consultas, extrair_email, antes=None, depois=None):
        """Roda uma lista de consultas. "antes"/"depois" podem pedir parada.

        Retorna dict com itens, falhas, parciais, feitas e parada
        (None | "cancelada" | "tempo" | "pausa").
        """
        pasta = tempfile.mkdtemp(prefix="mapaleads-")
        resultado = {"itens": [], "falhas": 0, "parciais": 0, "feitas": 0, "parada": None}
        total = len(consultas)
        try:
            for indice, consulta in enumerate(consultas):
                if antes:
                    resultado["parada"] = antes(indice)
                    if resultado["parada"]:
                        break
                limite = min(
                    tratamento.limite_consulta_seg(consulta["profundidade"], extrair_email),
                    self.restante_seg() - 120,
                )
                if limite < 120:
                    resultado["parada"] = "tempo"
                    break
                self.pausar_entre_consultas()
                log(f"Consulta {indice + 1}/{total} iniciada.")
                encontrados = []
                falhou = True  # consulta com erro ou cortada pela vigia (sinal para o disjuntor)
                try:
                    encontrados, motivo, codigo, segundos = rodar_consulta(
                        consulta, extrair_email, pasta, limite, f"q{indice}"
                    )
                    self.duracoes[tratamento.chave_metrica(consulta["profundidade"], extrair_email)].append(segundos)
                    resultado["itens"].extend((e, consulta) for e in encontrados)
                    normal = motivo in vigia.MOTIVOS_NORMAIS
                    falhou = not normal or (motivo == vigia.TERMINOU and codigo not in (0, None))
                    if encontrados and not normal:
                        resultado["parciais"] += 1  # vigia cortou, mas aproveitamos os leads
                    elif not encontrados and (not normal or (motivo == vigia.TERMINOU and codigo not in (0, None))):
                        resultado["falhas"] += 1
                except Exception as erro:  # noqa: BLE001 - uma consulta com falha não derruba a busca
                    resultado["falhas"] += 1
                    log(f"Consulta {indice + 1}/{total}: falhou ({type(erro).__name__}).")
                self.ultimo_fim_consulta = time.time()
                resultado["feitas"] = indice + 1
                log(f"Consulta {indice + 1}/{total}: {len(encontrados)} lugar(es).")
                ref.update({
                    "progresso": f"{indice + 1}/{total}",
                    "consultas_feitas": indice + 1,
                    "batimento_em": firestore.SERVER_TIMESTAMP,
                })
                if depois:
                    resultado["parada"] = depois(indice, encontrados, falhou)
                    if resultado["parada"]:
                        break
        finally:
            # Arquivos temporários (com dados de leads) são apagados do runner.
            shutil.rmtree(pasta, ignore_errors=True)
        return resultado

    @staticmethod
    def montar_aviso(resultado, total, leads):
        avisos = []
        if resultado["falhas"]:
            avisos.append(f"{resultado['falhas']} de {total} consulta(s) falharam.")
        if resultado["parciais"]:
            avisos.append(f"{resultado['parciais']} de {total} consulta(s) encerrada(s) por tempo.")
        if avisos:
            avisos.append("O resultado pode estar incompleto.")
        elif not leads:
            avisos.append("Nenhum lugar encontrado. Confira os termos e a cidade; se persistir, "
                          "pode ser um bloqueio temporário do Google.")
        return " ".join(avisos)

    # ------------------------------------------------ busca comum

    def processar_comum(self, doc):
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
        extrair_email = bool(parametros.get("extrair_email"))

        consultas = fila.consultas_da_busca(dados)
        total = len(consultas)
        log(f"Busca comum iniciada: {total} consulta(s).")
        ref.update({"progresso": f"0/{total}", "total_consultas": total})

        def antes(indice):
            if indice > 0 and (ref.get().to_dict() or {}).get("cancelar_solicitado"):
                return "cancelada"
            return None

        resultado = self.executar_consultas(ref, consultas, extrair_email, antes=antes)
        feitas = resultado["feitas"]

        if resultado["parada"] == "tempo":
            raise ErroBusca(
                f"Tempo limite excedido: a busca foi grande demais para uma execução "
                f"(parou na consulta {feitas + 1} de {total}). Divida em buscas menores."
            )
        if feitas and resultado["falhas"] == feitas and not resultado["itens"]:
            raise ErroBusca(
                "O extrator falhou ou travou em todas as consultas, sem trazer nenhum lugar. "
                "Pode ser um bloqueio temporário do Google ou instabilidade; tente novamente mais tarde."
            )

        leads = tratamento.tratar_resultados(resultado["itens"])
        resumo = tratamento.calcular_resumo(leads)
        log(f"{len(resultado['itens'])} lugar(es) brutos, {len(leads)} após remover duplicados.")

        if resultado["parada"] == "cancelada":
            status, aviso = "cancelada", "Cancelada pelo usuário; leads coletados até o cancelamento."
        else:
            status, aviso = "concluida", self.montar_aviso(resultado, total, leads)
        gravar_resultado(ref, dados, dono, leads, resumo, aviso, time.time() - inicio, status=status)
        fila.registrar_estatisticas(self.db, dono, resumo, log)
        log(f"Busca {status} e gravada.")

    # ------------------------------------------------ RN inteiro (lote)

    def atender_comuns_pendentes(self):
        """Preempção: roda as buscas comuns que chegaram enquanto o RN rodava."""
        while self.restante_seg() > MARGEM_NOVA_BUSCA_SEG and fila.existe_comum_na_fila(self.db, fila.agora_utc()):
            doc = fila.reservar_proxima(self.db, fila.agora_utc(), somente_comum=True)
            if doc is None:
                return
            log("Busca comum passou na frente do RN inteiro.")
            self.publicar_fila()
            self.processar_com_tratamento_de_erro(doc)
            self.publicar_fila()

    def processar_filha(self, doc):
        ref = doc.reference
        dados = doc.to_dict() or {}
        mae_id = dados.get("mae_id")
        mae_ref = self.db.collection(COLECAO).document(mae_id)
        mae = mae_ref.get().to_dict() or {}
        inicio = time.time()
        dono = dados.get("dono_uid") or ""
        extrair_email = bool((dados.get("parametros") or {}).get("extrair_email"))

        def fechar_sem_rodar(status, mensagem=None):
            campos = {"status": status, "finalizada_em": firestore.SERVER_TIMESTAMP}
            if mensagem:
                campos["mensagem_erro"] = mensagem
            ref.update(campos)  # a consolidação da mãe acontece no "finally" do laço

        # Segurança em camadas: RN inteiro só roda se o dono ainda for admin.
        if not self.eh_admin(dono):
            mae_ref.update({"cancelar_solicitado": True})
            fechar_sem_rodar("erro", "RN inteiro é exclusivo do administrador.")
            log("Lote do RN recusado: dono sem permissão de admin.")
            return
        if mae.get("cancelar_solicitado"):
            fechar_sem_rodar("cancelada")
            return
        if mae.get("status") == "na_fila":
            mae_ref.update({"status": "rodando", "iniciada_em": firestore.SERVER_TIMESTAMP})

        consultas = list(dados.get("consultas") or [])
        total = len(consultas)
        log(f"Lote do RN iniciado: {total} consulta(s).")
        ref.update({"progresso": f"0/{total}", "total_consultas": total})
        estado = {"vazias": int(mae.get("vazias_seguidas") or 0), "pausa_ate": None}

        def antes(indice):
            self.atender_comuns_pendentes()
            atual = mae_ref.get().to_dict() or {}
            if atual.get("cancelar_solicitado"):
                return "cancelada"
            return None

        def depois(indice, encontrados, falhou):
            conta = fila.vazia_conta_para_disjuntor(consultas[indice], falhou)
            vazias, disparou = fila.aplicar_disjuntor(estado["vazias"], bool(encontrados), DISJUNTOR_VAZIAS, conta)
            estado["vazias"] = vazias
            mae_ref.update({
                "consultas_feitas": firestore.Increment(1),
                "vazias_seguidas": vazias,
                "batimento_em": firestore.SERVER_TIMESTAMP,
            })
            if disparou:
                estado["pausa_ate"] = fila.agora_utc() + DISJUNTOR_PAUSA
                return "pausa"
            return None

        resultado = self.executar_consultas(ref, consultas, extrair_email, antes=antes, depois=depois)
        restantes = consultas[resultado["feitas"]:]

        if resultado["parada"] == "pausa":
            log("Disjuntor: 3 consultas seguidas sem lead; RN pausado por 30 min.")
            rn_inteiro.pausar_rn(self.db, mae_id, estado["pausa_ate"])
            mae_ref.update({"vazias_seguidas": 0})
        if resultado["parada"] in ("tempo", "pausa") and restantes:
            rn_inteiro.criar_filha_restante(self.db, dados, restantes, estado["pausa_ate"])
            log(f"{len(restantes)} consulta(s) do lote voltaram para a fila.")
            if resultado["parada"] == "tempo":
                self.parou_por_tempo = True

        leads = tratamento.tratar_resultados(resultado["itens"])
        resumo = tratamento.calcular_resumo(leads)
        status = "cancelada" if resultado["parada"] == "cancelada" else "concluida"
        aviso = self.montar_aviso(resultado, max(resultado["feitas"], 1), leads) if leads else ""
        gravar_resultado(ref, dados, dono, leads, resumo, aviso, time.time() - inicio, status=status)
        log(f"Lote do RN {status}: {len(leads)} lead(s).")

    # ------------------------------------------------ laço principal

    def processar_com_tratamento_de_erro(self, doc):
        inicio = time.time()
        tipo = (doc.to_dict() or {}).get("tipo", fila.TIPO_COMUM)
        try:
            if tipo == fila.TIPO_FILHA:
                self.processar_filha(doc)
            else:
                self.processar_comum(doc)
        except ErroBusca as erro:
            log("Busca terminou com erro (mensagem gravada no banco).")
            marcar_erro(doc.reference, str(erro), inicio)
        except Exception as erro:  # noqa: BLE001
            log(f"Busca terminou com erro inesperado ({type(erro).__name__}).")
            marcar_erro(doc.reference, "Erro inesperado no motor. Tente novamente; se persistir, avise o administrador.", inicio)
        finally:
            if tipo == fila.TIPO_FILHA:
                mae_id = (doc.to_dict() or {}).get("mae_id")
                if mae_id:
                    try:
                        rn_inteiro.finalizar_mae_se_pronta(self.db, mae_id, gravar_resultado, log)
                    except Exception as erro:  # noqa: BLE001
                        log(f"Não foi possível consolidar a busca-mãe ({type(erro).__name__}).")

    def rodar(self):
        fila.recuperar_orfas(self.db, self.paralelo, log)
        rn_inteiro.finalizar_maes_pendentes(self.db, gravar_resultado, log)

        processadas = 0
        while True:
            if self.restante_seg() < MARGEM_NOVA_BUSCA_SEG:
                self.parou_por_tempo = True
                break
            doc = fila.reservar_proxima(self.db, fila.agora_utc())
            if doc is None:
                break
            processadas += 1
            self.publicar_fila()
            self.processar_com_tratamento_de_erro(doc)

        try:
            self.metricas = fila.atualizar_metricas(self.db, self.metricas, self.duracoes)
        except Exception as erro:  # noqa: BLE001
            log(f"Não foi possível atualizar as métricas ({type(erro).__name__}).")
        self.publicar_fila()
        log(f"Buscas/lotes processados nesta execução: {processadas}.")

        if self.parou_por_tempo and fila.ha_pendentes_elegiveis(self.db):
            fila.disparar_nova_execucao(log)


def main():
    db = conectar_firestore()
    inputs = ler_inputs_do_disparo()
    criar_busca_manual(db, inputs)
    paralelo = os.environ.get("MOTOR_PARALELO", "").strip().lower() in ("1", "true", "sim")
    Motor(db, paralelo=paralelo).rodar()


if __name__ == "__main__":
    main()
