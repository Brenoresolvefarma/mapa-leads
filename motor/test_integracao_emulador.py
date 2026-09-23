"""Teste de integração do motor contra o EMULADOR do Firestore (scraper falso, dados fictícios).

Roda só quando FIRESTORE_EMULATOR_HOST está definido:
    npx firebase emulators:exec --only firestore --project demo-mapaleads "cd motor && pytest -q test_integracao_emulador.py"
"""

import os
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.skipif(not os.environ.get("FIRESTORE_EMULATOR_HOST"), reason="precisa do emulador do Firestore")

import fila  # noqa: E402
import motor  # noqa: E402
import tratamento  # noqa: E402


@pytest.fixture
def db(monkeypatch):
    from google.cloud import firestore as gcf
    import requests

    projeto = "demo-mapaleads"
    host = os.environ["FIRESTORE_EMULATOR_HOST"]
    requests.delete(f"http://{host}/emulator/v1/projects/{projeto}/databases/(default)/documents", timeout=10)
    cliente = gcf.Client(project=projeto)

    # Sem pausas reais nem disparo de workflow nos testes.
    monkeypatch.setattr(tratamento, "PAUSA_ENTRE_CONSULTAS_SEG", (0, 0))
    monkeypatch.setattr(fila, "disparar_nova_execucao", lambda log: True)
    monkeypatch.setattr(motor.Motor, "eh_admin", lambda self, uid: uid == "breno")
    return cliente


def lugar(n, cidade="Natal", estado="RN"):
    return {"title": f"Lugar {n}", "place_id": f"P{n}", "phone": f"(84) 99999-{n:04d}",
            "complete_address": {"city": cidade, "state": estado}}


def instalar_scraper_falso(monkeypatch, respostas, ao_rodar=None):
    """respostas: função (consulta) -> lista de lugares."""
    chamadas = []

    def falso(consulta, extrair_email, pasta, limite_seg, nome_arquivo):
        chamadas.append(consulta["texto"])
        if ao_rodar:
            ao_rodar(consulta)
        return respostas(consulta), "fim_real", 0, 30

    monkeypatch.setattr(motor, "rodar_consulta", falso)
    return chamadas


def criar(db, id_, dados):
    db.collection("buscas").document(id_).set(dados)
    return db.collection("buscas").document(id_)


def comum(dono, termos, cidades, minuto=0, **extra):
    base = {"tipo": "comum", "lista": True, "dono_uid": dono, "status": "na_fila",
            "criada_em": datetime(2026, 9, 23, 12, minuto, tzinfo=timezone.utc),
            "parametros": {"termos": termos, "cidades": cidades, "profundidade": "rapida", "extrair_email": False}}
    base.update(extra)
    return base


def mae_e_filhas(db, lotes, dono="breno"):
    criar(db, "M", {"tipo": "rn_mae", "lista": True, "dono_uid": dono, "status": "na_fila",
                    "criada_em": datetime(2026, 9, 23, 11, 0, tzinfo=timezone.utc),
                    "parametros": {"termos": ["dentista"], "extrair_email": False},
                    "total_consultas": sum(len(l) for l in lotes), "consultas_feitas": 0,
                    "filhas_total": len(lotes), "vazias_seguidas": 0})
    for i, cidades in enumerate(lotes):
        consultas = [{"id": f"c{i}{j}", "termo": "dentista", "cidade": c, "texto": f"dentista {c} RN",
                      "profundidade": "rapida", "criterio": "uf"} for j, c in enumerate(cidades)]
        criar(db, f"F{i}", {"tipo": "rn_filha", "mae_id": "M", "dono_uid": dono, "status": "na_fila",
                            "criada_em": datetime(2026, 9, 23, 11, 0, tzinfo=timezone.utc), "ordem": i,
                            "parametros": {"termos": ["dentista"], "extrair_email": False},
                            "consultas": consultas})


def ler(db, id_):
    return db.collection("buscas").document(id_).get().to_dict()


def leads_de(db, id_):
    dados = ler(db, id_)
    leads = []
    for i in range(dados.get("qtd_lotes") or 0):
        leads.extend(db.collection("buscas").document(id_).collection("lotes").document(str(i)).get().to_dict()["leads"])
    return leads


def test_fluxo_completo_prioridade_rn_e_consolidacao(db, monkeypatch):
    mae_e_filhas(db, [["Caicó", "Assú"], ["Natal", "Caicó"]])
    criar(db, "C1", comum("ana", ["home care"], ["Natal RN", "Parnamirim RN"]))

    def respostas(consulta):
        if consulta["texto"].startswith("home care"):
            return [lugar(1), lugar(2, cidade="Parnamirim")]
        # O mesmo lugar P10 aparece em Caicó nos dois lotes (duplicado entre filhas).
        return [lugar(10, "Caicó"), lugar(len(consulta["texto"]), "Assú"), lugar(99, "Cajazeiras", "PB")]

    chamadas = instalar_scraper_falso(monkeypatch, respostas)
    motor.Motor(db).rodar()

    # Busca comum passou na frente do RN.
    assert chamadas[:2] == ["home care Natal RN", "home care Parnamirim RN"]
    c1 = ler(db, "C1")
    assert c1["status"] == "concluida" and c1["resumo"]["total"] == 2
    assert c1["resumo"]["na_cidade_buscada"] == 2
    assert {l["cidade_confere"] for l in leads_de(db, "C1")} == {"sim"}

    # Lotes e mãe.
    assert ler(db, "F0")["status"] == "concluida" and ler(db, "F1")["status"] == "concluida"
    mae = ler(db, "M")
    assert mae["status"] == "concluida"
    assert mae["consultas_feitas"] == 4
    leads_mae = leads_de(db, "M")
    ids = [l["id_lugar"] for l in leads_mae]
    assert len(ids) == len(set(ids))  # sem duplicados em todo o RN
    assert ids.count("P10") == 1
    fora = [l for l in leads_mae if l["id_lugar"] == "P99"][0]
    assert fora["cidade_confere"] == "nao"  # Paraíba: marcado, não apagado

    # Estado público da fila e métricas.
    estado = db.collection("fila").document("estado").get().to_dict()
    assert estado["itens"] == [] and estado["rodando"] == []
    metricas = db.collection("config").document("metricas").get().to_dict()
    assert metricas["rapida_sem_email"]["n"] == 6


def test_preempcao_busca_comum_entra_no_meio_do_rn(db, monkeypatch):
    mae_e_filhas(db, [["Caicó", "Assú", "Apodi"]])
    ordem = []

    def ao_rodar(consulta):
        ordem.append(consulta["texto"])
        if consulta["texto"] == "dentista Caicó RN":
            # Enquanto o RN roda, alguém dispara uma busca comum.
            criar(db, "C9", comum("bia", ["pet shop"], ["Natal RN"], minuto=30))

    instalar_scraper_falso(monkeypatch, lambda c: [lugar(len(c["texto"]))], ao_rodar)
    motor.Motor(db).rodar()
    assert ordem == ["dentista Caicó RN", "pet shop Natal RN", "dentista Assú RN", "dentista Apodi RN"]
    assert ler(db, "C9")["status"] == "concluida"
    assert ler(db, "M")["status"] == "concluida"


def test_disjuntor_pausa_rn_e_devolve_consultas_para_a_fila(db, monkeypatch):
    mae_e_filhas(db, [["A", "B", "C", "D", "E"], ["F"]])
    instalar_scraper_falso(monkeypatch, lambda c: [])  # Google devolvendo nada
    motor.Motor(db).rodar()

    f0 = ler(db, "F0")
    assert f0["status"] == "concluida" and f0["consultas_feitas"] == 3
    mae = ler(db, "M")
    assert mae["status"] == "rodando" and mae["pausada_ate"] > datetime.now(timezone.utc)
    from google.cloud.firestore_v1.base_query import FieldFilter
    restantes = [d.to_dict() for d in db.collection("buscas")
                 .where(filter=FieldFilter("mae_id", "==", "M"))
                 .where(filter=FieldFilter("status", "==", "na_fila")).stream()]
    textos = sorted(c["texto"] for r in restantes for c in r["consultas"])
    assert textos == ["dentista D RN", "dentista E RN", "dentista F RN"]
    assert all(r["pausada_ate"] > datetime.now(timezone.utc) for r in restantes)
    assert mae["filhas_total"] == 3


def test_rn_de_quem_nao_e_admin_e_recusado(db, monkeypatch):
    mae_e_filhas(db, [["Caicó"]], dono="ana")
    chamadas = instalar_scraper_falso(monkeypatch, lambda c: [lugar(1)])
    motor.Motor(db).rodar()
    assert chamadas == []
    assert ler(db, "F0")["status"] == "erro"
    assert ler(db, "M")["status"] in ("cancelada", "erro")


def test_cancelamento_durante_a_busca_guarda_parcial(db, monkeypatch):
    ref = criar(db, "C1", comum("ana", ["a", "b", "c"], ["Natal RN"]))

    def ao_rodar(consulta):
        if consulta["texto"] == "a Natal RN":
            ref.update({"cancelar_solicitado": True})

    instalar_scraper_falso(monkeypatch, lambda c: [lugar(len(c["texto"]) + ord(c["texto"][0]))], ao_rodar)
    motor.Motor(db).rodar()
    c1 = ler(db, "C1")
    assert c1["status"] == "cancelada" and c1["consultas_feitas"] == 1 and c1["resumo"]["total"] == 1


def test_orfas_sem_paralelo(db, monkeypatch):
    criar(db, "C1", comum("ana", ["x"], ["Natal RN"], status="rodando"))
    mae_e_filhas(db, [["Caicó"]])
    db.collection("buscas").document("F0").update({"status": "rodando"})
    instalar_scraper_falso(monkeypatch, lambda c: [lugar(1)])
    motor.Motor(db).rodar()
    assert ler(db, "C1")["status"] == "erro"
    # Lote órfão ganha 1 nova tentativa e termina.
    assert ler(db, "F0")["status"] == "concluida" and ler(db, "F0")["tentativas"] == 1


def test_agendada_nao_roda_antes_da_hora(db, monkeypatch):
    mae_e_filhas(db, [["Caicó"]])
    db.collection("buscas").document("F0").update({"agendada_para": datetime.now(timezone.utc) + timedelta(hours=3)})
    chamadas = instalar_scraper_falso(monkeypatch, lambda c: [lugar(1)])
    motor.Motor(db).rodar()
    assert chamadas == []
    estado = db.collection("fila").document("estado").get().to_dict()
    assert estado["aguardando"] == [{"id": "F0", "tipo": "rn_filha", "mae_id": "M"}]
