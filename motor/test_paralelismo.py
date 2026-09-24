"""Testes das regras de paralelismo (sem Firestore)."""

from datetime import datetime, timedelta, timezone

import paralelismo as P

AGORA = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


def test_sem_sinal_4_vagas():
    assert P.vagas_efetivas({}, AGORA) == 4
    assert P.vagas_efetivas(None, AGORA) == 4


def test_sinal_corta_pela_metade_ate_1():
    doc, antes, depois = P.reduzir({}, AGORA, P.MOTIVO_VAZIAS)
    assert (antes, depois) == (4, 2)
    doc, antes, depois = P.reduzir(doc, AGORA + timedelta(minutes=5), P.MOTIVO_CONSENTIMENTO)
    assert (antes, depois) == (2, 1)
    doc, antes, depois = P.reduzir(doc, AGORA + timedelta(minutes=10), P.MOTIVO_VAZIAS)
    assert (antes, depois) == (1, 1)
    assert set(doc) == {"vagas_base", "ultimo_sinal_em", "motivo"}  # só números, data e motivo


def test_volta_uma_vaga_a_cada_2h_sem_sinal():
    doc = {"vagas_base": 1, "ultimo_sinal_em": AGORA}
    assert P.vagas_efetivas(doc, AGORA + timedelta(hours=1, minutes=59)) == 1
    assert P.vagas_efetivas(doc, AGORA + timedelta(hours=2)) == 2
    assert P.vagas_efetivas(doc, AGORA + timedelta(hours=5)) == 3
    assert P.vagas_efetivas(doc, AGORA + timedelta(hours=30)) == 4


def test_novo_sinal_parte_das_vagas_efetivas():
    doc = {"vagas_base": 1, "ultimo_sinal_em": AGORA}
    # 4 h depois já estava em 3; o sinal corta para 1 (metade de 3, arredondada para baixo)
    _, antes, depois = P.reduzir(doc, AGORA + timedelta(hours=4), P.MOTIVO_VAZIAS)
    assert (antes, depois) == (3, 1)


def test_estado_inteiro_no_maximo_2_vagas():
    assert P.vagas_rn(4) == 2
    assert P.vagas_rn(2) == 2
    assert P.vagas_rn(1) == 1


def test_sinal_de_bloqueio():
    assert P.sinal_de_bloqueio(True, 0, 3) == P.MOTIVO_CONSENTIMENTO
    assert P.sinal_de_bloqueio(False, 3, 3) == P.MOTIVO_VAZIAS
    assert P.sinal_de_bloqueio(False, 2, 3) is None
