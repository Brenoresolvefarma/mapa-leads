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


# -------------------------------------- disjuntor x porte da cidade (24/09)

def test_cidade_pequena_vazia_nao_conta_nem_zera():
    pequena = {"cidade": "Viçosa", "texto": "x Viçosa RN"}          # 1.822 hab.
    assert fila.vazia_conta_para_disjuntor(pequena, falhou=False) is False
    assert fila.aplicar_disjuntor(2, False, 3, vazia_conta=False) == (2, False)


def test_vazia_conta_se_falhou_ou_cidade_grande_ou_bairro():
    assert fila.vazia_conta_para_disjuntor({"cidade": "Viçosa"}, falhou=True) is True
    assert fila.vazia_conta_para_disjuntor({"cidade": "Caicó"}, falhou=False) is True  # 61 mil
    assert fila.vazia_conta_para_disjuntor({"cidade": "Natal", "bairro": "Tirol"}, falhou=False) is True
    assert fila.vazia_conta_para_disjuntor({"cidade": "Cidade Inventada"}, falhou=False) is True


def test_populacao_pelo_nome_sem_acento():
    assert fila.populacao_da_cidade("Natal") == 751300
    assert fila.populacao_da_cidade("mossoro") == 264577
    assert fila.populacao_da_cidade("Assú") == fila.populacao_da_cidade("Açu")


def test_dia_fortaleza():
    from datetime import datetime, timezone
    assert fila.dia_fortaleza(datetime(2026, 9, 24, 2, 59, tzinfo=timezone.utc)) == "2026-09-23"
    assert fila.dia_fortaleza(datetime(2026, 9, 24, 3, 0, tzinfo=timezone.utc)) == "2026-09-24"


def parte(id_, dono, minuto, ordem, **extra):
    base = {"id": id_, "tipo": "parte", "mae_id": f"M{dono}", "dono_uid": dono, "status": "na_fila",
            "criada_em": em(minuto), "ordem": ordem, "parametros": {"extrair_email": False},
            "consultas": [{"termo": "x", "cidade": f"C{ordem}", "profundidade": "rapida"}]}
    base.update(extra)
    return base


def test_busca_dividida_nao_roda_direto_so_as_partes():
    mae = comum("M", "ana", -5, partes_total=2)
    assert not fila.elegivel(mae, AGORA) and fila.eh_mae(mae)
    assert ids(fila.ordenar_fila([mae, parte("P0", "ana", -5, 0), parte("P1", "ana", -5, 1)], AGORA)) == ["P0", "P1"]


def test_partes_de_vendedores_diferentes_andam_juntas():
    # Ana dividiu em 4 partes; Bia chegou depois com 2: com 4 vagas, as duas andam ao mesmo tempo.
    buscas = [parte(f"A{i}", "ana", -10, i) for i in range(4)] + [parte(f"B{i}", "bia", -2, i) for i in range(2)]
    assert ids(fila.ordenar_fila(buscas, AGORA))[:4] == ["A0", "B0", "A1", "B1"]


def test_parte_pausada_so_depois_do_horario():
    p = parte("P", "ana", -5, 0, pausada_ate=em(10))
    assert not fila.elegivel(p, AGORA)
    assert fila.elegivel(p, em(11))


def test_parte_orfa_pelo_prazo_da_cidade():
    p = parte("P", "ana", -5, 0, parametros={"extrair_email": False, "termos": ["a", "b"]},
              consultas=[{"termo": "a", "cidade": "X", "profundidade": "rapida"},
                         {"termo": "b", "cidade": "X", "profundidade": "rapida"}])
    # 2 termos × (6 min + 1 min) + 10 min = 24 min
    assert fila.orfa_apos_seg(p) == 2 * (6 * 60 + 60) + 600
    assert fila.orfa_apos_seg(comum("C", "ana", 0)) == fila.ORFA_APOS_SEG


def test_estado_da_fila_nao_mostra_a_mae_comum_rodando():
    mae = comum("M", "ana", -5, partes_total=2, status="rodando")
    p = parte("P0", "ana", -5, 0, status="rodando")
    estado = fila.montar_estado_fila([mae, p, parte("P1", "ana", -5, 1)], AGORA)
    assert [r["id"] for r in estado["rodando"]] == ["P0"]
    assert [i["id"] for i in estado["itens"]] == ["P1"]
    assert estado["itens"][0]["mae_id"] == "Mana"


def test_no_maximo_2_maquinas_por_vendedor_com_outro_esperando():
    rodando = [parte("A0", "ana", -10, 0, status="rodando"), parte("A1", "ana", -10, 1, status="rodando")]
    fila_ = [parte("A2", "ana", -10, 2), parte("B0", "bia", -2, 0)]
    # Ana já usa 2 máquinas e a Bia está esperando: a próxima vaga vai para a Bia
    assert ids(fila.limitar_por_vendedor(fila_, rodando)) == ["B0"]
    # Sem ninguém esperando, a Ana usa as máquinas livres
    assert ids(fila.limitar_por_vendedor([parte("A2", "ana", -10, 2)], rodando)) == ["A2"]
    # Admin não tem o limite
    assert ids(fila.limitar_por_vendedor(fila_, rodando, isento=lambda uid: uid == "ana")) == ["A2", "B0"]
    # Com 1 máquina só, a Ana continua na vez
    assert ids(fila.limitar_por_vendedor(fila_, rodando[:1])) == ["A2", "B0"]
    # Lotes do Estado inteiro não entram nessa conta
    assert ids(fila.limitar_por_vendedor([filha("F1", -60)], rodando)) == ["F1"]
