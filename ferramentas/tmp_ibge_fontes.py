# TEMPORÁRIO (removido antes do merge): confere no IBGE as fontes dos indicadores propostos
# (metadados SIDRA e malhas) e grava a malha oficial do RN em dados/. Só dados públicos do IBGE.
import gzip, json, urllib.request

def get(url, bruto=False):
    req = urllib.request.Request(url, headers={"User-Agent": "mapaleads"})
    with urllib.request.urlopen(req, timeout=180) as r:
        dados = r.read()
    if dados[:2] == b"\x1f\x8b":
        dados = gzip.decompress(dados)
    return dados if bruto else json.loads(dados.decode("utf-8"))

API = "https://servicodados.ibge.gov.br/api/v3/agregados"

def meta(tabela):
    try:
        m = get(f"{API}/{tabela}/metadados")
    except Exception as e:
        print(f"## {tabela}: ERRO {e}"); return None
    per = get(f"{API}/{tabela}/periodos")
    niveis = m.get("nivelTerritorial", {}).get("Administrativo", [])
    print(f"## {tabela}: {m.get('nome')} | pesquisa: {m.get('pesquisa')} | periodicidade: {m.get('periodicidade')}")
    print(f"   niveis: {niveis} | periodos: {[p['id'] for p in per][-6:]} (total {len(per)})")
    for v in m.get("variaveis", []):
        print(f"   var {v['id']}: {v['nome']} [{v.get('unidade')}]")
    for c in m.get("classificacoes", []):
        print(f"   classif {c['id']}: {c['nome']} ({len(c.get('categorias', []))} categorias)")
    return m, [p["id"] for p in per]

def amostra(tabela, variavel, periodo, classif=""):
    url = f"{API}/{tabela}/periodos/{periodo}/variaveis/{variavel}?localidades=N6[2408102]{classif}"
    try:
        r = get(url)
        for v in r:
            for res in v["resultados"]:
                cls = [list(c["categoria"].values())[0] for c in res.get("classificacoes", [])]
                for s in res["series"]:
                    print(f"   amostra Natal t{tabela} v{variavel} {periodo} {cls}: {s['serie']}")
    except Exception as e:
        print(f"   amostra t{tabela} v{variavel}: ERRO {e}")

print("===== CENSO 2022 =====")
for t in (4714,):
    r = meta(t)
    if r:
        m, per = r
        for v in m["variaveis"]:
            amostra(t, v["id"], per[-1])

print("===== PIB DOS MUNICIPIOS =====")
r = meta(5938)
if r:
    m, per = r
    for v in m["variaveis"]:
        if "per capita" in v["nome"].lower() or v["id"] == 37:
            amostra(5938, v["id"], per[-1])

print("===== CEMPRE COM MUNICIPIO (N6) =====")
lista = get(API)
for pesq in lista:
    if "Cadastro Central" not in pesq.get("nome", ""):
        continue
    for ag in pesq.get("agregados", []):
        try:
            m = get(f"{API}/{ag['id']}/metadados")
        except Exception:
            continue
        if "N6" not in m.get("nivelTerritorial", {}).get("Administrativo", []):
            continue
        per = [p["id"] for p in get(f"{API}/{ag['id']}/periodos")]
        cls = [f"{c['id']}:{c['nome'][:40]}({len(c.get('categorias', []))})" for c in m.get("classificacoes", [])]
        vs = [f"{v['id']}:{v['nome'][:50]}" for v in m.get("variaveis", []) if not str(v['id']).startswith('100')]
        print(f"## {ag['id']}: {ag['nome'][:140]} | periodos {per[0]}..{per[-1]} | classif {cls}")
        print(f"   vars {vs[:8]}")
print("===FIM===")
