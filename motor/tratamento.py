"""
Tratamento dos dados do MapaLeads.

Funções puras (sem rede, sem banco) que transformam a saída do scraper
em leads limpos. Ficam separadas para poderem ser testadas com pytest.

Regra de ouro: nunca inventar ou completar dados.
Campo que o scraper não trouxe fica vazio ("" ou None).
"""

import re
import unicodedata
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

# Limite rígido de tempo por consulta (minutos), aprovado pelo Breno.
# Com extração de e-mail o limite dobra (o scraper visita o site de cada lugar).
LIMITE_CONSULTA_MIN = {
    "rapida": 6,
    "normal": 12,
    "completa": 20,
}
# Vigia (aprovado pelo Breno): encerra a consulta se não gravar nenhum lead
# nos primeiros 5 min, ou (plano B) se ficar sem atividade por 60 s sem e-mail
# / 3 min com e-mail. O "fim real" (scraper avisa que terminou) vem antes disso.
LIMITE_PRIMEIRO_LEAD_MIN = 5
SEM_ATIVIDADE_SEG = {False: 60, True: 180}

# Pausa aleatória entre consultas (segundos), para reduzir risco de bloqueio.
PAUSA_ENTRE_CONSULTAS_SEG = (20, 40)

# Tempo médio inicial por consulta (segundos), medido na execução real de
# 23/09/2026 (rápida: ~30 s + encerramento). O motor recalibra com dados reais.
MEDIA_INICIAL_CONSULTA_SEG = {"rapida": 40, "normal": 110, "completa": 180}
FATOR_EMAIL = 1.6


def sem_atividade_seg(extrair_email):
    """Janela do plano B da vigia, em segundos."""
    return SEM_ATIVIDADE_SEG[bool(extrair_email)]


def chave_metrica(profundidade, extrair_email):
    return f"{profundidade}_{'email' if extrair_email else 'sem_email'}"


def estimar_consulta_seg(profundidade, extrair_email, metricas=None):
    """Tempo estimado de UMA consulta (sem contar a pausa)."""
    media = ((metricas or {}).get(chave_metrica(profundidade, extrair_email)) or {}).get("media_seg")
    if media:
        return float(media)
    base = MEDIA_INICIAL_CONSULTA_SEG[profundidade]
    return base * (FATOR_EMAIL if extrair_email else 1)


def estimar_consultas_seg(consultas, extrair_email, metricas=None):
    """Tempo estimado de uma lista de consultas, incluindo as pausas."""
    pausa = sum(PAUSA_ENTRE_CONSULTAS_SEG) / 2
    total = sum(estimar_consulta_seg(c["profundidade"], extrair_email, metricas) for c in consultas)
    return int(total + pausa * max(len(consultas) - 1, 0))


def limite_consulta_seg(profundidade, extrair_email):
    """Limite rígido de uma consulta, em segundos."""
    minutos = LIMITE_CONSULTA_MIN[profundidade] * (2 if extrair_email else 1)
    return minutos * 60


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


def gerar_consultas(termos, cidades, profundidade="normal"):
    """Gera a lista de consultas termo × cidade de uma busca comum.

    Cada consulta tem um id curto (q0, q1...), a profundidade e o critério
    de conferência de cidade ("cidade": o lead deve estar na cidade pedida).
    """
    consultas = []
    for termo in termos:
        for cidade in cidades:
            consultas.append({
                "id": f"q{len(consultas)}",
                "termo": termo,
                "cidade": cidade,
                "texto": f"{termo} {cidade}",
                "profundidade": profundidade,
                "criterio": "cidade",
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


# Siglas de UF, para tirar o "RN" de "Natal RN" antes de comparar cidades.
UFS = {
    "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg", "pa",
    "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to",
}
# Nome do estado (como o Google escreve no endereço) → sigla. Só os do Nordeste (onde o MapaLeads busca).
NOMES_UF = {
    "rio grande do norte": "RN", "paraiba": "PB", "pernambuco": "PE", "ceara": "CE", "alagoas": "AL",
    "sergipe": "SE", "bahia": "BA", "piaui": "PI", "maranhao": "MA",
}
# Grafias alternativas conhecidas (IBGE x Google).
ALIASES_CIDADE = {"acu": "assu"}


def normalizar_nome(texto):
    """Minúsculas, sem acento, sem pontuação: "Ceará-Mirim" -> "ceara mirim"."""
    texto = unicodedata.normalize("NFKD", texto or "")
    texto = "".join(c for c in texto if not unicodedata.combining(c)).lower()
    texto = re.sub(r"[^a-z0-9]+", " ", texto).strip()
    return ALIASES_CIDADE.get(texto, texto)


def cidade_sem_uf(cidade):
    """ "Natal RN" / "Natal - RN" / "Natal/RN" -> "natal" (normalizado)."""
    partes = normalizar_nome(cidade).split()
    if len(partes) > 1 and partes[-1] in UFS:
        partes = partes[:-1]
    return ALIASES_CIDADE.get(" ".join(partes), " ".join(partes))


def uf_da_cidade(cidade):
    """ "Natal RN" -> "RN"; "João Pessoa PB" -> "PB"; sem sigla -> "". """
    partes = (cidade or "").strip().split()
    return partes[-1].upper() if len(partes) > 1 and partes[-1].lower() in UFS else ""


def uf_do_endereco(entrada):
    """Sigla do estado do endereço do Google ("PB", "Paraíba", "State of Paraíba"); "" se não der para saber."""
    estado = normalizar_nome((entrada.get("complete_address") or {}).get("state"))
    if estado:
        if estado in UFS:
            return estado.upper()
        for nome, sigla in NOMES_UF.items():
            if estado.endswith(nome):
                return sigla
    texto = entrada.get("address") or ""
    siglas = [x for x in re.findall(r"(?:^|[\s,/-])([A-Z]{2})(?=[\s,]|$)", texto) if x.lower() in UFS]
    return siglas[-1] if siglas else ""


def _como_consulta(consulta):
    """Aceita a consulta como dict ou só o termo (texto)."""
    if isinstance(consulta, dict):
        return consulta
    return {"termo": consulta, "cidade": "", "criterio": "cidade"}


def conferir_cidade(entrada, consulta):
    """Diz se o lugar está onde foi pedido: "sim", "nao" ou "indefinido".

    Nunca apaga nem corrige nada: só marca.
      - criterio "cidade" (busca comum): cidade do endereço == cidade pedida;
      - criterio "uf" (Estado inteiro): o endereço é do estado pedido (RN por padrão; PB desde 24/09);
      - com sigla na cidade pedida ("Santa Luzia PB"), o estado do endereço também precisa bater
        (nomes repetidos entre estados); sem estado no endereço, vale só a cidade.
    """
    consulta = _como_consulta(consulta)
    endereco = entrada.get("complete_address") or {}
    if consulta.get("criterio") == "uf":
        uf_lead = uf_do_endereco(entrada)
        if not uf_lead:
            return "indefinido"
        return "sim" if uf_lead == (consulta.get("uf") or "RN") else "nao"

    alvo = cidade_sem_uf(consulta.get("cidade"))
    cidade_lead = normalizar_nome(endereco.get("city"))
    if not alvo or not cidade_lead:
        return "indefinido"
    if cidade_lead != alvo:
        return "nao"
    uf_pedida, uf_lead = uf_da_cidade(consulta.get("cidade")), uf_do_endereco(entrada)
    return "nao" if uf_pedida and uf_lead and uf_pedida != uf_lead else "sim"


def id_do_lugar(entrada):
    """ID do lugar no Google (place_id, ou cid). Vazio se não houver."""
    place_id = (entrada.get("place_id") or "").strip()
    if place_id:
        return place_id
    cid = str(entrada.get("cid") or "").strip()
    return f"cid:{cid}" if cid else ""


def _coordenada(valor):
    """Número de latitude/longitude válido, ou None (0 ou vazio = sem coordenada)."""
    try:
        v = float(valor)
    except (TypeError, ValueError):
        return None
    return v if v and -180 <= v <= 180 else None


def montar_lead(entrada, consulta):
    """Converte um item da saída JSON do scraper no formato de lead do MapaLeads."""
    consulta = _como_consulta(consulta)
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
        # Todas as categorias do Google (a 1ª é a principal): usadas para marcar o segmento na tela.
        "categorias": [c.strip() for c in (entrada.get("categories") or []) if isinstance(c, str) and c.strip()][:10],
        "telefone": telefone,
        "whatsapp_link": whatsapp,
        "email": _juntar_emails(entrada.get("emails")),
        "site": site,
        "instagram": extrair_instagram(site),
        "endereco": (entrada.get("address") or "").strip(),
        "bairro": (endereco_completo.get("borough") or "").strip(),
        "cidade": (endereco_completo.get("city") or "").strip(),
        "nota": nota,
        "qtd_avaliacoes": qtd,
        "link_maps": (entrada.get("link") or "").strip(),
        # Coordenadas do Google (o scraper grava "longtitude", com erro de digitação): para o mapa.
        "latitude": _coordenada(entrada.get("latitude")),
        "longitude": _coordenada(entrada.get("longitude", entrada.get("longtitude"))),
        "termo_que_encontrou": consulta.get("termo") or "",
        # Campos da Fase 2:
        "cidade_buscada": consulta.get("cidade") or "",
        # Estado do lead (24/09, PB ativada): o do endereço; sem ele, o pedido na consulta.
        "uf": uf_do_endereco(entrada) or consulta.get("uf") or uf_da_cidade(consulta.get("cidade")) or "",
        "cidade_confere": conferir_cidade(entrada, consulta),
        "id_lugar": id_do_lugar(entrada),  # uso interno (duplicados); fora do .xlsx
    }


def _juntar_termo(lead, termo):
    termos = [t.strip() for t in lead["termo_que_encontrou"].split(",") if t.strip()]
    if termo and termo not in termos:
        lead["termo_que_encontrou"] = ", ".join(termos + [termo])


def tratar_resultados(itens):
    """Recebe [(entrada_do_scraper, consulta), ...] e devolve a lista de leads sem duplicados.

    "consulta" é o dict da consulta (termo, cidade, criterio) ou só o termo.
    Se o mesmo lugar aparecer em mais de um termo, os termos são juntados
    em "termo_que_encontrou" (ex.: "home care, cuidador").
    Itens sem nome são descartados (não são lugares válidos).
    """
    por_chave = {}
    for entrada, consulta in itens:
        consulta = _como_consulta(consulta)
        if not (entrada.get("title") or "").strip():
            continue
        chave = chave_do_lugar(entrada)
        if chave not in por_chave:
            por_chave[chave] = montar_lead(entrada, consulta)
            continue
        lead = por_chave[chave]
        _juntar_termo(lead, consulta.get("termo"))
        # Se a primeira ocorrência veio sem e-mail e esta trouxe, aproveita.
        if not lead["email"]:
            lead["email"] = _juntar_emails(entrada.get("emails"))
        # Se esta consulta confirma a cidade, vale a confirmação.
        if lead["cidade_confere"] != "sim" and conferir_cidade(entrada, consulta) == "sim":
            lead["cidade_confere"] = "sim"
            lead["cidade_buscada"] = consulta.get("cidade") or lead["cidade_buscada"]
    return list(por_chave.values())


def chave_do_lead(lead):
    """Chave de duplicado para leads já tratados (busca-mãe do RN inteiro)."""
    if lead.get("id_lugar"):
        return f"id:{lead['id_lugar']}"
    nome = " ".join((lead.get("nome") or "").lower().split())
    return f"nt:{nome}|{_so_digitos(lead.get('telefone'))}"


def deduplicar_leads(listas):
    """Junta várias listas de leads (uma por busca-filha) sem duplicados."""
    por_chave = {}
    for leads in listas:
        for lead in leads:
            chave = chave_do_lead(lead)
            if chave not in por_chave:
                por_chave[chave] = dict(lead)
                continue
            atual = por_chave[chave]
            for termo in (lead.get("termo_que_encontrou") or "").split(","):
                _juntar_termo(atual, termo.strip())
            if not atual.get("email") and lead.get("email"):
                atual["email"] = lead["email"]
            if atual.get("cidade_confere") != "sim" and lead.get("cidade_confere") == "sim":
                atual["cidade_confere"] = "sim"
    return list(por_chave.values())


def calcular_resumo(leads):
    """Contagens exibidas na tela ao final da busca."""
    return {
        "total": len(leads),
        "com_telefone": sum(1 for l in leads if l["telefone"]),
        "com_email": sum(1 for l in leads if l["email"]),
        "com_site": sum(1 for l in leads if l["site"]),
        "com_whatsapp": sum(1 for l in leads if l["whatsapp_link"]),
        "na_cidade_buscada": sum(1 for l in leads if l.get("cidade_confere") == "sim"),
    }


def dividir_em_lotes(leads, tamanho=LEADS_POR_LOTE):
    """Divide a lista de leads em lotes para gravar no Firestore."""
    return [leads[i:i + tamanho] for i in range(0, len(leads), tamanho)]
