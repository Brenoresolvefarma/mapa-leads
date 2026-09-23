"""Testes da vigia de tempo. Simulam o scraper com processos Python (sem Docker)."""

import sys

import tratamento
import vigia


def processo_falso(resultado, script):
    """Comando que roda um "scraper falso" escrito em Python."""
    return [sys.executable, "-c", script, str(resultado)]


# Grava N leads (um por linha) com um intervalo e depois fica travado para sempre.
GRAVA_E_TRAVA = """
import sys, time
caminho = sys.argv[1]
for i in range(3):
    with open(caminho, "a") as f:
        f.write('{"title": "Lugar %d"}\\n' % i)
    time.sleep(0.1)
time.sleep(600)
"""

# Grava 2 leads e termina sozinho.
GRAVA_E_TERMINA = """
import sys
with open(sys.argv[1], "a") as f:
    f.write('{"title": "A"}\\n{"title": "B"}\\n')
"""

# Nunca grava nada e fica travado.
SO_TRAVA = "import time; time.sleep(600)"

# Continua gravando leads para sempre (nunca trava, mas nunca termina).
GRAVA_SEMPRE = """
import sys, time
while True:
    with open(sys.argv[1], "a") as f:
        f.write('{"title": "X"}\\n')
    time.sleep(0.05)
"""


def rodar(tmp_path, script, **limites):
    resultado = tmp_path / "q0.json"
    processos = []

    def parar():
        for p in processos:
            p.terminate()

    # Captura o Popen para a função "parar" conseguir encerrá-lo.
    popen_original = vigia.subprocess.Popen

    def popen_capturando(*args, **kwargs):
        p = popen_original(*args, **kwargs)
        processos.append(p)
        return p

    vigia.subprocess.Popen = popen_capturando
    try:
        padrao = dict(limite_total=10, limite_primeiro=5, limite_sem_novo=1, intervalo=0.05)
        padrao.update(limites)
        motivo, codigo, _ = vigia.executar_com_vigia(
            processo_falso(resultado, script),
            arquivo_resultado=str(resultado),
            arquivo_log=str(tmp_path / "q0.log"),
            parar=parar,
            **padrao,
        )
    finally:
        vigia.subprocess.Popen = popen_original
    # Garante que nenhum processo ficou vivo.
    assert all(p.poll() is not None for p in processos)
    return motivo, codigo, resultado


def test_scraper_que_termina_sozinho(tmp_path):
    motivo, codigo, resultado = rodar(tmp_path, GRAVA_E_TERMINA)
    assert motivo == vigia.TERMINOU
    assert codigo == 0
    assert len(resultado.read_text().splitlines()) == 2


def test_travado_depois_de_gravar_e_encerrado_e_mantem_leads(tmp_path):
    motivo, _, resultado = rodar(tmp_path, GRAVA_E_TRAVA, limite_sem_novo=0.5)
    assert motivo == vigia.TRAVADO
    assert len(resultado.read_text().splitlines()) == 3  # leads parciais preservados


def test_sem_nenhum_lead_no_inicio(tmp_path):
    motivo, _, _ = rodar(tmp_path, SO_TRAVA, limite_primeiro=0.5)
    assert motivo == vigia.SEM_RESULTADOS


def test_limite_total_mesmo_gravando(tmp_path):
    motivo, _, resultado = rodar(tmp_path, GRAVA_SEMPRE, limite_total=0.6, limite_sem_novo=5)
    assert motivo == vigia.LIMITE_TOTAL
    assert resultado.read_text()  # leads coletados até o limite ficam no arquivo


def test_processo_que_ignora_parar_e_morto_a_forca(tmp_path):
    # "parar" que não faz nada: a vigia precisa matar o processo sozinha.
    resultado = tmp_path / "q0.json"
    motivo, _, _ = vigia.executar_com_vigia(
        processo_falso(resultado, SO_TRAVA),
        arquivo_resultado=str(resultado),
        arquivo_log=str(tmp_path / "q0.log"),
        parar=lambda: None,
        limite_total=10, limite_primeiro=0.3, limite_sem_novo=1, intervalo=0.05,
        tempo_espera_parar=0.5,
    )
    assert motivo == vigia.SEM_RESULTADOS


# ------------------------------------------------------------ diagnóstico

LOG_FICTICIO = """
{"level":"INFO","msg":"scrapemate stats","numOfJobsCompleted":5,"numOfJobsFailed":0}
{"level":"INFO","msg":"scrapemate stats","numOfJobsCompleted":21,"numOfJobsFailed":2}
{"level":"INFO","msg":"exiting because of inactivity","error":"inactivity timeout"}
"""


def test_diagnostico_extrai_so_numeros():
    diag = vigia.diagnosticar_log(LOG_FICTICIO)
    assert diag == {"etapas_ok": 21, "etapas_falhas": 2, "inatividade": True, "consentimento": False}


def test_diagnostico_formato_texto_e_consentimento():
    texto = "time=... msg=\"scrapemate stats\" numOfJobsCompleted=7 numOfJobsFailed=1\nclicked consent button"
    diag = vigia.diagnosticar_log(texto)
    assert diag["etapas_ok"] == 7 and diag["etapas_falhas"] == 1
    assert diag["consentimento"] is True
    assert diag["inatividade"] is False


def test_diagnostico_log_vazio():
    diag = vigia.diagnosticar_log("")
    linha = vigia.resumo_diagnostico(vigia.TRAVADO, None, 190, diag)
    assert linha == ("término: vigia (sem leads novos) (código ?), 190s, etapas ok=? falhas=?, "
                     "inatividade=não, consentimento=não")


# ------------------------------------------------------ limites aprovados

def test_limites_por_profundidade_e_email():
    assert tratamento.limite_consulta_seg("rapida", False) == 6 * 60
    assert tratamento.limite_consulta_seg("rapida", True) == 12 * 60
    assert tratamento.limite_consulta_seg("normal", False) == 12 * 60
    assert tratamento.limite_consulta_seg("normal", True) == 24 * 60
    assert tratamento.limite_consulta_seg("completa", False) == 20 * 60
    assert tratamento.limite_consulta_seg("completa", True) == 40 * 60
    assert tratamento.LIMITE_PRIMEIRO_LEAD_MIN == 5
    assert tratamento.LIMITE_SEM_LEAD_NOVO_MIN == 3
