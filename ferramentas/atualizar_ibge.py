# Coleta os indicadores OFICIAIS do IBGE por município do RN e grava dados/ibge_rn_indicadores.json.
# Roda no GitHub Actions (workflow "Atualizar indicadores do IBGE"); o proxy do ambiente de dev bloqueia o IBGE.
# Só dados públicos do IBGE — nada de leads. Valores sigilosos/ausentes do IBGE ("X", "-", "...") viram null.
import gzip, json, urllib.request
from datetime import date

API = "https://servicodados.ibge.gov.br/api/v3/agregados"
UF = 24  # RN

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mapaleads"})
    with urllib.request.urlopen(req, timeout=180) as r:
        dados = r.read()
    if dados[:2] == b"\x1f\x8b":
        dados = gzip.decompress(dados)
    return json.loads(dados.decode("utf-8"))

def numero(txt):
    try:
        return float(str(txt).replace(",", "."))
    except (TypeError, ValueError):
        return None  # "X" (sigilo), "-" (zero ou não se aplica), "..." (não disponível)

def serie(tabela, periodo, variaveis):
    """{variavel: {codigo_municipio: valor}}"""
    url = f"{API}/{tabela}/periodos/{periodo}/variaveis/{'|'.join(map(str, variaveis))}?localidades=N6[N3[{UF}]]"
    saida = {}
    for v in get(url):
        valores = {}
        for res in v["resultados"]:
            for s in res["series"]:
                valores[s["localidade"]["id"]] = numero(s["serie"].get(str(periodo)))
        saida[int(v["id"])] = valores
    return saida

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

dados = {}
for chave, f in FONTES.items():
    dados[chave] = serie(f["tabela"], f["ano"], [f["variavel"]])[f["variavel"]]
codigos = sorted(dados["populacao"])
municipios = {}
for c in codigos:
    m = {k: dados[k].get(c) for k in FONTES}
    # PIB per capita CALCULADO (decisão do Breno, opção b): PIB 2022 ÷ população do Censo 2022.
    m["pib_per_capita"] = round(m["pib_mil_reais"] * 1000 / m["populacao"], 2) if m["pib_mil_reais"] and m["populacao"] else None
    municipios[c] = m

FONTES["pib_per_capita"] = {"ano": 2022, "nome": "PIB per capita (R$) — calculado", "pesquisa": "PIB dos Municípios ÷ Censo 2022",
                            "calculo": "PIB a preços correntes 2022 (SIDRA 5938, v37) × 1000 ÷ população residente 2022 (SIDRA 4714, v93)"}
saida = {
    "fonte": "IBGE — API de Agregados (SIDRA) v3. Valores ausentes ou sigilosos no IBGE ficam null.",
    "coletado_em": date.today().isoformat(),
    "indicadores": FONTES,
    "municipios": municipios,
}
with open("dados/ibge_rn_indicadores.json", "w", encoding="utf-8") as f:
    json.dump(saida, f, ensure_ascii=False, indent=1)
    f.write("\n")
nulos = {k: sum(1 for m in municipios.values() if m[k] is None) for k in list(FONTES)}
print(f"municipios={len(municipios)} nulos={nulos}")
