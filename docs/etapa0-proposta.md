# Fase 3a v2 · Etapa 0 — proposta para aprovação

Protótipo no ar (deploy preview do PR 10): **https://deploy-preview-10--mapaleads-rn.netlify.app/prototipo.html**
— entre com o seu login; ele mostra os seus dados reais (só leitura). A tela em uso não muda.

## 1. Proposta visual

**Referência:** painéis de inteligência comercial B2B — fundo claro, muito espaço em branco, títulos fortes,
números grandes, mapa como protagonista.

| Item | Proposta |
|---|---|
| Fonte | **Inter** (Google Fonts) 400/500/600/700/800. Títulos 800 com espaçamento apertado; números da tabela com algarismos alinhados (tabular) |
| Cor da marca | Azul `#1f5fd6` (botões, item ativo, gráficos) — contraste AA com texto branco |
| Neutros (claro) | fundo `#f6f7f9`, cartões `#ffffff`, texto `#0e1726`, texto secundário `#475467`, apoio `#667085`, linhas `#e4e7ec` |
| Neutros (escuro) | fundo `#0a0f1c`, cartões `#111827`, texto `#f2f4f7`, secundário `#c3cad6`, linhas `#232e45` |
| Estados | sucesso `#067647`, atenção `#b54708`, erro `#b42318` — sempre com texto/ícone, nunca só cor |
| WhatsApp | verde `#0e8a45` (botão com ícone) |
| Mapas | rampa **sequencial azul** de 7 tons (claro = menos, escuro = mais); no tema escuro a rampa inverte (claro = mais) |
| Tema | automático (segue o aparelho) + escolha manual no menu do usuário |
| Grade | menu lateral 252 px + conteúdo até 1320 px; espaçamentos 4/8/12/16/20/24/32; cantos 8/12/16 px |
| Responsivo | 1440 · 768 · 390 · 360 px; no celular: barra inferior com 5 atalhos, tabela vira cartões, gaveta de filtros |
| Toque | botões e campos com no mínimo **44 px**; foco visível (contorno azul de 3 px) |

**Componentes:** cartão de número (KPI) com ícone (i) de ajuda · barra de cota · selo de status do motor
(bolinha verde/amarela/vermelha + texto) · linha do tempo da busca (Na fila → Rodando x/y → Concluída) ·
chips de filtros com "limpar tudo" · tabela com cabeçalho fixo / cartões no celular · ficha em painel lateral ·
estado vazio que ensina · esqueleto de carregamento · aviso (toast) · confirmação antes de apagar/cancelar.

**Assinatura:** "Desenvolvido por **Resolve Farma**" no login, no rodapé (desktop), no fim do menu (celular),
na tela Sobre, no último passo do tour e no rodapé da aba "Resumo" do .xlsx (não no .csv). Texto, empresa,
logo e locais ficam numa constante única (`ASSINATURA`) no topo do código.

## 2. Mapa do site

| Tela | O que tem |
|---|---|
| **Login** | marca, frase, mapa do RN, formulário, crédito Resolve Farma |
| **Início** | KPIs (leads totais, da semana, % WhatsApp, buscas ativas, cota); leads por dia (30 dias); últimas buscas com linha do tempo; atalhos Nova busca / Ver mapa |
| **Nova busca** | assistente 3 passos — **O quê** (termos em chips, sinônimos sugeridos editáveis, perfis salvos) · **Onde** (mapa do RN clicável por microrregião/município **ou** lista Estado → Microrregião → Cidade com busca, "selecionar todas", contador e população de cada cidade) · **Como** (profundidade explicada, e-mail, resumo: nº de consultas, tempo estimado, quanto gasta da cota) |
| **Meus leads** | barra de filtros fixa + gaveta de filtros avançados, chips, contagem ao vivo; tabela com ordenação, colunas escolhíveis, seleção múltipla; ficha lateral com mini-mapa, WhatsApp/ligar/Google Maps/copiar; visões salvas; exportar .xlsx (com aba Resumo) / .csv |
| **Mapa** | Leaflet: pontos agrupados (cor por segmento), camada por município (nº de leads, leads/10 mil hab., % WhatsApp), contornos de microrregião, legenda, filtros sincronizados com Meus leads; no celular, mapa em tela cheia + lista deslizante |
| **Mercado (IBGE)** | indicadores oficiais por município/microrregião (lista abaixo), cruzamento com os leads (leads por 10 mil hab., "muita população e poucos leads"), ranking ordenável, gráficos (barras por microrregião, dispersão população × leads) |
| **Admin** | usuários (criar, limite, remover), uso por vendedor (buscas e leads da semana), fila ao vivo, saúde do motor (execuções, disjuntor), Estado inteiro, estados ativos |
| **Sobre** (menu do usuário) | o que é, fontes (Google Maps + IBGE), versão, Resolve Farma |
| **Tour** (1º acesso) | 4 passos: o que é · como buscar · como ler os leads · como exportar (+ crédito), com "não mostrar de novo" |

## 3. Indicadores do IBGE (conferidos na API oficial em 23/09/2026)

| Indicador | Fonte exata | Ano | Obs. |
|---|---|---|---|
| População residente | Censo Demográfico — **SIDRA 4714**, variável **93** | 2022 | já usada (mesmo valor da t4709) |
| Área territorial (km²) | Censo 2022 — **SIDRA 4714**, variável **6318** | 2022 | Natal: 167,401 km² |
| Densidade demográfica (hab/km²) | Censo 2022 — **SIDRA 4714**, variável **614** | 2022 | Natal: 4.488,03 |
| PIB a preços correntes (mil R$) | PIB dos Municípios — **SIDRA 5938**, variável **37** | **2023** (mais recente) | Natal: R$ 31,16 bi |
| **PIB per capita** | **não existe pronto na tabela 5938** | — | **precisa da sua decisão** (ver abaixo) |
| Nº de unidades locais | CEMPRE — **SIDRA 9509**, variável **706** | **2024** (mais recente) | total por município |
| Nº de empresas e outras organizações atuantes | CEMPRE — **SIDRA 9509**, variável **367** | 2024 | |
| Pessoal ocupado total | CEMPRE — **SIDRA 9509**, variável **707** | 2024 | |
| Salário médio mensal (salários mínimos) | CEMPRE — **SIDRA 9509**, variável **1606** | 2024 | |
| Unidades locais **por atividade** | CEMPRE — **SIDRA 9510**, variável **706**, classificação **12762 (CNAE 2.0: seções e divisões)** | 2024 | o IBGE oculta ("X") valores sigilosos em municípios pequenos → mostramos "não divulgado" |
| Contornos | IBGE — API de Malhas Territoriais v3 (municípios e microrregiões do RN) | malha vigente, coletada em 23/09/2026 | já salvos em `dados/` |
| Microrregiões / regiões imediatas | IBGE — API de Localidades | vigente | já em uso |

**PIB per capita — escolha uma:**
- (a) **PIB 2023 ÷ população estimada 2023** (IBGE, estimativas de população — a conferir a tabela/ano na coleta) —
  é o método que o próprio IBGE usa; na tela aparece "calculado a partir de ...".
- (b) **PIB 2022 ÷ população do Censo 2022** — mesmo ano, fonte censitária; também "calculado".
- (c) **Não mostrar** PIB per capita, só o PIB total.

Todos os números ficam em `dados/ibge_rn_indicadores.json` com a data da coleta, atualizados por workflow manual.
Na tela, cada indicador mostra fonte e ano.

## 4. Preview do link (WhatsApp, Instagram, LinkedIn, Facebook, Telegram)

- **Título:** `MapaLeads – Prospecção B2B inteligente no RN`
- **Descrição:** `Encontre empresas por cidade, microrregião e segmento, com WhatsApp, mapa e dados do IBGE. Desenvolvido por Resolve Farma.`
- **Imagem:** `publico/og-image.png` (1200 × 630, ~130 KB), gerada de `ferramentas/marca/og-image.html` — o mapa é a
  população real por município (IBGE, Censo 2022). Para mudar: editar o HTML e rodar `node ferramentas/gerar_imagens.mjs`;
  se a imagem mudar depois de publicada, trocar o nome (ex.: `og-image-v2.png`) por causa do cache do WhatsApp.
- **Ícones:** `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180), `icone-192.png`, `icone-512.png`; `manifest.json`
  (nome, ícones, cores `#1f5fd6` / `#0b1b3a`) para "instalar" no celular.
- Tags (entram no `<head>` do `index.html` estático, sem JavaScript, depois da sua aprovação):

```html
<title>MapaLeads – Prospecção B2B inteligente no RN</title>
<meta name="description" content="Encontre empresas por cidade, microrregião e segmento, com WhatsApp, mapa e dados do IBGE. Desenvolvido por Resolve Farma.">
<meta name="theme-color" content="#1f5fd6">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MapaLeads">
<meta property="og:locale" content="pt_BR">
<meta property="og:url" content="https://mapaleads-rn.netlify.app/">
<meta property="og:title" content="MapaLeads – Prospecção B2B inteligente no RN">
<meta property="og:description" content="Encontre empresas por cidade, microrregião e segmento, com WhatsApp, mapa e dados do IBGE. Desenvolvido por Resolve Farma.">
<meta property="og:image" content="https://mapaleads-rn.netlify.app/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="MapaLeads – Prospecção B2B inteligente no RN">
<meta name="twitter:description" content="Encontre empresas por cidade, microrregião e segmento, com WhatsApp, mapa e dados do IBGE. Desenvolvido por Resolve Farma.">
<meta name="twitter:image" content="https://mapaleads-rn.netlify.app/og-image.png">
```

- **Teste:** um workflow confere, no site publicado, as tags, a imagem (1200 × 630, ≤ 300 KB) e o acesso sem login.
  O **Facebook Sharing Debugger** exige login no Facebook e o **WhatsApp** exige um celular — esses dois ficam com você
  (o print entra no PR).

## 5. Entrega por etapas (um PR cada)
0 proposta (este) → 1 estrutura e navegação (+ preview do link) → 2 autoexplicativo (tour, ajudas, estados vazios) →
3 Nova busca → 4 Meus leads → 5 Mapa → 6 Mercado → 7 Início → 8 Admin.
Merge de cada uma: CI verde + teste real em produção + **sua aprovação das capturas**.
