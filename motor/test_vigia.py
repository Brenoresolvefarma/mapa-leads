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
        padrao = dict(limite_total=10, limite_primeiro=5, limite_sem_atividade=1, intervalo=0.05, folga_fim=0.2)
        padrao.update(limites)
        motivo, codigo, _, diag = vigia.executar_com_vigia(
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
    rodar.diag = diag
    return motivo, codigo, resultado


def test_scraper_que_termina_sozinho(tmp_path):
    motivo, codigo, resultado = rodar(tmp_path, GRAVA_E_TERMINA)
    assert motivo == vigia.TERMINOU
    assert codigo == 0
    assert len(resultado.read_text().splitlines()) == 2


def test_travado_depois_de_gravar_e_encerrado_e_mantem_leads(tmp_path):
    motivo, _, resultado = rodar(tmp_path, GRAVA_E_TRAVA, limite_sem_atividade=0.5)
    assert motivo == vigia.TRAVADO
    assert len(resultado.read_text().splitlines()) == 3  # leads parciais preservados


def test_sem_nenhum_lead_no_inicio(tmp_path):
    motivo, _, _ = rodar(tmp_path, SO_TRAVA, limite_primeiro=0.5)
    assert motivo == vigia.SEM_RESULTADOS


def test_limite_total_mesmo_gravando(tmp_path):
    motivo, _, resultado = rodar(tmp_path, GRAVA_SEMPRE, limite_total=0.6, limite_sem_atividade=5)
    assert motivo == vigia.LIMITE_TOTAL
    assert resultado.read_text()  # leads coletados até o limite ficam no arquivo


def test_processo_que_ignora_parar_e_morto_a_forca(tmp_path):
    # "parar" que não faz nada: a vigia precisa matar o processo sozinha.
    resultado = tmp_path / "q0.json"
    motivo, _, _, _ = vigia.executar_com_vigia(
        processo_falso(resultado, SO_TRAVA),
        arquivo_resultado=str(resultado),
        arquivo_log=str(tmp_path / "q0.log"),
        parar=lambda: None,
        limite_total=10, limite_primeiro=0.3, limite_sem_atividade=1, intervalo=0.05,
        tempo_espera_parar=0.5,
    )
    assert motivo == vigia.SEM_RESULTADOS


# ------------------------------------------------------------ fim real

# Simula o scraper de verdade: grava leads, loga no formato JSON do zerolog,
# avisa "scrapemate exited" e depois TRAVA (como na execução real de 23/09).
GRAVA_AVISA_FIM_E_TRAVA = """
import sys, time, json
caminho = sys.argv[1]
def logar(nivel, msg):
    print(json.dumps({"level": nivel, "component": "scrapemate", "job": "https://x/y", "message": msg}), flush=True)
logar("info", "starting scrapemate")
for i in range(4):
    with open(caminho, "a") as f:
        f.write('{"title": "Lugar %d"}\\n' % i)
    logar("info", "job finished")
    time.sleep(0.05)
logar("error", "job finished")
logar("info", "scrapemate exited")
time.sleep(600)
"""

# Log com atividade (etapas) mas sem leads novos: não deve cortar pelo plano B.
ETAPAS_SEM_LEAD_E_DEPOIS_TRAVA = """
import sys, time, json
caminho = sys.argv[1]
with open(caminho, "a") as f:
    f.write('{"title": "A"}\\n')
for i in range(8):
    print(json.dumps({"level": "info", "message": "job finished"}), flush=True)
    time.sleep(0.1)
time.sleep(600)
"""


def test_fim_real_encerra_logo_e_conta_etapas(tmp_path):
    motivo, _, resultado = rodar(tmp_path, GRAVA_AVISA_FIM_E_TRAVA, limite_sem_atividade=30)
    assert motivo == vigia.FIM_REAL
    assert len(resultado.read_text().splitlines()) == 4
    diag = rodar.diag
    assert diag["etapas_ok"] == 4 and diag["etapas_falhas"] == 1
    assert diag["fim_real_seg"] is not None
    assert diag["consentimento"] is False


def test_etapas_no_log_contam_como_atividade(tmp_path):
    # 8 etapas a cada 0,1 s mantêm a consulta viva além de 0,5 s; depois trava.
    motivo, _, _ = rodar(tmp_path, ETAPAS_SEM_LEAD_E_DEPOIS_TRAVA, limite_sem_atividade=0.5)
    assert motivo == vigia.TRAVADO
    assert rodar.diag["etapas_ok"] == 8


def test_leitor_de_log_so_conta_mensagens_permitidas(tmp_path):
    caminho = tmp_path / "q.log"
    caminho.write_text(
        '{"level":"info","message":"job finished","job":"https://maps/xyz?q=segredo"}\n'
        '{"level":"error","message":"job finished"}\n'
        '{"level":"info","message":"exiting because of inactivity"}\n'
        'texto solto com consent.google.com\n'
        '{"level":"info","message":"scrapemate exited"}\n'
        '{"level":"info","message":"job fin',  # linha incompleta
        encoding="utf-8",
    )
    leitor = vigia.LeitorDeLog(str(caminho))
    assert leitor.ler_novidades() == 2
    assert (leitor.etapas_ok, leitor.etapas_falhas) == (1, 1)
    assert leitor.fim_real and leitor.inatividade and leitor.consentimento
    with open(caminho, "a", encoding="utf-8") as f:
        f.write('ished"}\n')
    assert leitor.ler_novidades() == 1


def test_resumo_diagnostico_so_numeros():
    diag = {"etapas_ok": 21, "etapas_falhas": 0, "fim_real_seg": 31, "inatividade": False, "consentimento": False}
    linha = vigia.resumo_diagnostico(vigia.FIM_REAL, -15, 36, diag)
    assert linha == ("término: fim real detectado (código -15), 36s, fim real aos 31s, "
                     "etapas ok=21 falhas=0, inatividade=não, consentimento=não")
    vazio = {"etapas_ok": 0, "etapas_falhas": 0, "fim_real_seg": None, "inatividade": False, "consentimento": False}
    assert "fim real não visto" in vigia.resumo_diagnostico(vigia.TRAVADO, None, 90, vazio)


# ------------------------------------------------------ limites aprovados

def test_limites_por_profundidade_e_email():
    assert tratamento.limite_consulta_seg("rapida", False) == 6 * 60
    assert tratamento.limite_consulta_seg("rapida", True) == 12 * 60
    assert tratamento.limite_consulta_seg("normal", False) == 12 * 60
    assert tratamento.limite_consulta_seg("normal", True) == 24 * 60
    assert tratamento.limite_consulta_seg("completa", False) == 20 * 60
    assert tratamento.limite_consulta_seg("completa", True) == 40 * 60
    assert tratamento.LIMITE_PRIMEIRO_LEAD_MIN == 5
    assert tratamento.sem_atividade_seg(False) == 60
    assert tratamento.sem_atividade_seg(True) == 180
    assert tratamento.PAUSA_ENTRE_CONSULTAS_SEG == (20, 40)
