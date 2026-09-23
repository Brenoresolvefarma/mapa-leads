"""
Vigia de tempo do scraper.

O scraper às vezes não encerra sozinho (fica esperando uma aba do navegador
travada). A vigia garante que nenhuma consulta fique presa:
  - limite rígido de tempo por consulta;
  - encerra se não gravar nenhum lead nos primeiros minutos;
  - encerra se ficar alguns minutos sem gravar lead novo.
O scraper grava cada lead no arquivo assim que o encontra, então ao encerrar
aproveitamos o que já foi coletado.

Também lê o log do scraper e extrai SÓ números e sim/não para diagnóstico
(nada de nomes, telefones ou endereços vai para o log público).
"""

import os
import re
import subprocess
import time

# Motivos de término de uma consulta.
TERMINOU = "terminou"            # o scraper encerrou sozinho
LIMITE_TOTAL = "limite_total"    # estourou o limite rígido de tempo
SEM_RESULTADOS = "sem_resultados"  # nenhum lead nos primeiros minutos
TRAVADO = "travado"              # parou de gravar leads novos

DESCRICAO_MOTIVO = {
    TERMINOU: "sozinha",
    LIMITE_TOTAL: "vigia (limite de tempo)",
    SEM_RESULTADOS: "vigia (nenhum lead no início)",
    TRAVADO: "vigia (sem leads novos)",
}


def _tamanho(caminho):
    try:
        return os.path.getsize(caminho)
    except OSError:
        return 0


def executar_com_vigia(comando, arquivo_resultado, arquivo_log, parar,
                       limite_total, limite_primeiro, limite_sem_novo,
                       intervalo=5.0, tempo_espera_parar=60, relogio=time.monotonic):
    """Roda o comando e vigia o arquivo de resultados.

    parar: função chamada para encerrar o processo à força (ex.: docker stop).
    tempo_espera_parar: segundos esperando o processo sair depois de "parar";
    se não sair, é morto à força.
    Retorna (motivo, codigo_de_saida, segundos).
    """
    inicio = relogio()
    ultimo_tamanho = 0
    ultimo_crescimento = None  # momento do último lead gravado

    with open(arquivo_log, "a", encoding="utf-8") as saida:
        processo = subprocess.Popen(comando, stdout=saida, stderr=subprocess.STDOUT)
        motivo = TERMINOU
        while processo.poll() is None:
            time.sleep(intervalo)
            agora = relogio()

            tamanho = _tamanho(arquivo_resultado)
            if tamanho > ultimo_tamanho:
                ultimo_tamanho = tamanho
                ultimo_crescimento = agora

            if agora - inicio >= limite_total:
                motivo = LIMITE_TOTAL
            elif ultimo_crescimento is None and agora - inicio >= limite_primeiro:
                motivo = SEM_RESULTADOS
            elif ultimo_crescimento is not None and agora - ultimo_crescimento >= limite_sem_novo:
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

    return motivo, processo.returncode, int(relogio() - inicio)


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


def diagnosticar_log(texto):
    """Extrai do log do scraper SÓ números e sim/não, seguros para log público."""
    concluidas = re.findall(r"numOfJobsCompleted\W{0,3}(\d+)", texto)
    falhas = re.findall(r"numOfJobsFailed\W{0,3}(\d+)", texto)
    return {
        "etapas_ok": int(concluidas[-1]) if concluidas else None,
        "etapas_falhas": int(falhas[-1]) if falhas else None,
        "inatividade": "exiting because of inactivity" in texto,
        "consentimento": bool(re.search(r"consent", texto, re.IGNORECASE)),
    }


def resumo_diagnostico(motivo, codigo, segundos, diag):
    """Linha curta de diagnóstico (só números) para o log público."""
    def num(valor):
        return "?" if valor is None else str(valor)

    return (
        f"término: {DESCRICAO_MOTIVO.get(motivo, motivo)} (código {num(codigo)}), "
        f"{segundos}s, etapas ok={num(diag['etapas_ok'])} falhas={num(diag['etapas_falhas'])}, "
        f"inatividade={'sim' if diag['inatividade'] else 'não'}, "
        f"consentimento={'sim' if diag['consentimento'] else 'não'}"
    )
