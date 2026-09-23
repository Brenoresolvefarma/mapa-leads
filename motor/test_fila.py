"""Testes da fila (prioridade, rodízio por dono, agendamento, pausa, disjuntor). Sem Firestore."""

from datetime import datetime, timedelta, timezone

import fila

AGORA = datetime(2026, 9, 23, 15, 0, tzinfo=timezone.utc)


def em(minutos):
    return AGORA + timedelta(minutes=minutos)


def comum(id_, dono, minuto, **extra):
    base = {"id": id_, "tipo": "comum", "dono_uid": dono, "status": "na_fila", "criada_em": em(minuto),
            "parametros": {"termos": ["x"], "cidades": ["Natal RN"], "profundidade": "rapida"}}
    base.update(extra)
    return base


def filha(id_, minuto, ordem=0, **extra):
    base = {"id": id_, "tipo": "rn_filha", "mae_id": "M", "dono_uid": "admin", "status": "na_fila",
            "criada_em": em(minuto), "ordem": ordem, "parametros": {"extrair_email": False},
            "consultas": [{"profundidade": "rapida"}, {"profundidade": "normal"}]}
    base.update(extra)
    return base


def ids(lista):
    return [b["id"] for b in lista]


def test_buscas_comuns_passam_na_frente_do_rn():
    buscas = [filha("F1", -60, 0), comum("C1", "ana", -1), filha("F2", -60, 1)]
    assert ids(fila.ordenar_fila(buscas, AGORA)) == ["C1", "F1", "F2"]


def test_rodizio_entre_donos():
    buscas = [
        comum("A1", "ana", -10), comum("A2", "ana", -9), comum("A3", "ana", -8),
        comum("B1", "bia", -5), comum("C1", "caio", -1),
    ]
    assert ids(fila.ordenar_fila(buscas, AGORA)) == ["A1", "B1", "C1", "A2", "A3"]


def test_mae_nunca_entra_na_fila_de_execucao():
    mae = {"id": "M", "tipo": "rn_mae", "status": "na_fila", "criada_em": em(-60)}
    assert fila.ordenar_fila([mae], AGORA) == []


def test_agendada_e_pausada_so_depois_do_horario():
    buscas = [filha("F1", -60, agendada_para=em(30)), filha("F2", -60, 1, pausada_ate=em(10)), comum("C1", "ana", -1)]
    assert ids(fila.ordenar_fila(buscas, AGORA)) == ["C1"]
    assert ids(fila.ordenar_fila(buscas, em(31))) == ["C1", "F1", "F2"]


def test_so_status_na_fila():
    buscas = [comum("C1", "ana", -1, status="rodando"), comum("C2", "ana", -2, status="concluida")]
    assert fila.ordenar_fila(buscas, AGORA) == []


def test_estado_da_fila_sem_dados_pessoais():
    buscas = [
        comum("C1", "ana", -1),
        filha("F1", -60),
        filha("F9", -60, agendada_para=em(60)),
        comum("R1", "bia", -30, status="rodando", iniciada_em=em(-1)),
    ]
    estado = fila.montar_estado_fila(buscas, AGORA)
    assert [i["id"] for i in estado["itens"]] == ["C1", "F1"]
    assert estado["itens"][0] == {"id": "C1", "tipo": "comum", "estimativa_seg": 40}
    # rápida (40) + normal (110) + 1 pausa (30)
    assert estado["itens"][1] == {"id": "F1", "tipo": "rn_filha", "estimativa_seg": 180, "mae_id": "M"}
    assert estado["rodando"] == [{"id": "R1", "restante_seg": 30}]
    assert estado["aguardando"] == [{"id": "F9", "tipo": "rn_filha", "mae_id": "M"}]
    texto = str(estado)
    for proibido in ("ana", "bia", "Natal", "termos", "dono"):
        assert proibido not in texto


def test_consultas_da_busca_comum_e_filha():
    c = comum("C1", "ana", 0, parametros={"termos": ["a", "b"], "cidades": ["Natal RN"], "profundidade": "completa"})
    assert [x["texto"] for x in fila.consultas_da_busca(c)] == ["a Natal RN", "b Natal RN"]
    assert fila.consultas_da_busca(filha("F", 0)) == [{"profundidade": "rapida"}, {"profundidade": "normal"}]


def test_disjuntor_tres_vazias_seguidas():
    vazias, disparou = 0, False
    for teve in (False, False):
        vazias, disparou = fila.aplicar_disjuntor(vazias, teve)
    assert (vazias, disparou) == (2, False)
    assert fila.aplicar_disjuntor(vazias, True) == (0, False)  # lead zera a contagem
    for _ in range(3):
        vazias, disparou = fila.aplicar_disjuntor(vazias, False)
    assert disparou
