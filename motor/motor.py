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

Paralelismo (aprovado pelo Breno em 24/09): o workflow roda até 4 cópias deste motor
ao mesmo tempo ("vagas", MOTOR_VAGA=1..4), cada uma numa máquina. Uma busca comum com
várias cidades chega dividida em partes; cada vaga pega a próxima parte da fila e grava
os leads de cada cidade assim que ela fica pronta (resultados parciais na tela). Sinal de
bloqueio → metade das vagas (ver paralelismo.py). O ritmo de cada máquina não muda.

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
import paralelismo
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
    return ler_resultados(arquivo_resultado), motivo, codigo, segundos, diag


# ------------------------------------------------------------ Processamento

class Motor:
    def __init__(self, db, paralelo=False, vaga=1):
        self.db = db
        self.paralelo = paralelo
        self.vaga = vaga
        self.vazias_seguidas = 0  # sinal de bloqueio desta máquina (mesma regra do disjuntor)
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

    def vaga_ligada(self):
        """Esta vaga pode trabalhar? (vagas efetivas em config/paralelismo; 1 leitura)"""
        try:
            return self.vaga <= paralelismo.efetivas_agora(self.db)
        except Exception:  # noqa: BLE001 - na dúvida, só a vaga 1 trabalha
            return self.vaga == 1

    def observar_sinal(self, consulta, encontrados, falhou, diag):
        """Conta consultas vazias (regra do disjuntor) e a tela de consentimento.

        Retorna o motivo do sinal de bloqueio (e já reduz as vagas) ou None.
        """
        conta = fila.vazia_conta_para_disjuntor(consulta, falhou)
        self.vazias_seguidas, _ = fila.aplicar_disjuntor(self.vazias_seguidas, bool(encontrados), DISJUNTOR_VAZIAS, conta)
        motivo = paralelismo.sinal_de_bloqueio(bool((diag or {}).get("consentimento")), self.vazias_seguidas, DISJUNTOR_VAZIAS)
        if motivo:
            self.vazias_seguidas = 0
            try:
                paralelismo.registrar_sinal(self.db, motivo, log)
            except Exception as erro:  # noqa: BLE001
                log(f"Não foi possível registrar o sinal de bloqueio ({type(erro).__name__}).")
        return motivo

    def eh_admin(self, uid):
        if uid not in self.admins:
            try:
                claims = auth.get_user(uid).custom_claims or {}
                self.admins[uid] = bool(claims.get("admin"))
            except Exception:  # noqa: BLE001
                self.admins[uid] = False
        return self.admins[uid]

    # ------------------------------------------------ consultas

    def executar_consultas(self, ref, consultas, extrair_email, antes=None, depois=None, progresso=True):
        """Roda uma lista de consultas. "antes"/"depois" podem pedir parada.

        progresso=False: não grava o progresso a cada consulta (as partes gravam a cada cidade).
        Retorna dict com itens, falhas, parciais, feitas e parada
        (None | "cancelada" | "tempo" | "pausa" | "vaga").
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
                diag = {}
                falhou = True  # consulta com erro ou cortada pela vigia (sinal para o disjuntor)
                try:
                    retorno = rodar_consulta(consulta, extrair_email, pasta, limite, f"q{indice}")
                    encontrados, motivo, codigo, segundos = retorno[:4]
                    diag = retorno[4] if len(retorno) > 4 else {}
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
                if progresso:
                    ref.update({
                        "progresso": f"{indice + 1}/{total}",
                        "consultas_feitas": indice + 1,
                        "batimento_em": firestore.SERVER_TIMESTAMP,
                    })
                if depois:
                    resultado["parada"] = depois(indice, encontrados, falhou, diag, resultado)
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

        def depois(indice, encontrados, falhou, diag, _resultado):
            self.observar_sinal(consultas[indice], encontrados, falhou, diag)  # só reduz as vagas
            return None

        resultado = self.executar_consultas(ref, consultas, extrair_email, antes=antes, depois=depois)
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
            if indice > 0 and not self.vaga_ligada():
                return "vaga"
            return None

        def depois(indice, encontrados, falhou, diag, _resultado):
            conta = fila.vazia_conta_para_disjuntor(consultas[indice], falhou)
            vazias, disparou = fila.aplicar_disjuntor(estado["vazias"], bool(encontrados), DISJUNTOR_VAZIAS, conta)
            consentimento = bool((diag or {}).get("consentimento"))
            if disparou or consentimento:
                try:  # sinal de bloqueio: metade das vagas (além da pausa de 30 min do RN)
                    paralelismo.registrar_sinal(
                        self.db, paralelismo.MOTIVO_CONSENTIMENTO if consentimento else paralelismo.MOTIVO_VAZIAS, log)
                except Exception as erro:  # noqa: BLE001
                    log(f"Não foi possível registrar o sinal de bloqueio ({type(erro).__name__}).")
                disparou = True
                vazias = 0 if consentimento else vazias
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
            log("Disjuntor: sinal de bloqueio; RN pausado por 30 min.")
            rn_inteiro.pausar_rn(self.db, mae_id, estado["pausa_ate"])
            mae_ref.update({"vazias_seguidas": 0})
        if resultado["parada"] in ("tempo", "pausa", "vaga") and restantes:
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

    # ------------------------------------------------ parte de uma busca comum (paralelismo)

    def gravar_parcial(self, ref, mae_ref, dados, leads, cidades_prontas, consultas_da_cidade):
        """Leads já prontos desta parte (1 cidade a mais) + contadores na mãe, num único batch.

        A tela mostra "X de Y cidades prontas" e já deixa ver esses leads.
        """
        dono = dados.get("dono_uid") or ""
        lotes = tratamento.dividir_em_lotes(leads)
        antigos = int(dados.get("_lotes_parciais") or 0)
        lote = self.db.batch()
        for indice, itens in enumerate(lotes):
            lote.set(ref.collection("lotes").document(str(indice)), {"dono_uid": dono, "indice": indice, "leads": itens})
        for indice in range(len(lotes), antigos):
            lote.delete(ref.collection("lotes").document(str(indice)))
        lote.update(ref, {
            "cidades_prontas": cidades_prontas,
            "qtd_lotes": len(lotes),
            "batimento_em": firestore.SERVER_TIMESTAMP,
        })
        lote.update(mae_ref, {
            "cidades_prontas": firestore.Increment(1),
            "consultas_feitas": firestore.Increment(consultas_da_cidade),
            f"parciais.{ref.id}": len(lotes),
            "batimento_em": firestore.SERVER_TIMESTAMP,
        })
        lote.commit()
        dados["_lotes_parciais"] = len(lotes)

    def processar_parte(self, doc):
        ref = doc.reference
        dados = doc.to_dict() or {}
        mae_ref = self.db.collection(COLECAO).document(dados.get("mae_id"))
        mae = mae_ref.get().to_dict() or {}
        inicio = time.time()
        dono = dados.get("dono_uid") or ""
        extrair_email = bool((dados.get("parametros") or {}).get("extrair_email"))

        if mae.get("cancelar_solicitado"):
            ref.update({"status": "cancelada", "finalizada_em": firestore.SERVER_TIMESTAMP})
            return
        if mae.get("status") == "na_fila":
            mae_ref.update({"status": "rodando", "iniciada_em": firestore.SERVER_TIMESTAMP})

        # Cidade por cidade: todas as consultas (termos) de uma cidade seguidas.
        brutas = list(dados.get("consultas") or [])
        ordem_cidades = {cidade: i for i, cidade in enumerate(dict.fromkeys(c.get("cidade") for c in brutas))}
        consultas = sorted(brutas, key=lambda c: ordem_cidades[c.get("cidade")])
        total = len(consultas)
        log(f"Parte iniciada (vaga {self.vaga}): {total} consulta(s).")
        ref.update({"total_consultas": total, "cidades_prontas": 0})
        estado = {"cidades": 0, "pausa_ate": None}

        def antes(indice):
            if indice == 0:
                return None
            if (mae_ref.get().to_dict() or {}).get("cancelar_solicitado"):
                return "cancelada"
            if not self.vaga_ligada():
                return "vaga"
            return None

        def depois(indice, encontrados, falhou, diag, resultado):
            cidade = consultas[indice].get("cidade")
            ultima_da_cidade = indice + 1 == total or consultas[indice + 1].get("cidade") != cidade
            if ultima_da_cidade:
                estado["cidades"] += 1
                por_cidade = sum(1 for c in consultas if c.get("cidade") == cidade)
                try:
                    self.gravar_parcial(ref, mae_ref, dados, tratamento.tratar_resultados(resultado["itens"]),
                                        estado["cidades"], por_cidade)
                except Exception as erro:  # noqa: BLE001 - o parcial não derruba a parte (o final grava tudo)
                    log(f"Não foi possível gravar o parcial ({type(erro).__name__}).")
                log(f"Cidade pronta ({estado['cidades']} desta parte).")
            if self.observar_sinal(consultas[indice], encontrados, falhou, diag):
                estado["pausa_ate"] = fila.agora_utc() + DISJUNTOR_PAUSA
                return "pausa"
            return None

        resultado = self.executar_consultas(ref, consultas, extrair_email, antes=antes, depois=depois, progresso=False)
        feitas = resultado["feitas"]
        # Cidade começada e não terminada volta inteira (os leads dela ficam só no final desta parte).
        cidades_feitas = list(dict.fromkeys(c.get("cidade") for c in consultas[:feitas]))[:estado["cidades"]]
        restantes = [c for c in consultas if c.get("cidade") not in cidades_feitas]
        if resultado["parada"] in ("tempo", "pausa", "vaga") and restantes:
            rn_inteiro.criar_filha_restante(self.db, dados, restantes, estado["pausa_ate"])
            motivo = {"tempo": "tempo da execução", "pausa": "pausa de 30 min", "vaga": "vaga desligada"}[resultado["parada"]]
            log(f"{len(restantes)} consulta(s) da parte voltaram para a fila ({motivo}).")
            if resultado["parada"] == "tempo":
                self.parou_por_tempo = True
            # Só as cidades prontas ficam nesta parte (sem repetir as que voltaram).
            resultado["itens"] = [(e, c) for e, c in resultado["itens"] if c.get("cidade") in cidades_feitas]

        leads = tratamento.tratar_resultados(resultado["itens"])
        resumo = tratamento.calcular_resumo(leads)
        status = "cancelada" if resultado["parada"] == "cancelada" else "concluida"
        aviso = self.montar_aviso(resultado, max(feitas, 1), leads) if leads else ""
        gravar_resultado(ref, {**dados, "qtd_lotes": dados.get("_lotes_parciais") or dados.get("qtd_lotes")},
                         dono, leads, resumo, aviso, time.time() - inicio, status=status)
        log(f"Parte {status}: {len(leads)} lead(s).")

    # ------------------------------------------------ laço principal

    def processar_com_tratamento_de_erro(self, doc):
        inicio = time.time()
        tipo = (doc.to_dict() or {}).get("tipo", fila.TIPO_COMUM)
        try:
            if tipo == fila.TIPO_FILHA:
                self.processar_filha(doc)
            elif tipo == fila.TIPO_PARTE:
                self.processar_parte(doc)
            else:
                self.processar_comum(doc)
        except ErroBusca as erro:
            log("Busca terminou com erro (mensagem gravada no banco).")
            marcar_erro(doc.reference, str(erro), inicio)
        except Exception as erro:  # noqa: BLE001
            log(f"Busca terminou com erro inesperado ({type(erro).__name__}).")
            marcar_erro(doc.reference, "Erro inesperado no motor. Tente novamente; se persistir, avise o administrador.", inicio)
        finally:
            if tipo in (fila.TIPO_FILHA, fila.TIPO_PARTE):
                mae_id = (doc.to_dict() or {}).get("mae_id")
                if mae_id:
                    try:
                        rn_inteiro.finalizar_mae_se_pronta(self.db, mae_id, gravar_resultado, log)
                    except Exception as erro:  # noqa: BLE001
                        log(f"Não foi possível consolidar a busca-mãe ({type(erro).__name__}).")

    def rodar(self):
        if not self.vaga_ligada():
            log(f"Vaga {self.vaga} desligada agora (paralelismo reduzido); nada a fazer.")
            return
        fila.recuperar_orfas(self.db, self.paralelo, log)
        rn_inteiro.finalizar_maes_pendentes(self.db, gravar_resultado, log)

        processadas = 0
        while True:
            if self.restante_seg() < MARGEM_NOVA_BUSCA_SEG:
                self.parou_por_tempo = True
                break
            efetivas = paralelismo.efetivas_agora(self.db)
            if self.vaga > efetivas:
                log(f"Vaga {self.vaga} desligada (paralelismo {efetivas}); encerrando.")
                break
            doc = fila.reservar_proxima(self.db, fila.agora_utc(), vagas_rn=paralelismo.vagas_rn(efetivas))
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
    try:
        vaga = max(1, min(paralelismo.VAGAS_MAX, int(os.environ.get("MOTOR_VAGA") or 1)))
    except ValueError:
        vaga = 1
    if vaga == 1:  # as 4 vagas recebem o mesmo formulário: só a 1ª cria a busca manual
        criar_busca_manual(db, ler_inputs_do_disparo())
    paralelo = os.environ.get("MOTOR_PARALELO", "").strip().lower() in ("1", "true", "sim")
    Motor(db, paralelo=paralelo, vaga=vaga).rodar()


if __name__ == "__main__":
    main()
