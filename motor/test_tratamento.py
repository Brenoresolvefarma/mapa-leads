"""Testes do tratamento de dados. Usam SOMENTE dados fictícios."""

import json

import tratamento as t


# ---------------------------------------------------------------- listas

def test_dividir_lista_remove_vazios_espacos_e_repetidos():
    assert t.dividir_lista(" home care, cuidador , ,Home Care,  clínica   geral ") == [
        "home care", "cuidador", "clínica geral",
    ]


def test_dividir_lista_vazia():
    assert t.dividir_lista("") == []
    assert t.dividir_lista(None) == []


def test_gerar_consultas_termo_x_cidade():
    consultas = t.gerar_consultas(["dentista", "odontologia"], ["Natal RN", "Mossoró RN"])
    assert [c["texto"] for c in consultas] == [
        "dentista Natal RN", "dentista Mossoró RN",
        "odontologia Natal RN", "odontologia Mossoró RN",
    ]
    assert [c["id"] for c in consultas] == ["q0", "q1", "q2", "q3"]


# -------------------------------------------------------------- telefone

def test_celular_com_ddd_gera_whatsapp():
    assert t.normalizar_telefone("(84) 99876-5432") == (
        "(84) 99876-5432", "https://wa.me/5584998765432",
    )


def test_celular_com_codigo_do_pais():
    assert t.normalizar_telefone("+55 84 99876-5432") == (
        "(84) 99876-5432", "https://wa.me/5584998765432",
    )


def test_celular_com_zero_de_discagem():
    assert t.normalizar_telefone("084 99876 5432")[1] == "https://wa.me/5584998765432"


def test_fixo_sem_whatsapp():
    assert t.normalizar_telefone("84 3201-1234") == ("(84) 3201-1234", "")


def test_numero_antigo_de_celular_nao_ganha_nono_digito():
    # 10 dígitos começando com 8: não inventamos o 9 na frente.
    assert t.normalizar_telefone("(84) 8876-5432") == ("(84) 8876-5432", "")


def test_numeros_especiais_ficam_como_vieram():
    assert t.normalizar_telefone("0800 123 4567") == ("0800 123 4567", "")
    assert t.normalizar_telefone("4004-1234") == ("4004-1234", "")


def test_formato_desconhecido_fica_como_veio():
    assert t.normalizar_telefone("+1 415 555 0100") == ("+1 415 555 0100", "")


def test_telefone_vazio():
    assert t.normalizar_telefone("") == ("", "")
    assert t.normalizar_telefone(None) == ("", "")


# ------------------------------------------------------------- instagram

def test_instagram_so_quando_o_site_e_instagram():
    assert t.extrair_instagram("https://www.instagram.com/exemplo_ficticio/") == (
        "https://www.instagram.com/exemplo_ficticio/"
    )
    assert t.extrair_instagram("instagram.com/exemplo") == "https://instagram.com/exemplo"
    assert t.extrair_instagram("https://exemplo.com.br") == ""
    assert t.extrair_instagram("https://instagram.com.golpe.com/x") == ""
    assert t.extrair_instagram("") == ""


# ---------------------------------------------------------- montar lead

def entrada_ficticia(**extra):
    base = {
        "title": "Clínica Fictícia",
        "category": "Dentista",
        "phone": "(84) 99999-0000",
        "web_site": "https://ficticia.example",
        "address": "Rua Exemplo, 100 - Natal, RN",
        "complete_address": {"city": "Natal"},
        "review_rating": 4.7,
        "review_count": 32,
        "link": "https://www.google.com/maps/place/ficticia",
        "place_id": "ChIJficticio1",
        "emails": ["contato@ficticia.example"],
    }
    base.update(extra)
    return base


def test_montar_lead_campos_completos():
    lead = t.montar_lead(entrada_ficticia(), "dentista")
    assert lead == {
        "nome": "Clínica Fictícia",
        "categoria": "Dentista",
        "telefone": "(84) 99999-0000",
        "whatsapp_link": "https://wa.me/5584999990000",
        "email": "contato@ficticia.example",
        "site": "https://ficticia.example",
        "instagram": "",
        "endereco": "Rua Exemplo, 100 - Natal, RN",
        "cidade": "Natal",
        "nota": 4.7,
        "qtd_avaliacoes": 32,
        "link_maps": "https://www.google.com/maps/place/ficticia",
        "termo_que_encontrou": "dentista",
    }


def test_campos_ausentes_ficam_vazios_sem_inventar():
    lead = t.montar_lead({"title": "Só Nome"}, "home care")
    assert lead["nome"] == "Só Nome"
    for campo in ("categoria", "telefone", "whatsapp_link", "email", "site",
                  "instagram", "endereco", "cidade", "link_maps"):
        assert lead[campo] == "", campo
    assert lead["nota"] is None
    assert lead["qtd_avaliacoes"] is None


def test_nota_zero_vira_vazio():
    lead = t.montar_lead(entrada_ficticia(review_rating=0, review_count=0), "x")
    assert lead["nota"] is None
    assert lead["qtd_avaliacoes"] == 0


def test_categoria_usa_lista_quando_principal_ausente():
    lead = t.montar_lead(entrada_ficticia(category="", categories=["Home care", "Saúde"]), "x")
    assert lead["categoria"] == "Home care"


def test_emails_repetidos_sao_juntados_uma_vez():
    lead = t.montar_lead(entrada_ficticia(emails=["a@x.example", "A@x.example", "b@x.example"]), "x")
    assert lead["email"] == "a@x.example, b@x.example"


# ----------------------------------------------------------- duplicados

def test_remove_duplicados_por_id_do_lugar_e_junta_termos():
    itens = [
        (entrada_ficticia(), "dentista"),
        (entrada_ficticia(title="Clínica Fictícia (outro nome)"), "odontologia"),
        (entrada_ficticia(), "dentista"),
    ]
    leads = t.tratar_resultados(itens)
    assert len(leads) == 1
    assert leads[0]["termo_que_encontrou"] == "dentista, odontologia"


def test_sem_id_usa_nome_mais_telefone():
    sem_id = dict(place_id="", cid="")
    itens = [
        (entrada_ficticia(**sem_id), "a"),
        (entrada_ficticia(**sem_id, phone="+55 84 99999-0000"), "b"),  # mesmo número
        (entrada_ficticia(**sem_id, phone="(84) 98888-1111"), "a"),    # outro número
    ]
    assert len(t.tratar_resultados(itens)) == 2


def test_cid_como_alternativa_ao_place_id():
    itens = [
        (entrada_ficticia(place_id="", cid="123"), "a"),
        (entrada_ficticia(place_id="", cid="123", title="Outro"), "b"),
    ]
    assert len(t.tratar_resultados(itens)) == 1


def test_itens_sem_nome_sao_descartados():
    assert t.tratar_resultados([({"title": ""}, "a"), ({}, "b")]) == []


# ------------------------------------------------------- resumo e lotes

def test_resumo():
    leads = t.tratar_resultados([
        (entrada_ficticia(), "a"),
        (entrada_ficticia(place_id="p2", phone="84 3201-1234", emails=[], web_site=""), "a"),
        (entrada_ficticia(place_id="p3", phone=""), "a"),
    ])
    assert t.calcular_resumo(leads) == {
        "total": 3, "com_telefone": 2, "com_email": 2, "com_site": 2, "com_whatsapp": 1,
    }


def test_lotes_de_300():
    leads = [{"n": i} for i in range(650)]
    lotes = t.dividir_em_lotes(leads)
    assert [len(l) for l in lotes] == [300, 300, 50]
    assert t.dividir_em_lotes([]) == []


def test_lote_cabe_no_limite_do_firestore():
    # Um lote cheio com campos longos precisa ficar bem abaixo de 1 MiB.
    lead = t.montar_lead(entrada_ficticia(
        title="N" * 120, address="E" * 200, web_site="https://" + "s" * 150,
        link="https://www.google.com/maps/place/" + "l" * 300,
    ), "termo " * 10)
    tamanho = len(json.dumps([lead] * t.LEADS_POR_LOTE).encode("utf-8"))
    assert tamanho < 700_000


# ---------------------------------------------- leitura da saída do scraper

def test_ler_resultados_json_por_linha(tmp_path):
    motor = __import__("motor")
    arquivo = tmp_path / "q0.json"
    arquivo.write_text('{"title": "A"}\n\nlinha quebrada\n{"title": "B"}\n', encoding="utf-8")
    assert [i["title"] for i in motor.ler_resultados(str(arquivo))] == ["A", "B"]


def test_ler_resultados_lista_json_e_arquivo_ausente(tmp_path):
    motor = __import__("motor")
    arquivo = tmp_path / "q1.json"
    arquivo.write_text('[{"title": "A"}]', encoding="utf-8")
    assert len(motor.ler_resultados(str(arquivo))) == 1
    assert motor.ler_resultados(str(tmp_path / "nao_existe.json")) == []
