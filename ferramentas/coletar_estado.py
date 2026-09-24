# Coleta os dados OFICIAIS do IBGE de um estado (mesmas fontes do RN) e grava em dados/*_<uf>*.json:
#  - municipios_<uf>.json        API de Localidades + população do Censo 2022 (SIDRA 4714, v93)
#  - microrregioes_<uf>.json     API de Localidades (campos microrregiao e regiao-imediata)
#  - malha_<uf>_{municipio,microrregiao}_{minima,intermediaria}.geojson.json   API de Malhas v3
#  - ibge_<uf>_indicadores.json  SIDRA: 4714 (população, área, densidade), 5938 (PIB 2022), 9509 (CEMPRE 2024);
#                                PIB per capita CALCULADO = PIB ÷ população do Censo 2022 (como no RN)
#  - bairros_<uf>.json           malha de bairros do Censo 2022 (geoftp), só as cidades pedidas (nomes dos bairros)
# Roda no GitHub Actions (workflow "Coletar dados de um estado"); o proxy do ambiente de dev bloqueia o IBGE.
# Só dados públicos do IBGE. Valor ausente/sigiloso ("X", "-", "...") vira null — nunca estimado.
# Uso: UF=PB BAIRROS=2507507,2504009 python3 ferramentas/coletar_estado.py
import gzip, io, json, os, re, sys, urllib.request, zipfile
from datetime import date

SIGLAS = {"AL": 27, "BA": 29, "CE": 23, "MA": 21, "PB": 25, "PE": 26, "PI": 22, "RN": 24, "SE": 28}
UF = os.environ.get("UF", "PB").upper()
COD = SIGLAS[UF]
uf = UF.lower()
BAIRROS = [c for c in os.environ.get("BAIRROS", "").split(",") if c]
HOJE = date.today().isoformat()


def baixar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mapaleads", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=300) as r:
        dados = r.read()
    return gzip.decompress(dados) if dados[:2] == b"\x1f\x8b" else dados


def get(url):
    return json.loads(baixar(url).decode("utf-8"))


def gravar(nome, obj, indent=1):
    with open(f"dados/{nome}", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":"))
        f.write("\n")
    print(f"gravado dados/{nome}")


def numero(txt):
    try:
        return float(str(txt).replace(",", "."))
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ municípios e regiões (API de Localidades)
locs = get(f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{COD}/municipios")
print(f"API de Localidades: {len(locs)} municípios em {UF}")

micros, imediatas = {}, {}
for m in locs:
    mi = m["microrregiao"]
    micros.setdefault(str(mi["id"]), {"id": str(mi["id"]), "nome": mi["nome"], "municipios": []})["municipios"].append(str(m["id"]))
    im = m["regiao-imediata"]
    imediatas.setdefault(str(im["id"]), {"id": str(im["id"]), "nome": im["nome"], "municipios": []})["municipios"].append(str(m["id"]))
ordem = lambda d: sorted(d.values(), key=lambda r: r["nome"])
for r in list(micros.values()) + list(imediatas.values()):
    r["municipios"].sort()
gravar(f"microrregioes_{uf}.json", {
    "fonte": f"IBGE: API de Localidades (servicodados.ibge.gov.br/api/v1/localidades/estados/{COD}/municipios), campos microrregiao e regiao-imediata. Coletado em {HOJE}.",
    "microrregioes": ordem(micros), "regioes_imediatas": ordem(imediatas)}, indent=None)

# ------------------------------------------------------------------ indicadores (SIDRA)
API = "https://servicodados.ibge.gov.br/api/v3/agregados"


def serie(tabela, periodo, variavel):
    url = f"{API}/{tabela}/periodos/{periodo}/variaveis/{variavel}?localidades=N6[N3[{COD}]]"
    valores = {}
    for v in get(url):
        for res in v["resultados"]:
            for s in res["series"]:
                valores[s["localidade"]["id"]] = numero(s["serie"].get(str(periodo)))
    return valores


FONTES = {
    "populacao": {"tabela": 4714, "variavel": 93, "ano": 2022, "nome": "População residente", "pesquisa": "Censo Demográfico 2022"},
    "area_km2": {"tabela": 4714, "variavel": 6318, "ano": 2022, "nome": "Área da unidade territorial (km²)", "pesquisa": "Censo Demográfico 2022"},
    "densidade": {"tabela": 4714, "variavel": 614, "ano": 2022, "nome": "Densidade demográfica (hab/km²)", "pesquisa": "Censo Demográfico 2022"},
    "pib_mil_reais": {"tabela": 5938, "variavel": 37, "ano": 2022, "nome": "PIB a preços correntes (mil R$)", "pesquisa": "PIB dos Municípios"},
    "unidades_locais": {"tabela": 9509, "variavel": 706, "ano": 2024, "nome": "Número de unidades locais", "pesquisa": "CEMPRE"},
    "empresas": {"tabela": 9509, "variavel": 367, "ano": 2024, "nome": "Empresas e outras organizações atuantes", "pesquisa": "CEMPRE"},
    "pessoal_ocupado": {"tabela": 9509, "variavel": 707, "ano": 2024, "nome": "Pessoal ocupado total", "pesquisa": "CEMPRE"},
    "salario_medio_sm": {"tabela": 9509, "variavel": 1606, "ano": 2024, "nome": "Salário médio mensal (salários mínimos)", "pesquisa": "CEMPRE"},
}
dados = {k: serie(f["tabela"], f["ano"], f["variavel"]) for k, f in FONTES.items()}
codigos = sorted(str(m["id"]) for m in locs)
municipios = {}
for c in codigos:
    m = {k: dados[k].get(c) for k in FONTES}
    m["pib_per_capita"] = round(m["pib_mil_reais"] * 1000 / m["populacao"], 2) if m["pib_mil_reais"] and m["populacao"] else None
    municipios[c] = m
FONTES["pib_per_capita"] = {"ano": 2022, "nome": "PIB per capita (R$) — calculado", "pesquisa": "PIB dos Municípios ÷ Censo 2022",
                            "calculo": "PIB a preços correntes 2022 (SIDRA 5938, v37) × 1000 ÷ população residente 2022 (SIDRA 4714, v93)"}
gravar(f"ibge_{uf}_indicadores.json", {
    "fonte": "IBGE — API de Agregados (SIDRA) v3. Valores ausentes ou sigilosos no IBGE ficam null.",
    "coletado_em": HOJE, "indicadores": FONTES, "municipios": municipios})
nulos = {k: sum(1 for m in municipios.values() if m[k] is None) for k in FONTES}
print(f"indicadores: municipios={len(municipios)} nulos={nulos}")

nomes = {str(m["id"]): m["nome"] for m in locs}
lista = [{"codigo_ibge": c, "nome": nomes[c], "populacao_2022": int(municipios[c]["populacao"]) if municipios[c]["populacao"] is not None else None}
         for c in sorted(codigos, key=lambda c: nomes[c])]
gravar(f"municipios_{uf}.json", {
    "fonte": f"IBGE: API de Localidades (municípios do {UF}, UF {COD}) e SIDRA tabela 4714, variável 93 (população residente, Censo Demográfico 2022). Coletado em {HOJE}.",
    "total_api_localidades": len(locs),
    "municipios": lista}, indent=None)

# ------------------------------------------------------------------ malhas (API de Malhas v3), coordenadas com 4 casas
def arredondar(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 4), round(coords[1], 4)]
    return [arredondar(c) for c in coords]


for nivel in ["municipio", "microrregiao"]:
    for qualidade in ["minima", "intermediaria"]:
        g = get(f"https://servicodados.ibge.gov.br/api/v3/malhas/estados/{COD}?formato=application/vnd.geo%2Bjson&qualidade={qualidade}&intrarregiao={nivel}")
        feats = [{"type": "Feature", "geometry": {"type": f["geometry"]["type"], "coordinates": arredondar(f["geometry"]["coordinates"])},
                  "properties": {"codarea": str(f["properties"]["codarea"])}} for f in g["features"]]
        gravar(f"malha_{uf}_{nivel}_{qualidade}.geojson.json", {"type": "FeatureCollection", "features": feats}, indent=None)
        print(f"malha {nivel}/{qualidade}: {len(feats)} áreas")

# ------------------------------------------------------------------ bairros (malha de bairros do Censo 2022, geoftp)
def ler_dbf(dados):
    """Lê um .dbf (dBase III) sem biblioteca: devolve lista de dicts."""
    n = int.from_bytes(dados[4:8], "little"); cab = int.from_bytes(dados[8:10], "little"); tam = int.from_bytes(dados[10:12], "little")
    campos, pos = [], 32
    while dados[pos] != 0x0D:
        nome = dados[pos:pos + 11].split(b"\0")[0].decode("latin-1"); largura = dados[pos + 16]
        campos.append((nome, largura)); pos += 32
    linhas = []
    for i in range(n):
        reg = dados[cab + i * tam: cab + (i + 1) * tam]
        if reg[:1] == b"*":
            continue
        p, linha = 1, {}
        for nome, largura in campos:
            bruto = reg[p:p + largura]; p += largura
            try:
                linha[nome] = bruto.decode("utf-8").strip()
            except UnicodeDecodeError:
                linha[nome] = bruto.decode("latin-1").strip()
        linhas.append(linha)
    return linhas


if BAIRROS:
    BASE = "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/UF/"
    arquivo = f"{UF}_bairros_CD2022.zip"
    try:
        z = zipfile.ZipFile(io.BytesIO(baixar(BASE + arquivo)))
    except Exception as e:  # mostra o que existe na pasta para achar o nome certo
        print(f"falhou {BASE + arquivo}: {e}")
        try:
            print(re.findall(r'href="([^"]+)"', baixar(BASE).decode("latin-1")))
        except Exception as e2:
            print(f"listagem falhou: {e2}")
        sys.exit(1)
    dbf = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
    linhas = ler_dbf(z.read(dbf))
    print(f"bairros: {len(linhas)} linhas; campos {list(linhas[0])}")
    cidades = []
    for cod in BAIRROS:
        bs = sorted({l["NM_BAIRRO"] for l in linhas if l.get("CD_MUN") == cod and l.get("NM_BAIRRO")})
        cidades.append({"codigo_ibge": cod, "nome": nomes[cod], "bairros": bs})
        print(f"bairros {nomes[cod]}: {len(bs)}")
    gravar(f"bairros_{uf}.json", {
        "fonte": f"IBGE: malha de bairros do Censo Demográfico 2022 ({UF}_bairros_CD2022, geoftp.ibge.gov.br). Coletado em {HOJE}.",
        "cidades": cidades})

# Conferência: todos os arquivos com o mesmo número de municípios da API de Localidades
assert len(municipios) == len(locs) == len(lista), "contagem de municípios diferente"
print(f"OK {UF}: {len(locs)} municípios, {len(micros)} microrregiões, {len(imediatas)} regiões imediatas")
