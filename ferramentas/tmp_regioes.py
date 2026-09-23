# TEMPORÁRIO: baixa do IBGE (API oficial de localidades) a microrregião e a região
# geográfica imediata de cada município do RN e grava dados/microrregioes_rn.json.
# Removido antes do merge.
import gzip, json, urllib.request

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mapaleads"})
    with urllib.request.urlopen(req, timeout=120) as r:
        dados = r.read()
    if dados[:2] == b"\x1f\x8b":
        dados = gzip.decompress(dados)
    return json.loads(dados.decode("utf-8"))

muns = get("https://servicodados.ibge.gov.br/api/v1/localidades/estados/24/municipios")
micros, imeds = {}, {}
for m in muns:
    micro = m["microrregiao"]
    imed = m["regiao-imediata"]
    micros.setdefault(str(micro["id"]), {"id": str(micro["id"]), "nome": micro["nome"], "municipios": []})
    imeds.setdefault(str(imed["id"]), {"id": str(imed["id"]), "nome": imed["nome"], "municipios": []})
    micros[str(micro["id"])]["municipios"].append(str(m["id"]))
    imeds[str(imed["id"])]["municipios"].append(str(m["id"]))

def ordenar(d):
    lista = sorted(d.values(), key=lambda r: r["nome"])
    for r in lista:
        r["municipios"].sort()
    return lista

saida = {
    "fonte": "IBGE: API de Localidades (servicodados.ibge.gov.br/api/v1/localidades/estados/24/municipios), "
             "campos microrregiao e regiao-imediata. Coletado em 2026-09-23.",
    "microrregioes": ordenar(micros),
    "regioes_imediatas": ordenar(imeds),
}
with open("dados/microrregioes_rn.json", "w", encoding="utf-8") as f:
    json.dump(saida, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"municipios={len(muns)} microrregioes={len(micros)} regioes_imediatas={len(imeds)}")
