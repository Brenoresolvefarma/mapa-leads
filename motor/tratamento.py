"""
Tratamento dos dados do MapaLeads.

Funções puras (sem rede, sem banco) que transformam a saída do scraper
em leads limpos. Ficam separadas para poderem ser testadas com pytest.

Regra de ouro: nunca inventar ou completar dados.
Campo que o scraper não trouxe fica vazio ("" ou None).
"""

import re
from urllib.parse import urlparse

# Quantos leads cabem em cada documento-lote do Firestore.
# 300 leads ficam bem abaixo do limite de 1 MiB por documento
# e fazem uma busca inteira custar poucas leituras/gravações.
LEADS_POR_LOTE = 300

# Profundidade escolhida na tela -> parâmetro -depth do scraper.
PROFUNDIDADES = {
    "rapida": 1,     # ~20 lugares por consulta
    "normal": 5,     # ~60 lugares por consulta
    "completa": 10,  # até ~120 lugares (teto do Google)
}


def dividir_lista(texto):
    """Transforma "home care, cuidador , ,home care" em ["home care", "cuidador"].

    Remove espaços extras, itens vazios e repetidos (mantendo a ordem).
    """
    if not texto:
        return []
    itens = []
    vistos = set()
    for parte in str(texto).split(","):
        item = " ".join(parte.split())  # tira espaços duplicados
        chave = item.lower()
        if item and chave not in vistos:
            vistos.add(chave)
            itens.append(item)
    return itens


def gerar_consultas(termos, cidades):
    """Gera a lista de consultas termo × cidade.

    Cada consulta tem um id curto (q0, q1...) usado no arquivo de entrada
    do scraper, para sabermos qual termo encontrou cada lugar.
    """
    consultas = []
    for termo in termos:
        for cidade in cidades:
            consultas.append({
                "id": f"q{len(consultas)}",
                "termo": termo,
                "cidade": cidade,
                "texto": f"{termo} {cidade}",
            })
    return consultas


def _so_digitos(texto):
    return re.sub(r"\D", "", texto or "")


def normalizar_telefone(bruto):
    """Formata um telefone brasileiro e diz se tem link de WhatsApp.

    Retorna (telefone_formatado, whatsapp_link).
      - Celular (DDD + 9 dígitos começando com 9): "(84) 99999-9999" + link wa.me
      - Fixo (DDD + 8 dígitos): "(84) 3333-3333", sem WhatsApp
      - Qualquer outro formato: devolve como veio, sem WhatsApp
    Nunca acrescenta dígitos (ex.: não coloca o 9 na frente de número antigo).
    """
    original = (bruto or "").strip()
    if not original:
        return "", ""

    digitos = _so_digitos(original)

    # Números especiais (0800, 0300, 4004...) ficam como vieram.
    if digitos.startswith(("0800", "0300", "0500", "0900")) or len(digitos) == 8:
        return original, ""

    # Remove o código do país (+55) quando presente.
    if digitos.startswith("55") and len(digitos) in (12, 13):
        digitos = digitos[2:]
    # Remove zero de discagem interurbana (ex.: 084...).
    if digitos.startswith("0") and len(digitos) in (11, 12):
        digitos = digitos[1:]

    ddd = digitos[:2]
    if len(digitos) == 11 and digitos[2] == "9" and ddd[0] != "0":
        formatado = f"({ddd}) {digitos[2:7]}-{digitos[7:]}"
        return formatado, f"https://wa.me/55{digitos}"
    if len(digitos) == 10 and ddd[0] != "0":
        formatado = f"({ddd}) {digitos[2:6]}-{digitos[6:]}"
        return formatado, ""

    return original, ""


def extrair_instagram(site):
    """Se o site cadastrado no Maps for um perfil do Instagram, devolve o link.

    O scraper não traz Instagram de outra forma, então nada é deduzido.
    """
    site = (site or "").strip()
    if not site:
        return ""
    endereco = site if "://" in site else f"https://{site}"
    try:
        host = (urlparse(endereco).hostname or "").lower()
    except ValueError:
        return ""
    if host == "instagram.com" or host.endswith(".instagram.com"):
        return endereco
    return ""


def _juntar_emails(emails):
    """Junta a lista de e-mails em texto único, sem repetidos."""
    vistos = []
    for email in emails or []:
        email = (email or "").strip()
        if email and email.lower() not in [v.lower() for v in vistos]:
            vistos.append(email)
    return ", ".join(vistos)


def chave_do_lugar(entrada):
    """Chave para remover duplicados.

    Usa o ID do lugar no Google (place_id, ou cid como alternativa).
    Na falta dos dois, usa nome + telefone normalizados.
    """
    place_id = (entrada.get("place_id") or "").strip()
    if place_id:
        return f"pid:{place_id}"
    cid = str(entrada.get("cid") or "").strip()
    if cid:
        return f"cid:{cid}"
    nome = " ".join((entrada.get("title") or "").lower().split())
    # Telefone já normalizado, para "+55 84 9..." e "(84) 9..." baterem.
    telefone, _ = normalizar_telefone(entrada.get("phone"))
    return f"nt:{nome}|{_so_digitos(telefone)}"


def montar_lead(entrada, termo):
    """Converte um item da saída JSON do scraper no formato de lead do MapaLeads."""
    telefone, whatsapp = normalizar_telefone(entrada.get("phone"))
    site = (entrada.get("web_site") or "").strip()

    categoria = (entrada.get("category") or "").strip()
    if not categoria and entrada.get("categories"):
        categoria = (entrada["categories"][0] or "").strip()

    endereco_completo = entrada.get("complete_address") or {}

    qtd = entrada.get("review_count")
    qtd = qtd if isinstance(qtd, int) and qtd >= 0 else None
    nota = entrada.get("review_rating")
    # Nota 0 significa "sem nota" no scraper: fica vazia.
    nota = nota if isinstance(nota, (int, float)) and nota > 0 else None

    return {
        "nome": (entrada.get("title") or "").strip(),
        "categoria": categoria,
        "telefone": telefone,
        "whatsapp_link": whatsapp,
        "email": _juntar_emails(entrada.get("emails")),
        "site": site,
        "instagram": extrair_instagram(site),
        "endereco": (entrada.get("address") or "").strip(),
        "cidade": (endereco_completo.get("city") or "").strip(),
        "nota": nota,
        "qtd_avaliacoes": qtd,
        "link_maps": (entrada.get("link") or "").strip(),
        "termo_que_encontrou": termo,
    }


def tratar_resultados(itens):
    """Recebe [(entrada_do_scraper, termo), ...] e devolve a lista de leads sem duplicados.

    Se o mesmo lugar aparecer em mais de um termo, os termos são juntados
    em "termo_que_encontrou" (ex.: "home care, cuidador").
    Itens sem nome são descartados (não são lugares válidos).
    """
    por_chave = {}
    for entrada, termo in itens:
        if not (entrada.get("title") or "").strip():
            continue
        chave = chave_do_lugar(entrada)
        if chave not in por_chave:
            por_chave[chave] = montar_lead(entrada, termo)
            continue
        lead = por_chave[chave]
        termos = [t.strip() for t in lead["termo_que_encontrou"].split(",")]
        if termo not in termos:
            lead["termo_que_encontrou"] = f"{lead['termo_que_encontrou']}, {termo}"
        # Se a primeira ocorrência veio sem e-mail e esta trouxe, aproveita.
        if not lead["email"]:
            lead["email"] = _juntar_emails(entrada.get("emails"))
    return list(por_chave.values())


def calcular_resumo(leads):
    """Contagens exibidas na tela ao final da busca."""
    return {
        "total": len(leads),
        "com_telefone": sum(1 for l in leads if l["telefone"]),
        "com_email": sum(1 for l in leads if l["email"]),
        "com_site": sum(1 for l in leads if l["site"]),
        "com_whatsapp": sum(1 for l in leads if l["whatsapp_link"]),
    }


def dividir_em_lotes(leads, tamanho=LEADS_POR_LOTE):
    """Divide a lista de leads em lotes para gravar no Firestore."""
    return [leads[i:i + tamanho] for i in range(0, len(leads), tamanho)]
