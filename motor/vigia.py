"""
Vigia de tempo do scraper.

O scraper termina o trabalho mas às vezes não encerra o processo (fica preso
fechando o navegador). A vigia garante que nenhuma consulta fique presa:
  - FIM REAL: quando o log interno do scraper mostra "scrapemate exited",
    o trabalho acabou; esperamos o arquivo de resultados parar de crescer
    por alguns segundos e encerramos o container;
  - PLANO B: encerra se ficar sem atividade (nenhum lead novo e nenhuma
    etapa concluída) por 60 s (sem e-mail) ou 3 min (com e-mail);
  - encerra se não gravar nenhum lead nos primeiros minutos;
  - limite rígido de tempo por consulta.
O scraper grava cada lead no arquivo assim que o encontra, então ao encerrar
aproveitamos o que já foi coletado.

O log interno do scraper fica SÓ no runner. Dele extraímos apenas contagens
de mensagens fixas (lista permitida abaixo) para o log público — nunca URLs,
nomes, termos, telefones ou endereços.
"""

import json
import os
import subprocess
import time

# Motivos de término de uma consulta.
TERMINOU = "terminou"              # o processo encerrou sozinho
FIM_REAL = "fim_real"              # o scraper avisou que terminou; a vigia encerrou o processo
LIMITE_TOTAL = "limite_total"      # estourou o limite rígido de tempo
SEM_RESULTADOS = "sem_resultados"  # nenhum lead nos primeiros minutos
TRAVADO = "travado"                # plano B: ficou sem atividade

# Motivos em que o scraper concluiu o trabalho normalmente.
MOTIVOS_NORMAIS = (TERMINOU, FIM_REAL)

DESCRICAO_MOTIVO = {
    TERMINOU: "sozinha",
    FIM_REAL: "fim real detectado",
    LIMITE_TOTAL: "vigia (limite de tempo)",
    SEM_RESULTADOS: "vigia (nenhum lead no início)",
    TRAVADO: "vigia (sem atividade)",
}

# Mensagens do log interno do scraper que podemos contar (texto fixo, sem dados).
MARCA_FIM = "scrapemate exited"
MSG_ETAPA = "job finished"
MSG_INATIVIDADE = "exiting because of inactivity"

# Depois de ver o fim real, espera o arquivo de resultados ficar parado por isto.
FOLGA_FIM_REAL_SEG = 5


def _tamanho(caminho):
    try:
        return os.path.getsize(caminho)
    except OSError:
        return 0


class LeitorDeLog:
    """Lê o log interno do scraper aos poucos e conta só mensagens permitidas."""

    def __init__(self, caminho):
        self.caminho = caminho
        self.posicao = 0
        self.resto = ""
        self.etapas_ok = 0
        self.etapas_falhas = 0
        self.fim_real = False
        self.inatividade = False
        self.consentimento = False

    def ler_novidades(self):
        """Processa as linhas novas. Retorna quantas etapas novas terminaram."""
        try:
            with open(self.caminho, encoding="utf-8", errors="replace") as arquivo:
                arquivo.seek(self.posicao)
                novo = arquivo.read()
                self.posicao = arquivo.tell()
        except OSError:
            return 0
        texto = self.resto + novo
        linhas = texto.split("\n")
        self.resto = linhas.pop()  # última linha pode estar incompleta
        antes = self.etapas_ok + self.etapas_falhas
        for linha in linhas:
            self._processar_linha(linha)
        return self.etapas_ok + self.etapas_falhas - antes

    def finalizar(self):
        if self.resto:
            self._processar_linha(self.resto)
            self.resto = ""

    def _processar_linha(self, linha):
        if "consent" in linha.lower():
            self.consentimento = True
        mensagem, nivel = "", ""
        try:
            obj = json.loads(linha)
            if isinstance(obj, dict):
                mensagem = str(obj.get("message") or obj.get("msg") or "")
                nivel = str(obj.get("level") or "").lower()
        except ValueError:
            # Linha que não é JSON: procura só as mensagens fixas.
            mensagem = next((m for m in (MARCA_FIM, MSG_ETAPA, MSG_INATIVIDADE) if m in linha), "")
            nivel = "error" if "error" in linha.lower() else "info"
        if mensagem == MSG_ETAPA:
            if nivel == "error":
                self.etapas_falhas += 1
            else:
                self.etapas_ok += 1
        elif mensagem == MARCA_FIM:
            self.fim_real = True
        elif mensagem == MSG_INATIVIDADE:
            self.inatividade = True


def executar_com_vigia(comando, arquivo_resultado, arquivo_log, parar,
                       limite_total, limite_primeiro, limite_sem_atividade,
                       intervalo=5.0, tempo_espera_parar=60, folga_fim=FOLGA_FIM_REAL_SEG,
                       relogio=time.monotonic):
    """Roda o comando e vigia o arquivo de resultados e o log interno.

    parar: função chamada para encerrar o processo à força (ex.: docker stop).
    tempo_espera_parar: segundos esperando o processo sair depois de "parar";
    se não sair, é morto à força.
    Retorna (motivo, codigo_de_saida, segundos, diagnostico).
    """
    inicio = relogio()
    leitor = LeitorDeLog(arquivo_log)
    ultimo_tamanho = 0
    ultima_atividade = inicio
    teve_lead = False
    fim_visto_em = None
    segundo_fim = None

    with open(arquivo_log, "a", encoding="utf-8") as saida:
        processo = subprocess.Popen(comando, stdout=saida, stderr=subprocess.STDOUT)
        motivo = TERMINOU
        while processo.poll() is None:
            time.sleep(intervalo)
            agora = relogio()

            tamanho = _tamanho(arquivo_resultado)
            cresceu = tamanho > ultimo_tamanho
            if cresceu:
                ultimo_tamanho = tamanho
                ultima_atividade = agora
                teve_lead = True
            if leitor.ler_novidades():
                ultima_atividade = agora
            if leitor.fim_real and fim_visto_em is None:
                fim_visto_em = agora
                segundo_fim = int(agora - inicio)
            if cresceu and fim_visto_em is not None:
                fim_visto_em = agora  # ainda gravando: espera parar

            if fim_visto_em is not None and agora - fim_visto_em >= folga_fim:
                motivo = FIM_REAL
            elif agora - inicio >= limite_total:
                motivo = LIMITE_TOTAL
            elif not teve_lead and agora - inicio >= limite_primeiro:
                motivo = SEM_RESULTADOS
            elif teve_lead and agora - ultima_atividade >= limite_sem_atividade:
                motivo = TRAVADO
            else:
                continue

            # Encerra à força e garante que o processo morreu.
            try:
                parar()
            except Exception:  # noqa: BLE001
                pass
            try:
                processo.wait(timeout=tempo_espera_parar)
            except subprocess.TimeoutExpired:
                processo.kill()
                processo.wait()
            break

    leitor.ler_novidades()
    leitor.finalizar()
    if leitor.fim_real and segundo_fim is None:
        segundo_fim = int(relogio() - inicio)
    diagnostico = {
        "etapas_ok": leitor.etapas_ok,
        "etapas_falhas": leitor.etapas_falhas,
        "fim_real_seg": segundo_fim,
        "inatividade": leitor.inatividade,
        "consentimento": leitor.consentimento,
    }
    return motivo, processo.returncode, int(relogio() - inicio), diagnostico


def parar_container(nome):
    """Encerra um container Docker pelo nome (stop educado, depois kill)."""
    def parar():
        subprocess.run(["docker", "stop", "-t", "10", nome],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=60, check=False)
        subprocess.run(["docker", "kill", nome],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=30, check=False)
    return parar


def resumo_diagnostico(motivo, codigo, segundos, diag):
    """Linha curta de diagnóstico (só números) para o log público."""
    def num(valor):
        return "?" if valor is None else str(valor)

    fim = "não visto" if diag.get("fim_real_seg") is None else f"aos {diag['fim_real_seg']}s"
    return (
        f"término: {DESCRICAO_MOTIVO.get(motivo, motivo)} (código {num(codigo)}), "
        f"{segundos}s, fim real {fim}, "
        f"etapas ok={num(diag.get('etapas_ok'))} falhas={num(diag.get('etapas_falhas'))}, "
        f"inatividade={'sim' if diag.get('inatividade') else 'não'}, "
        f"consentimento={'sim' if diag.get('consentimento') else 'não'}"
    )
