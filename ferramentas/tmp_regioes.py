# TEMPORÁRIO: baixa do IBGE (API oficial de localidades) a microrregião e a região
# geográfica imediata de cada município do RN e imprime no log. Removido antes do merge.
import gzip, json, urllib.request

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mapaleads"})
    with urllib.request.urlopen(req, timeout=120) as r:
        dados = r.read()
    if dados[:2] == b"\x1f\x8b":
        dados = gzip.decompress(dados)
    return json.loads(dados.decode("utf-8"))

muns = get("https://servicodados.ibge.gov.br/api/v1/localidades/estados/24/municipios")
saida = []
for m in muns:
    micro = m.get("microrregiao") or {}
    imed = m.get("regiao-imediata") or {}
    saida.append({"c": str(m["id"]), "mi": str(micro.get("id")), "mn": micro.get("nome"),
                  "ii": str(imed.get("id")), "in": imed.get("nome")})
print("===REGIOES===")
print(json.dumps(saida, ensure_ascii=False, separators=(",", ":")))
print("===FIM===")
