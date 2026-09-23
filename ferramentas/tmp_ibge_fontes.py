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
for t in (4709, 4714):
    r = meta(t)
    if r:
        m, per = r
        for v in m["variaveis"][:4]:
            amostra(t, v["id"], per[-1])

print("===== PIB DOS MUNICIPIOS =====")
r = meta(5938)
if r:
    m, per = r
    for v in m["variaveis"]:
        if "per capita" in v["nome"].lower() or v["id"] == 37:
            amostra(5938, v["id"], per[-1])

print("===== CEMPRE (busca por nome) =====")
lista = get(API)
candidatas = []
for pesq in lista:
    for ag in pesq.get("agregados", []):
        nome = ag["nome"]
        if "unidades locais" in nome.lower() or "Cadastro Central" in pesq.get("nome", ""):
            candidatas.append((ag["id"], nome, pesq.get("nome")))
for i, n, p in candidatas[:40]:
    print(f"   cand {i}: {n} | {p}")
for i, n, p in candidatas[:40]:
    r = meta(i)
    if r and "N6" in r[0].get("nivelTerritorial", {}).get("Administrativo", []):
        print(f"   -> {i} tem município (N6)")

print("===== MALHAS =====")
M = "https://servicodados.ibge.gov.br/api/v3/malhas/estados/24"
try:
    print("metadados:", json.dumps(get(f"{M}/metadados"), ensure_ascii=False)[:800])
except Exception as e:
    print("metadados ERRO", e)
salvar = {}
for intra in ("municipio", "microrregiao", "regiao-imediata"):
    for qual in ("minima", "intermediaria"):
        url = f"{M}?formato=application/vnd.geo+json&intrarregiao={intra}&qualidade={qual}"
        try:
            b = get(url, bruto=True)
            g = json.loads(b)
            print(f"malha {intra} {qual}: {len(b)} bytes, {len(g.get('features', []))} feicoes, props exemplo {g['features'][0].get('properties')}")
            salvar[(intra, qual)] = g
        except Exception as e:
            print(f"malha {intra} {qual}: ERRO {e}")
for (intra, qual), g in salvar.items():
    if qual == "intermediaria" or intra != "municipio":
        pass
    nome = f"dados/malha_rn_{intra.replace('-', '_')}_{qual}.geojson.json"
    with open(nome, "w", encoding="utf-8") as f:
        json.dump(g, f, ensure_ascii=False, separators=(",", ":"))
print("===FIM===")
