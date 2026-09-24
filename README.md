# MapaLeads

Prospecção B2B multiusuário via Google Maps, 100% na nuvem, feito para caber nas **cotas gratuitas**
(GitHub Actions em repositório público + Firebase + Netlify **Free**). O Firebase está no plano **Blaze**
(com alerta de orçamento de R$ 20/mês): o código continua dentro da cota grátis, e qualquer custo acima
dela precisa de aprovação antes.

> **Estado atual: Fase 3a v2 no ar** (PR 12) + **celular primeiro** (PR 13): tela clara por padrão, menu fixo embaixo,
> cartões com WhatsApp/Ligar, ícones (i) que funcionam no toque, **apagar busca** (dono ou admin) e comemoração ao
> criar uma busca. **Motor em paralelo** (PR 14): até 4 máquinas ao mesmo tempo, leads cidade a cidade e aviso de
> cidades pequenas. Fases 3b e 3c estão no [CLAUDE.md](CLAUDE.md).

## Como funciona

```
Navegador (publico/index.html) ──login──> Firebase Auth
      │  (ID token)
      ▼
Netlify Functions (/api/...) ──valida token, papel/equipe, limites──> Firestore (buscas na fila)
      │  dispara
      ▼
GitHub Actions "Motor MapaLeads" ──esvazia a fila──> scraper (Docker) ──> Firestore (leads em lotes)
```

- **Busca comum** (qualquer usuário): termos e cidades livres, profundidade, e-mail sim/não.
  Conta no **limite diário** (padrão **20 por dia**, o admin muda por usuário; o dia vira à
  meia-noite de **Fortaleza/Natal**).
- **Limites do vendedor** (não valem para o admin; conferidos no servidor e mostrados na tela):
  - por busca: no máximo **40 cidades OU 120 consultas** (o que vier primeiro). Acima disso a Function
    `criar-busca` recusa com 400: "Busca grande demais para vendedor (X cidades / Y consultas). Máximo: 40 cidades ou
    120 consultas. Divida por região ou peça ao admin.";
  - por dia: no máximo **300 consultas** (além do nº de buscas), contadas em `usuarios/{uid}.consultas_dia` na mesma
    transação da busca; o admin muda por usuário (`limite_consultas_dia`, coluna "Consultas/dia" no Admin);
  - Nova busca: sem "Selecionar todas" no estado inteiro (continua valendo por região e com a procura filtrando),
    contador "X de 40 cidades" que fica vermelho ao passar e botão Buscar travado com o aviso;
  - máquinas: com **outro vendedor esperando** na fila, cada vendedor usa no máximo **2 das 4** ao mesmo tempo;
  - os números 40 / 120 / 300 ficam em **Admin › Configurações** (`config/geral`: `max_cidades_busca`,
    `max_consultas_busca`, `max_consultas_dia`).
- **Liberar busca para vendedor** (só admin, Function `/api/liberar-busca`): em Meus leads (lista de buscas) e em
  Admin › Buscas, "Liberar para vendedor" abre um painel:
  - vendedores (um ou mais);
  - "Lista inteira" ou "Só estas cidades/regiões" (por microrregião/região imediata e cidade a cidade, com contagem);
  - "Dividir entre os vendedores escolhidos": cada um recebe cidades diferentes (nenhum lead repetido); antes de
    confirmar aparece quantos leads cada um recebe.

  O vendedor vê a lista em Meus leads com a etiqueta **"Liberada por admin"** (filtros, WhatsApp/Ligar, mapa e
  exportação iguais), sem apagar nem liberar. O admin revoga pelo chip "Liberada para" (a lista some na hora).
  Não conta na cota do vendedor; o Início dele continua contando só as buscas dele. Log só com ids e números.
  - "Lista inteira": a busca e os lotes ganham `liberada_para` (uid).
  - Recorte (algumas cidades ou dividida): cópia só com os leads das cidades do vendedor em
    `buscas/{id}/liberacoes/{uid}/lotes/{n}` — a regra deixa cada um ler só o seu caminho.
- **Status de cada lead (mini-CRM)** — Function `/api/crm-lead`:
  - Novo › Contatado › Negociando › Cliente › Descartado (com motivo: sem interesse, fechou, número errado, outro),
    anotação e "Próximo contato em"; histórico na ficha ("23/09 · Flávio · Contatado · ligar sexta", 10 últimos).
  - No celular: botões grandes de status no cartão e na ficha (um toque); depois de tocar em WhatsApp ou Ligar,
    a tela pergunta **"Como foi?"** com os status em botões.
  - Meus leads: contador por status no topo (clicável = filtra) e a aba **"Para hoje"** (próximo contato hoje ou
    atrasado). Início do vendedor: cartão **"Para hoje: X contatos"**. O .xlsx ganhou Status, Próximo contato,
    Última anotação e Vendedor.
  - Cada vendedor vê e muda só os dele (`crm/{uid}__{fatia}`); o admin vê todos (sem mudar). Log sem dados de lead.
- **Carteira (sem conflito entre vendedores)**: o mesmo estabelecimento em buscas diferentes é reconhecido (place_id
  do Google; sem ele, telefone + nome). Marcou Contatado/Negociando/Cliente → o lead é **da carteira** do vendedor;
  para os outros aparece **"Na carteira de <nome>"**, sem WhatsApp/Ligar e fora do "Para hoje". Descartado ou sem
  contato há **60 dias** (ajustável em Admin › Configurações) volta a ficar livre. O admin transfere pela ficha e vê
  o painel **Carteiras** (leads por vendedor e status, conversão = Clientes ÷ Contatado+Negociando+Cliente).
  A liberação "Dividir entre os vendedores" já respeita a carteira (lead de alguém não vai para outro).
- **Estados ativos: RN e Paraíba (PB, ativada em 24/09)**. Nova busca, Mapa, Mercado e Admin › Estado inteiro têm o seletor de
  estado (um só, guardado no aparelho; trocar desmarca as cidades do outro estado, com aviso; no celular também no Mapa); as consultas da PB vão ao Google com "PB". Estado inteiro (admin): RN ou PB, com a estimativa
  (PB: 345 consultas por termo, ~9,8 h — mesmas faixas do RN; João Pessoa e Campina Grande por bairro). Limites do
  vendedor, aviso de cidades pequenas, liberação, carteira e status valem igual na PB. Os outros estados: "em breve".
- **RN inteiro** (**só admin**, bloqueado no servidor): um segmento nos 167 municípios do RN.
  Não conta no limite diário. Detalhes abaixo.
- **Fila sem perda e sem travar ninguém**: buscas comuns passam na frente dos lotes do RN
  (o motor olha a fila antes de cada consulta do RN); entre usuários comuns, a fila alterna
  por dono. A tela mostra a posição na fila e o tempo estimado de espera.
- **Motor em paralelo** (aprovado pelo Breno em 24/09), sem custo (Actions grátis em repo público):
  - cada disparo abre **4 vagas** (jobs da matrix do `motor.yml`, cada uma com o seu grupo de `concurrency`):
    **no máximo 4 máquinas ao mesmo tempo**, somando todas as buscas;
  - a busca comum com várias cidades **nasce dividida em até 4 partes por cidade** (Function `criar-busca`);
    cada vaga pega a próxima parte da fila (rodízio por vendedor), então **buscas de vendedores diferentes
    andam ao mesmo tempo**. Quem termina a última parte junta tudo **sem duplicar** (trava por transação);
  - **resultados parciais**: a cada cidade pronta, a parte grava os leads dela; a tela mostra
    "X de Y cidades prontas" e já deixa abrir esses leads (Início, Meus leads, Mapa);
  - **ritmo de cada máquina igual ao de antes** (mesma pausa de 20–40 s, `-c 4`): o ganho vem de usar mais
    máquinas (cada uma com outro IP), não de acelerar uma;
  - **sinal de bloqueio** (tela de consentimento/captcha, ou consultas vazias em sequência pela regra do
    disjuntor): as vagas caem para a **metade** (4 → 2 → 1), a parte pausa 30 min e as consultas restantes voltam
    para a fila; a cada **2 h sem novo sinal volta +1 vaga**. O log só registra números, ex.:
    `Sinal de bloqueio (consultas vazias em sequência): paralelismo 4 → 2`. Estado em `config/paralelismo`;
  - o **Estado inteiro** usa no máximo **2** vagas, e buscas de vendedor sempre passam na frente;
  - **cache da imagem do scraper: não** (medido: ~15 s para baixar; salvar/restaurar pelo cache levaria o mesmo ou mais).
- **Cancelar**: na fila, cancela na hora; rodando, para antes da próxima consulta e guarda os
  leads já coletados. No RN inteiro, cancela os lotes que faltam e fecha com o que já veio.
- **Apagar busca** (`/api/apagar-busca`): o vendedor apaga só as dele; o admin, qualquer uma. Confirmação em dois
  passos ("Apagar busca" → "Sim, apagar"). Apaga o documento da busca e os leads (lotes); no Estado inteiro, também os
  lotes de consultas. Em andamento: cancelar primeiro, depois apagar. **Não devolve a cota do dia.** O log da Function
  guarda só o id da busca e o uid de quem apagou.

### A tela (Fase 3a v2)
Arquivo único [`publico/index.html`](publico/index.html) (Leaflet, MarkerCluster, Chart.js e SheetJS por CDN, carregados só
quando a tela que usa abre). Fonte base 14 px; funciona em 1366×768 sem zoom e no celular (360–414 px).
- **Início**: "Olá, <nome>" (nome do cadastro; o admin edita em Admin), cartões (leads no segmento, da semana, % com
  WhatsApp, buscas ativas, cota), leads por dia e últimas buscas com linha do tempo. Os números contam **só os leads do
  segmento e da cidade pedida** (os filtros padrão de Meus leads), com a alternância **"Ver total"**; são calculados
  dos mesmos leads que aparecem ao clicar (lê os lotes das buscas uma vez por visita). Com até 7 dias de busca nos
  últimos 30, o gráfico mostra só esses dias (com o valor em cima de cada barra). **Tudo clicável**: "Leads da semana" abre Meus leads só com as buscas dos últimos
  7 dias; "% com WhatsApp" abre só os com WhatsApp; uma barra do gráfico abre os leads daquele dia; uma busca abre os
  leads dela ("Ver no mapa" abre o mapa só com ela). A tela de destino mostra a trilha de volta.
- **Nova busca** (3 passos): O quê (termos em chips, sinônimos sugeridos e editáveis, perfis salvos no servidor) ·
  Onde (mapa do RN clicável ou lista por microrregião/região imediata, com população) · Como (profundidade, e-mail,
  consultas, tempo estimado e cota).
- **Meus leads**: uma ou várias buscas juntas, sem repetidos (o mesmo lugar em outra busca completa os campos que
  faltavam). Filtros: texto, microrregião, cidade, **"Só do segmento"** e **"Só da cidade pedida"** (ligados), e em
  "Mais filtros": WhatsApp, fixo, site, sem site, Instagram, sem cidade, nota, avaliações, bairro, termo, busca de
  origem, **categorias do Google** (guardar no perfil). Chips com "limpar tudo", colunas escolhíveis, compacto/
  confortável, visões salvas (neste navegador), seleção, ficha lateral com mini-mapa. No celular a tabela vira cartões.
  **Exportar** com os leads filtrados (a tela avisa quantos vão sair):
  - **.xlsx pronto para usar** (ExcelJS, carregado só no clique): aba "Leads" com Nome, Categoria, Cidade, Microrregião,
    Bairro, Endereço, Telefone, WhatsApp, Site, E-mail, Nota, Avaliações, No segmento, Link do Google Maps, Busca (termo)
    e Data da coleta; cabeçalho azul travado com filtro, larguras ajustadas, zebra, telefone padronizado, links
    "Abrir WhatsApp"/"Abrir site"/"Ver no mapa", ordem Cidade → Nome; aba "Resumo" com totais e tabela por cidade.
    Nome: `MapaLeads_<termo>_<cidade ou região>_<dd-mm-aaaa>.xlsx`. Abre direto no Excel ou no Planilhas do celular;
  - **.csv** (`;` + BOM, sem assinatura), colunas fixas: nome, categoria, telefone, whatsapp_link, email, site, instagram,
    endereco, bairro, cidade, microrregiao, regiao_imediata, nota, qtd_avaliacoes, link_maps, termo_que_encontrou,
    cidade_buscada, cidade_confere, categorias, no_segmento (sem `id_lugar`).
- **Mapa** (Leaflet + mapa de fundo OpenStreetMap, gratuito e sem chave; escurecido no tema escuro): cores por município (leads do segmento, por 10 mil hab., população,
  PIB per capita 2022, empresas CEMPRE), pontos dos leads, contornos de microrregião, legenda. **Aprofundamento**:
  RN › microrregião › município (trilha, "Voltar" e Esc; estado na URL, ex.: `#mapa/serido-oriental/currais-novos`).
  Painel do nível: indicadores com fonte e ano, comparação com a média do RN e da microrregião, top categorias e
  barras dos municípios — tudo clicável — e "ver estes leads na tabela", "exportar este recorte", "fazer nova busca
  aqui". Tela cheia, painel recolhível; no celular o painel vira gaveta de baixo. O recorte do mapa filtra a tabela e
  vice-versa. **Cinza = "sem busca"** (não é "zero concorrentes").
- **Mercado**: mapa por município, ranking com os indicadores lado a lado (sem nota inventada; clique abre o mapa na
  cidade), gráficos (leads por 10 mil hab. por microrregião; população × leads) clicáveis.
- **Indicadores do IBGE** em [`dados/ibge_rn_indicadores.json`](dados/ibge_rn_indicadores.json) (workflow manual
  "Atualizar indicadores do IBGE"): população, área e densidade (Censo 2022, SIDRA 4714); PIB 2022 (SIDRA 5938);
  **PIB per capita 2022 = PIB 2022 ÷ população do Censo 2022 (calculado; opção "b" aprovada pelo Breno)**; empresas,
  unidades locais, pessoal ocupado e salário médio (CEMPRE 2024, SIDRA 9509).
- **Admin**: usuários (criar com nome, editar nome, limite, remover) com buscas/leads/% WhatsApp da semana, **buscas de
  todos os vendedores** (apagar qualquer uma), fila ao vivo, saúde do motor, Estado inteiro (RN) e estados ativos (só RN).
- **Celular primeiro** (o vendedor usa principalmente o celular): menu fixo embaixo (Início, Nova busca, Leads, Mapa;
  Mercado/Sobre/tema no avatar), na Nova busca o botão Próximo/Buscar fica sempre visível embaixo, lead em cartão com
  nome, cidade e botões grandes **WhatsApp** e **Ligar** (abrem o app e o discador), ficha em tela cheia com "Fechar"
  embaixo, mapa com gaveta de baixo, toques ≥ 44 px e nada passa da largura da tela em 360/390/414 px.
- **Tema**: abre **sempre claro**, mesmo com o aparelho em modo escuro (`color-scheme: only light`, que também impede o
  "escurecimento forçado" do Chrome/Samsung). Escuro só pelo botão de tema (lua/sol no topo ou no menu do avatar); a
  escolha fica salva naquele aparelho.
- **Ícones (i)**: no celular abrem com um toque e fecham tocando de novo ou fora; no computador abrem ao passar o
  mouse e também ao clicar. Balão curto sempre dentro da tela, um aberto por vez. Há (i) no Início, Nova busca, Meus
  leads, Mapa, Mercado e Admin.
- **Busca criada**: logos do MapaLeads (o pino azul) saltam e giram pela tela por ~2 s (canvas próprio, sem
  biblioteca) com a mensagem "Busca criada! Te aviso quando os leads chegarem." Com "reduzir movimento" ligado no
  sistema, só a mensagem.
- **iPhone sem zoom ao tocar num campo**: até 768 px todo campo de digitação usa fonte de 16 px (o Safari amplia a
  tela quando a fonte é menor); o zoom do usuário continua liberado (sem `maximum-scale`/`user-scalable=no`).
- **População na lista de cidades**: dentro da linha, alinhada à direita ("Apodi ······ 35.904 hab."), sem balão solto.
- Tour de 4 passos no 1º acesso, "Desenvolvido por Resolve Farma" (constante `ASSINATURA`). Datas sempre no horário de Natal.

### Agendamento do motor (rede de segurança)
- O GitHub **atrasa ou pula** agendamentos (o `*/15` nunca disparou). Agora são dois relógios:
  1. `schedule` do GitHub em minutos quebrados (`7,22,37,52 * * * *`);
  2. **despertador** no Netlify (Scheduled Function, a cada 15 min, plano Free): olha a fila e só
     dispara o motor se houver trabalho (ou busca órfã) e vaga livre (menos máquinas rodando que as vagas ligadas). Custa ~2 leituras e
     1 gravação (`config/despertador`) por vez.

### Tratamento dos dados (nada é inventado)
- duplicados removidos (ID do lugar no Google; na falta, nome + telefone). No RN inteiro, a
  remoção vale para **todo o RN** (entre todos os lotes);
- telefone `(84) 99999-9999` e link `wa.me` só para celular;
- Instagram só quando o site cadastrado no Maps é um perfil do Instagram;
- **cidade conferida**: cada lead tem `cidade_buscada` e `cidade_confere` (`sim` / `nao` /
  `indefinido`). Lead de cidade vizinha é **marcado, nunca apagado**. No RN inteiro o critério
  é "está no RN". A tela da Fase 3 terá o filtro "só da cidade pedida" ligado por padrão e o
  .xlsx sai com a coluna `cidade_confere`;
- campo que o Google não trouxe fica vazio.

### Profundidade e tempo (medido em 23/09/2026 e recalibrado sozinho)
| Profundidade | Lugares por consulta | Tempo por consulta (sem e-mail) |
|---|---|---|
| Rápida | ~20 | ~40 s (medido) |
| Normal | ~60 | ~1,5–2 min (estimado) |
| Completa | até ~120 (teto do Google) | ~3 min (estimado) |

Mais uma **pausa aleatória de 20–40 s entre consultas** (reduz o risco de bloqueio) e ~1 min
para a máquina do GitHub ligar. Com e-mail, ~1,6×. O motor grava o tempo real de cada
consulta em `config/metricas` e as estimativas da tela se ajustam sozinhas.

**Medido na execução real #7 (23/09, 30 consultas):** raspagem de 10–60 s por consulta (média ~25 s) + pausa
de 20–40 s ≈ **56 s por consulta** (28 min no total); partida ~20–35 s (baixar a imagem ~15 s).
**Estimativa honesta com paralelismo:** partida + a parte mais demorada (as partes rodam ao mesmo tempo). Ex.:
30 cidades × 3 termos (Rápida) = 90 consultas → ~1h15–1h25 numa máquina; **~20–22 min com 4** (primeiros leads em
~2–3 min). A Nova busca mostra "N máquinas em paralelo · numa só: ~X" e avisa que, com outras buscas rodando, as
máquinas se dividem. **Cidades pequenas**: quando há cidades do RN com menos de 5 mil hab. (IBGE, Censo 2022; 52 dos
167 municípios), a Nova busca avisa quantas são e quanto tempo tirá-las economiza, com o botão "Remover as pequenas"
(nada é tirado sozinho).

### Vigia de tempo (nenhuma consulta fica presa)
O scraper termina o trabalho mas às vezes não encerra o processo. A vigia:
1. **fim real**: quando o scraper avisa `scrapemate exited` no log interno, espera 5 s sem lead
   novo e encerra o container;
2. **plano B**: encerra após **60 s sem atividade** (sem e-mail) ou **3 min** (com e-mail);
3. encerra se nenhum lead nos primeiros 5 min;
4. limite rígido por consulta: rápida 6 / normal 12 / completa 20 min (o dobro com e-mail).

O log público mostra só números, ex.:
`término: fim real detectado (código -15), 36s, fim real aos 31s, etapas ok=21 falhas=0, inatividade=não, consentimento=não`.

### RN inteiro
- 167 municípios, população do **Censo 2022 (IBGE)** em [`dados/municipios_rn.json`](dados/municipios_rn.json).
- Profundidade automática: até 20 mil hab. = rápida; 20–100 mil = normal;
  **Natal, Mossoró e Parnamirim por bairro** (bairros oficiais do IBGE, Censo 2022, em
  [`dados/bairros_rn.json`](dados/bairros_rn.json): 36, 27 e 22) na normal;
  **São Gonçalo do Amarante** cidade inteira na completa.
- 1 termo = **249 consultas**, divididas em lotes de ~40 min (buscas-filhas) agrupados numa
  **busca-mãe** (status e progresso consolidados, um único resultado sem duplicados).
- Tempo estimado (1 termo, sem e-mail): **~7 h** (11 lotes). Com e-mail ~10 h; 2 termos ~14 h.
- Opção **"agendar para a noite"** (começa às 22h de Natal).
- **Disjuntor**: 3 consultas "vazias" seguidas pausam o RN por 30 min (possível bloqueio);
  as buscas comuns continuam. Só conta como vazia a consulta sem lead **e** (com falha/erro do
  scraper **ou** cidade com mais de 20 mil habitantes; bairros de Natal/Mossoró/Parnamirim contam
  como grandes). Cidade pequena sem resultado é **neutra**: não conta nem zera a sequência.
- 2 execuções em paralelo: código pronto, **desligado** (`MOTOR_PARALELO: "false"` no workflow).

### Cotas gratuitas do Firestore (50 mil leituras / 20 mil gravações por dia)
- Leads gravados em **lotes de 300 por documento**: uma busca de 300 leads = 1 gravação.
- A lista de buscas lê só os 20 documentos mais recentes (o resumo fica no documento da busca).
- Um RN inteiro ≈ 600–800 gravações. O agendamento de 15 em 15 min com fila vazia ≈ 8 leituras
  por execução e não grava nada se a fila não mudou. O despertador ≈ 200 leituras e 96 gravações/dia.
- Tela: "Hoje" ≈ 9 leituras; abrir leads = 1 leitura por lote de 300; estatísticas do dia =
  2 gravações por busca concluída.
- **Atenção (plano Blaze):** se a cota diária estourar, o excedente é **cobrado** (não bloqueia mais).
  O alerta de orçamento só avisa, não corta. Por isso o código continua econômico em leituras/gravações.

## Privacidade (repositório público)
- Logs do Actions: **só contagens e status**. Nunca leads, termos, cidades, UID ou tokens.
- Saída do scraper só em arquivo temporário do runner, apagado ao final. Sem upload de artefatos.
- A tela manda só o ID da busca para o GitHub; os termos ficam no Firestore.

## Segurança
- **Papéis por custom claim** (`admin: true`), gravada só pelo servidor (workflow "Definir admin").
  O usuário não consegue se promover.
- **Regras do Firestore** ([`firestore.rules`](firestore.rules)): usuário comum lê só as próprias
  buscas e leads; admin lê tudo; **ninguém grava pelo navegador** (nem o admin).
- **Netlify Functions** validam o ID token em toda chamada (token revogado/usuário removido perde
  acesso na hora). RN inteiro e gestão de usuários exigem a claim `admin` **no servidor**.
  Apagar busca: sem a claim `admin`, só apaga se `dono_uid` for o próprio uid (senão **403**).
- Usuário removido: a conta é apagada, as buscas dele ficam visíveis para o admin (marcado "removido").
- Não há cadastro público nem "promover a admin" pela tela.

## Configuração da Fase 3a (depois do merge)
1. **Firebase › Firestore › Regras**: cole de novo o conteúdo de [`firestore.rules`](firestore.rules)
   › **Publicar** (nova regra para `estatisticas`).
2. Netlify: nada novo a cadastrar. O deploy do `main` publica a tela, as Functions `perfis`,
   `saude-motor` e o **despertador** (aparece em **Logs › Functions** como *scheduled*).
3. Teste: entre em https://mapaleads-rn.netlify.app, faça uma busca rápida e abra os leads.

## Configuração da Fase 2 (na ordem)

> A Fase 1 já está configurada (projeto Firebase, secret `FIREBASE_SERVICE_ACCOUNT`).

### 1. GitHub — secret do UID (se ainda não fez)
**Settings › Secrets and variables › Actions › aba Secrets › New repository secret**
- Name `MAPALEADS_ADMIN_UID` — Value: seu UID (Firebase › Authentication › Usuários).
- Depois do merge da Fase 2, apague a **variável** antiga: aba **Variables** › `MAPALEADS_ADMIN_UID` › Delete.

### 2. GitHub — tornar-se admin
**Actions › Definir admin › Run workflow** (branch `main`). O log deve terminar com
"Claim de administrador aplicada". Também cria `config/geral` com o limite padrão 20.

### 3. Firebase — regras e índices
1. **Firestore › Regras**: cole o conteúdo de [`firestore.rules`](firestore.rules) › **Publicar**.
2. **Firestore › Índices › Composto › Criar índice** (3 índices, coleção `buscas`, escopo Coleção):
   - `lista` Crescente, `dono_uid` Crescente, `criada_em` Decrescente;
   - `lista` Crescente, `criada_em` Decrescente;
   - `lista` Crescente, `liberada_para` Arrays (contém), `criada_em` Decrescente (buscas liberadas ao vendedor, PR 16).
   (Ou abra a página de teste: se faltar índice, o erro do Firebase traz um link que cria o índice.)
3. **Configurações do projeto › Geral › Seus apps › `</>` (Web)** › registre o app "mapaleads-web"
   (sem Hosting) e copie o **apiKey** (não é segredo, mas fica em variável de ambiente).
4. **Authentication › Configurações › Domínios autorizados** › adicione o domínio do Netlify
   (ex.: `mapaleads.netlify.app`) depois do passo 5.

### 4. GitHub — token para o Netlify disparar o motor
**Foto do perfil › Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token**
- Nome `mapaleads-netlify`; validade: até 1 ano (anote para renovar);
- Repository access: **Only select repositories** › `Brenoresolvefarma/mapa-leads`;
- Permissions › Repository › **Actions: Read and write** (só isso);
- Gerar e copiar o token (começa com `github_pat_`).

### 5. Netlify (plano Free, sem cartão)
1. <https://app.netlify.com> › **Add new project › Import an existing project › GitHub** ›
   `Brenoresolvefarma/mapa-leads`, branch `main`. As configurações vêm do `netlify.toml`.
2. **Project configuration › Environment variables › Add a variable** (escopo: todos):

| Variável | Valor |
|---|---|
| `FIREBASE_PROJECT_ID` | campo `project_id` do JSON da chave do Firebase |
| `FIREBASE_CLIENT_EMAIL` | campo `client_email` do JSON |
| `FIREBASE_PRIVATE_KEY` | campo `private_key` do JSON (tudo entre as aspas, com os `\n`) — marque **Contains secret values** |
| `FIREBASE_WEB_API_KEY` | apiKey do passo 3.3 |
| `MAPALEADS_GITHUB_TOKEN` | token do passo 4 — marque **Contains secret values** |
| `MAPALEADS_GITHUB_REPO` | `Brenoresolvefarma/mapa-leads` |

3. **Deploys › Trigger deploy › Deploy site** (as variáveis só valem após novo deploy).
4. Volte ao passo 3.4 e autorize o domínio do Netlify no Firebase.

## Equipes: master › gestor › vendedor (PR 19)
- **Master** (Breno): vê e controla tudo; aba **Equipes** (criar equipe + representante, cotas, uso do mês, desativar).
  As buscas do master ficam numa área só dele (ninguém vê sem ele liberar).
- **Gestor** (representante): menu **Minha equipe** — prepostos (criar, limites, desativar), resultados por preposto
  (buscas, leads, contatados, negociando, clientes, conversão), buscas da equipe (liberar/apagar), carteiras e
  representadas. Vê só a equipe dele.
- **Vendedor** (preposto): só as buscas dele e as listas liberadas para ele.
- Cotas por equipe: Resolve Farma sem limite; equipe nova 10 usuários / 100 buscas por dia / 6.000 consultas por mês.
  A carteira é por equipe (equipes diferentes podem atender o mesmo estabelecimento).

## Configuração do PR 19 (equipes) — na ordem
1. **Antes do merge** — Firebase › Firestore › **Índices** › Composto › **Criar índice** (coleção `buscas`, escopo Coleção), dois índices:
   - `lista` Crescente · `equipe_id` Crescente · `criada_em` Decrescente;
   - `lista` Crescente · `liberada_equipes` **Arrays** · `criada_em` Decrescente.
2. **Antes do merge** — GitHub › Actions › **Migrar equipes** › Run workflow (branch do PR) com `simular`: o log mostra
   só contagens do que vai mudar. Depois rode de novo com `aplicar`.
3. Merge do PR (o Netlify publica sozinho). Rode **Migrar equipes** › `aplicar` **de novo** (pega o que mudou no meio).
4. Firebase › Firestore › **Regras**: cole o conteúdo novo de [`firestore.rules`](firestore.rules) › **Publicar**.
5. Todo mundo que estiver com a tela aberta: **recarregar a página** (o papel e a equipe vêm no token novo).
6. Depois de conferir (alguns dias): **Migrar equipes** › `limpar_carteira_antiga` (apaga os `carteira/NN` antigos).

## Configuração depois do merge do PR 16 (liberar busca para vendedor)
**Obrigatório** (sem isso o vendedor não vê as listas liberadas nem os status/carteira; o resto continua funcionando):
1. Firebase › Firestore › **Regras**: cole o conteúdo novo de [`firestore.rules`](firestore.rules) › **Publicar**
   (novas: buscas liberadas, `crm/{uid}__{fatia}` e `carteira/{fatia}`).
2. Firebase › Firestore › **Índices** › Composto › **Criar índice** (coleção `buscas`, escopo Coleção):
   `lista` Crescente · `liberada_para` **Arrays** (contém) · `criada_em` Decrescente. Leva alguns minutos para ficar pronto.

## Configuração depois do merge do PR 15 (limites do vendedor)
Nada a cadastrar: sem valores em `config/geral`, valem 40 cidades / 120 consultas por busca e 300 consultas por dia.
Para mudar: Admin › Configurações (todos) ou a coluna "Consultas/dia" da tabela de usuários (um vendedor).

## Configuração depois do merge do PR 14 (motor em paralelo)
Nada a cadastrar: o `motor.yml` já abre as 4 vagas e o `config/paralelismo` é criado sozinho no primeiro sinal de
bloqueio (sem ele, valem 4 vagas). Para voltar a 1 máquina só, em caso de problema: Firebase › Firestore › `config` ›
documento `paralelismo` com `vagas_base: 1` e `ultimo_sinal_em` = agora (volta +1 a cada 2 h), ou peça a mudança.

## Configuração depois do merge do PR 13 (celular primeiro)
Nada a cadastrar: a Function `apagar-busca` usa as mesmas variáveis do Netlify e as regras do Firestore não mudam
(o navegador continua sem gravar nada). Depois do deploy, o teste real roda sozinho pelos workflows abaixo.

## Verificação em produção (GitHub Actions, manual)
- **Verificar Functions**: chama as Functions no ar sem login (espera 200/401/405). Só status no log.
- **Testar tela em produção**: logins temporários (comum + admin) e buscas fictícias; confere todas as telas,
  (i) no toque, tema, apagar (própria, 403 na de outro, admin apaga de vendedor). Tudo apagado no fim.
- **Capturas da tela**: capturas do celular (390/360, claro e escuro) com login temporário e busca fictícia, na
  branch `capturas-tela`. A criação da busca nas capturas dos logos é simulada (nada vai para a fila).
- **Diagnosticar Functions**: cria um login de teste temporário (apagado no fim) e faz uma busca
  **simulada** (não grava nada) em produção, além de testar o Firestore direto. Mostra status e códigos de erro.

## Desenvolvimento e testes
```bash
pip install -r motor/requirements.txt -r motor/requirements-dev.txt
npm ci
(cd motor && pytest -q)     # tratamento, vigia, fila
npm test                    # lógica das Functions
npm run test:regras         # regras do Firestore (emulador; precisa de Java)
npm run test:funcoes        # Functions contra emuladores de Auth + Firestore
npm run test:motor          # motor inteiro contra o emulador, com scraper falso
npm run test:empacotadas    # Functions empacotadas como no Netlify
npm run test:tela           # tela no Chromium (Playwright) contra os emuladores
```
`test:tela` clica em cada cartão, barra, categoria e item do ranking e confere o detalhe que abre, e mede em
360/390/414 px que a página tem a largura da tela (nada passa para o lado) e que os toques têm ≥ 44 px. Também:
etiquetas de população (passar o mouse em 5 cidades e rolar), tema (aparelho escuro → abre claro; em 390 px o botão
troca e fica salvo depois de recarregar; no CI também no **WebKit**, o motor do Safari), cada (i) em 390 px, apagar
busca (dois passos, em andamento só cancela, admin) e comemoração (com e sem "reduzir movimento").
Leaflet, MarkerCluster e Chart.js vêm do `node_modules` nos testes (mesmas versões do CDN).
Tudo com dados fictícios; roda automaticamente no workflow **Testes** a cada push/PR.

## Estrutura
```
.github/workflows/motor.yml          # motor (dispatch + agendamento 15 min + fila)
.github/workflows/definir-admin.yml  # aplica a claim admin ao UID do secret
.github/workflows/testes.yml         # pytest + node + emuladores
motor/motor.py        # laço principal: fila, preempção, pausa, disjuntor, gravação
motor/fila.py         # prioridade, rodízio por dono, estado público da fila, órfãs
motor/rn_inteiro.py   # busca-mãe/filhas, consolidação sem duplicados, pausa
motor/vigia.py        # vigia de tempo do scraper + diagnóstico só com números
motor/tratamento.py   # limpeza dos dados, cidade conferida, estimativas
netlify/functions/    # criar-busca, cancelar-busca, apagar-busca, admin-usuarios, config-publica,
                      # perfis, saude-motor, despertador (agendada, 15 min)
netlify/lib/          # lógica pura (testável) + utilidades de servidor
dados/                # municípios (Censo 2022), bairros e micro/regiões imediatas (IBGE)
publico/index.html    # a tela (arquivo único; o build copia dados/*.json para publico/dados/)
firestore.rules, firestore.indexes.json, firebase.json, netlify.toml
testes/               # testes Node (lógica, regras, Functions, tela)
```
