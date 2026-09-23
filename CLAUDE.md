# CLAUDE.md — contexto do projeto MapaLeads

## O que é
Sistema multiusuário de prospecção B2B via Google Maps para o Breno (prospecção comercial; começou no RN,
vai para os **9 estados do Nordeste** — ver "Fase 3 — Nordeste"). Admin (Breno) + usuários comuns.
Buscas sob demanda: termos e cidades livres, e "RN inteiro" (só admin; vira "Estado inteiro").
Futuro: venda por assinatura (Fase 4, só depois da análise de custo x receita aprovada pelo Breno).

## Regras de trabalho combinadas com o Breno
- Mostrar o plano e esperar autorização antes de criar/alterar arquivos.
- Perguntar quando algo for ambíguo; **não definir valores de negócio** sem perguntar.
- **Custo: priorizar SEMPRE a cota gratuita; custo acima dela só com aprovação prévia do Breno.**
  Atualização do Breno: o projeto Firebase `mapaleads` foi migrado para o plano **Blaze** (conta de faturamento
  RESOLVE FARMA) com **alerta de orçamento de R$ 20/mês**. Continua: repo público (Actions grátis), Netlify Free.
  Qualquer recurso que possa gerar custo acima da cota gratuita (Cloud Functions, Storage, leituras/gravações
  além da cota, outro serviço pago) → **avisar e esperar aprovação antes** de implementar, com a estimativa
  de custo e a alternativa gratuita. **Motor continua no GitHub Actions até a Fase 4.**
- Respeitar a cota grátis do Firestore (50 mil leituras / 20 mil gravações por dia) no motor e na tela.
  Atenção: no Blaze, passar da cota **cobra** (não bloqueia mais como no Spark), e o alerta de orçamento
  só AVISA — não corta o gasto. Por isso os limites de leitura/gravação do código continuam valendo.
- Nunca colocar tokens/chaves/senhas no código (secrets do GitHub / env vars do Netlify).
- Código simples, comentado em português.
- Ao fim de cada fase: atualizar README.md e CLAUDE.md; passar passo a passo de configuração.
- Trabalhar na branch designada e abrir PR para `main`. **Merge (regra de 24/09):** posso fazer merge sozinho
  quando o CI estiver verde E o teste real em produção passar (ex.: workflow "Diagnosticar Functions" /
  "Verificar Functions" contra https://mapaleads-rn.netlify.app). Sem isso, o Breno faz o merge.
- Repositório PÚBLICO: nunca logar dados de leads, termos, cidades, UID ou tokens; sem upload-artifact;
  sem commit de CSV/JSON de resultados; temporários apagados do runner.
- Só dados reais (IBGE oficial + leads coletados); nada estimado apresentado como dado.

## Arquitetura
1. Tela HTML single-file (CDN) no Netlify — `publico/index.html` (**Fase 3a v2** no PR 12, aguardando aprovação).
2. Firebase Auth e-mail/senha, sem cadastro público (admin cria/remove) — **Fase 2 (feito)**.
3. Netlify Functions (`/api/criar-busca`, `/api/cancelar-busca`, `/api/admin-usuarios`, `/api/config-publica`,
   `/api/perfis`, `/api/saude-motor` + `despertador` agendada): guardam token do GitHub e credencial admin do
   Firebase; validam ID token (checkRevoked) — Fases 2 e 3a (feito).
4. Motor: GitHub Actions (`workflow_dispatch` + `schedule` `7,22,37,52 * * * *`) + despertador do Netlify.
5. Banco: Firestore.

## Decisões tomadas
### Motor / scraper (Fase 1)
- `gosom/google-maps-scraper:v1.18.1` fixado. Flags: `-input -results -json -depth -c 4 -lang pt-BR
  -exit-on-inactivity 3m [-email]`, container com `-e DISABLE_TELEMETRY=1`. Imagem baixada só quando há trabalho.
- Profundidade: rapida=`-depth 1` (~20), normal=`-depth 5` (~60), completa=`-depth 10` (até ~120). Padrão normal.
  Extrair e-mail: padrão Não.
- Scraper roda uma vez por consulta. Dedup: place_id → cid → nome+telefone normalizado; termos juntados.
- Telefone: celular → `(84) 99999-9999` + `wa.me`; fixo 10 dígitos sem wa.me; nunca acrescenta o 9.
- Instagram só quando `web_site` é instagram.com. Nota 0 = sem nota.
- Leads em lotes de 300 por documento (`buscas/{id}/lotes/{n}`); resumo no doc da busca.

### Vigia (execuções reais 1 e 2)
- Execução real 2 (23/09, home care, Natal, rápida): 20 leads em ~30 s, depois o scraper NÃO encerrou;
  vigia cortou após 3 min (código 137). Causa (lida no código v1.18.1 / scrapemate v1.4.0): o scraper
  termina o trabalho mas fica preso no encerramento (wg.Wait / fechar navegador). As linhas
  "scrapemate stats" só saem a cada 90 s enquanto ativo, por isso "etapas ?" na Fase 1.
- Fase 2: **fim real** = `scrapemate exited` no log interno (+5 s sem lead novo) → encerra;
  **plano B** = 60 s sem atividade (sem e-mail) / 3 min (com e-mail), atividade = lead novo OU linha
  `job finished`; sem lead em 5 min → encerra; limites rígidos rapida 6 / normal 12 / completa 20 min (×2 e-mail).
- Diagnóstico público só com números: motivo, código, segundos, segundo do fim real, etapas ok/falhas
  (contagem de `job finished` por nível), inatividade, consentimento (só sim/não).
- Pausa aleatória de 20–40 s entre TODAS as consultas (comuns e RN).
- Execução real 2 também confirmou: sem tela de consentimento; 20/20 telefones formatados; 14 wa.me;
  lead de São Gonçalo numa busca de Natal → decisão "marcar, não apagar".

### Fase 2
- **Papéis**: custom claim `admin: true`, aplicada só pelo workflow "Definir admin" ao UID do secret
  `MAPALEADS_ADMIN_UID` (não há promoção pela tela). Motor confere a claim do dono antes de rodar RN.
- **Limite diário**: padrão 20 buscas comuns/usuário (`config/geral.limite_padrao`), por usuário em
  `usuarios/{uid}.limite_diario`; dia no fuso America/Fortaleza; conferido e contado na mesma transação
  que cria a busca. RN inteiro não conta e não tem limite (o disjuntor segura o ritmo). Cancelar não devolve a cota.
- **Busca comum grande demais** (> 5 h estimadas) é recusada (limite técnico da execução do Actions).
- **Fila**: comuns primeiro (rodízio por dono), depois filhas do RN (FIFO). **Preempção entre consultas**:
  antes de cada consulta do RN o motor olha se há busca comum (1 leitura) e a roda antes.
  Filhas de ~40 min estimados; se o tempo da execução acaba, as consultas restantes viram nova filha e o
  motor se redispara (GITHUB_TOKEN, `actions: write`). Agendamento */15 como rede de segurança.
- **Órfãs**: sem paralelo, toda busca "rodando" no início é órfã (comum → erro; filha → volta à fila 1 vez).
  Com paralelo (desligado), órfã após 45 min sem `batimento_em`.
- **2 motores em paralelo**: código pronto, DESLIGADO (`MOTOR_PARALELO: "false"`). Ligar só após semanas
  sem sinais de bloqueio (e mudar o `concurrency` do workflow).
- **Disjuntor**: 3 consultas "vazias" seguidas no RN → pausa de 30 min (mãe + filhas na fila com
  `pausada_ate`), consultas restantes voltam à fila. **Vazia (regra de 24/09, feita na 3a)** = sem lead E
  (scraper com falha/erro — motivo da vigia fora do fim normal ou código de erro — OU cidade > 20 mil hab.
  no Censo 2022; bairros de Natal/Mossoró/Parnamirim contam como > 20 mil). Cidade pequena vazia sem falha
  é **neutra**: não conta e NÃO zera a sequência (só lead encontrado zera). **Aprovado pelo Breno** (PR 9).
- **Agendar para a noite**: 22h America/Fortaleza (= 01h UTC).
- **Cancelar**: dono ou admin. Na fila → cancelada; rodando → `cancelar_solicitado` e o motor para antes
  da próxima consulta, guardando os leads parciais. Mãe → filhas na fila canceladas, mãe consolidada.
- **Remover usuário**: apaga a conta do Auth; `usuarios/{uid}.removido = true`; buscas continuam visíveis ao admin.
- **Cidade conferida**: `cidade_buscada`, `cidade_confere` (sim/nao/indefinido), `id_lugar` em cada lead.
  Comum: cidade do endereço == cidade pedida (sem acento/UF; Açu=Assú). RN: estado == RN (ou sigla no endereço).
  Marcar, nunca apagar. Fase 3: filtro "só da cidade pedida" ligado por padrão; xlsx com coluna `cidade_confere`.
- **RN inteiro**: `dados/municipios_rn.json` (167, Censo 2022 via SIDRA t4709 v93; soma 3.302.729) e
  `dados/bairros_rn.json` (malha de bairros IBGE CD2022: Natal 36, Mossoró 27, Parnamirim 22).
  Faixas: ≤20 mil rápida; ≤100 mil normal; Natal/Mossoró/Parnamirim por bairro (normal); SGA completa.
  1 termo = 249 consultas (140 rápida, 108 normal, 1 completa) ≈ 7 h / 11 lotes (sem e-mail).
  Dados coletados por um workflow temporário na branch (o proxy do ambiente de dev bloqueia o IBGE); removido.
- **Estado público da fila** (`fila/estado`): só id, tipo, mae_id, estimativa; `rodando` com restante;
  `aguardando` (agendadas/pausadas). Gravado só quando muda.
- **Métricas** (`config/metricas`): média real por consulta por profundidade/e-mail (n até 50), usada nas estimativas.
- **Documentos**: `buscas` tem `tipo` (comum | rn_mae | rn_filha) e `lista: true` (comum e mãe) para
  "Minhas buscas". Índices compostos em `firestore.indexes.json`.
- **firebase-admin fixado em 13.x (13.10.0)**: a 14.x traz `jwks-rsa` 4 + `jose` 6 (só ESM) e o runtime das
  Functions do Netlify não faz `require()` de ES Module → 502 `ERR_REQUIRE_ESM` em produção (24/09).
  A 13.x usa `jwks-rsa` 3 + `jose` 4 (CommonJS). Não subir para 14 sem rodar `npm run test:empacotadas`
  (empacota com o zip-it-and-ship-it do Netlify e roda com `--no-experimental-require-module`; está no CI).
  `ferramentas/verificar_functions.mjs` + workflow "Verificar Functions" checam as Functions no ar (só status HTTP).
- **Functions usam o Firestore via REST** (`preferRest: true` em `netlify/lib/servidor.mjs`). Motivo: em produção
  (24/09) o `criar-busca` dava 500 ao acessar o Firestore, enquanto o MESMO pacote (idêntico ao do Netlify,
  1041 arquivos) e as MESMAS credenciais funcionavam no runner do GitHub. Causa exata no Netlify não observada
  (o log antigo só registrava "Error"); REST tira o gRPC/HTTP2 do caminho (recomendação do Google p/ serverless).
  Hipótese "OpenTelemetry global da extensão de observabilidade do Netlify" testada localmente: NÃO reproduziu.
  O handler agora loga nome/código/mensagem do erro e devolve `codigo` no 500.
  **Causa real encontrada depois (PR 6):** `codigo: app/invalid-credential` — o `cert()` não conseguia ler a
  `FIREBASE_PRIVATE_KEY` como colada no Netlify (o erro acontecia ao iniciar o Firebase, ANTES de verificar o
  token; por isso "sem login" dava 401 e a config-publica funcionava). `normalizarChavePrivada()` aceita
  "\n" literal, quebras reais, aspas, a linha `"private_key": ...` e o JSON inteiro; se ainda for inválida,
  o 500 diz o FORMATO recebido (começa/termina com BEGIN/END, nº de linhas), nunca o conteúdo.
  Workflow manual "Diagnosticar Functions" (login de teste temporário, só `simular`) testa produção de ponta a ponta.
- **Netlify**: credencial do Firebase em 3 variáveis (limite de tamanho das env vars de Functions);
  token GitHub fine-grained só com Actions RW. Config web pública via `/api/config-publica`.
- Datas na tela sempre em America/Fortaleza.

### Fase 3a (tela definitiva)
- **Abas**: Hoje | Nova busca | Buscas | Leads | Admin (só com a claim). Tema claro/escuro automático.
- **Hoje**: minhas buscas na fila/rodando + fila geral; leads dos últimos 7 dias (fuso Fortaleza) e % com
  WhatsApp, lidos de `estatisticas/{dia}__{uid}` (admin também `{dia}__geral`); cota do dia (`usuarios/{uid}`
  + `config/geral`). O motor soma as estatísticas ao concluir busca comum e ao consolidar a mãe (2 gravações).
  Regra: `{dia}__{uid}` o dono lê (por ID, mesmo sem documento); resto só admin.
- **Regiões**: `dados/microrregioes_rn.json` (API de Localidades do IBGE: 19 microrregiões + 11 regiões
  imediatas, cada uma com os códigos dos municípios; coletado por workflow temporário, removido).
  A escolha micro/imediata é uma só (guardada no navegador) e vale para Nova busca, filtro e coluna da tabela.
  Cidades enviadas como "Nome RN" em ordem alfabética; cidades fora do RN em texto livre.
- **Perfis salvos**: `usuarios/{uid}/perfis/{id}` só pela Function `/api/perfis` (listar/salvar/apagar);
  máx. 50 por usuário e nome até 60 caracteres (aprovado pelo Breno). Regras bloqueiam leitura direta.
- **Leads**: 1 ou várias buscas juntas (1 leitura por lote), sem duplicados (id_lugar → nome+telefone,
  termos juntados; se algum dos repetidos confere a cidade, fica "sim"). Região do lead = cidade do
  ENDEREÇO (sem cidade = em branco; nada inferido). "Só da cidade pedida" (ligado) esconde só
  `cidade_confere = nao` (os "indefinido" continuam — aprovado pelo Breno). Filtros: região, cidade com contagem, WhatsApp,
  sem site (nem site nem Instagram), nota mínima, nome. Tabela mostra 300 por vez. Ficha no clique.
- **Exportar**: .xlsx (SheetJS 0.20.3 do cdn.sheetjs.com, carregado só no clique) e .csv (`;` + BOM, nota com
  vírgula), respeitando os filtros. Colunas: nome, categoria, telefone, whatsapp_link, email, site, instagram,
  endereco, bairro, cidade, microrregiao, regiao_imediata, nota, qtd_avaliacoes, link_maps,
  termo_que_encontrou, cidade_buscada, cidade_confere (sem id_lugar). Nome: filtro de cidade → cidade;
  RN inteiro → RN; cidades pedidas = todas de uma região (do tipo escolhido) → região; 1 cidade → cidade;
  senão varias-cidades. Segmento = até 3 termos em slug. Data = hoje em Fortaleza.
- **Admin**: saúde do motor (`/api/saude-motor`: últimas 15 execuções do motor.yml via token do GitHub,
  despertador, fila, pausadas, agendadas, órfãs, métricas, números de hoje), RN inteiro, usuários/cota/uso.
- **Agendamento**: o `*/15` do GitHub nunca disparou (0 execuções por schedule). Cron re-registrado em
  `7,22,37,52 * * * *` + **despertador** (Netlify Scheduled Function `*/15`, plano Free): lê buscas na_fila e
  rodando (só campos de controle), dispara o motor só se houver elegível (mesma regra de `elegivel`) ou órfã
  (> 45 min sem batimento) e nada vivo; grava `config/despertador`.
- **Sessão (bug corrigido no PR 11)**: sair com admin e entrar com usuário comum na MESMA aba mostrava selo/menu
  admin e leads do admin (estado em memória; o Firestore não vazava). Agora: "Sair" cancela listeners e recarrega a
  página; qualquer troca de uid no `onAuthStateChanged` também recarrega; "admin" nunca é herdado (só a claim do token
  recém-atualizado). Teste no Chromium cobre admin → sair → comum na mesma aba; servidor recusa ações de admin (403).
- **Relevância do segmento (PR 11, pedido do Breno)**: o Google devolve "parecidos" em cidade pequena (busca HOME CARE
  em 30 cidades: 406 leads, só 50 do segmento e só 7 nas cidades pedidas). Cada lead é **marcado** (nunca apagado)
  como `no_segmento` sim/não, na tela: termo + sinônimos + categorias aceitas comparados com nome e categoria do Google
  (sem acento/maiúsculas; frase = todas as palavras; plural só em palavras de 5+ letras). Filtro **"Só do segmento"
  ligado** com contador "x fora do segmento escondidos – ver"; filtro de **Categorias do Google** com contagem,
  busca, marcar/desmarcar, "Só as ✓" e "Guardar no perfil" (`perfis` ação `salvar_categorias` → `categorias_aceitas`).
  **Sinônimos**: dicionário curto no bloco `<relevancia>` do `index.html` (testado por `testes/relevancia.test.mjs`),
  sugeridos e editáveis na Nova busca; guardados na busca (`parametros.sinonimos`, `parametros.categorias_aceitas` —
  só marcam, não mudam as consultas) e no perfil; opção "Buscar também pelos sinônimos" (desligada; soma consultas).
  Buscas antigas sem sinônimos usam as sugestões do dicionário. Motor grava `categorias` (lista do Google) em cada lead.
  Exportação ganhou `categorias` e `no_segmento`.
- **Sem cidade (PR 11)**: com "Só da cidade pedida" ligado, leads sem cidade no endereço também ficam escondidos
  (antes apareciam), com a opção "Mostrar leads sem cidade".
- **Testes da tela**: `npm run test:tela` (Playwright + Chromium contra emuladores; SDK do Firebase servido do
  node_modules; `.xlsx` real só no CI com `TESTAR_XLSX=1`). Produção: workflow manual "Testar tela em
  produção" (logins temporários comum+admin, busca fictícia, tudo apagado). Com `api_local=true` testa o
  **deploy preview** de um PR com as Functions do commit rodando no runner (o preview não tem os secrets).

### Fase 3a v2 (tela nova — PR 12)
- **Etapa 0 aprovada com ajustes** (visual, mapa; PIB per capita = **opção b: PIB 2022 ÷ Censo 2022, calculado**).
  Sem link para a tela antiga; `publico/prototipo.html` removido.
- **Compacta**: fonte base 14 px, cartões/espaços ~20–25% menores; tabela compacto/confortável; 1366×768 sem zoom.
- **Celular** (pedido do Breno): zero rolagem lateral em 360/390/414 (html/body `overflow-x: clip` + tudo com
  `min-width:0`/quebra de palavras), margens de 16 px com área segura do iPhone, tabelas viram cartões (leads por
  `#cartoes`; ranking/usuários/execuções por `.tabela.vira-cartao` + `data-rot`), chips e filtros numa faixa que rola
  só por dentro, toques ≥ 44 px, ranking do Mercado 20 por vez ("mostrar mais"). O teste mede a largura tirando o clip.
- **Tudo clicável** (`detalharLeads()` + trilha `#trilha-leads`): cartões do Início (total/semana/WhatsApp abrem Meus
  leads com o mesmo recorte do número — no segmento ou, em "Ver total", filtros desligados; semana = buscas que TERMINARAM
  nos últimos 7 dias em Fortaleza, filtro `F.periodo`), barra do dia, busca (leads) e "Ver no mapa"; no Mapa, barras
  de microrregião/município aprofundam e categoria abre a tabela com `F.categoria` (mesma contagem, mantém os filtros);
  Mercado: cartões (indicador → ranking; leads → tabela), ranking e gráficos → mapa; ficha: cidade/microrregião → mapa.
- **Mapa** Leaflet: RN › microrregião › município (bairro só como chips do painel), estado na URL
  (`#mapa/<micro>/<municipio>` em slug), Esc/Voltar, tela cheia, painel recolhível (gaveta no celular), zoom embaixo
  à direita, zoom máximo 11 (contorno simplificado). Cinza = "sem busca". Sem índice de oportunidade (proposta só
  com aprovação da fórmula).
- **Início (ajustes do Breno)**: saudação com o NOME (`usuarios/{uid}.nome` ou displayName; sem nome = "Olá!", nunca o
  e-mail); admin edita o nome (`admin-usuarios` ação `definir_nome`, até 60 caracteres, grava doc + displayName).
  Cartões e gráfico contam por padrão só leads **no segmento e da cidade pedida** (mesma regra dos filtros padrão),
  alternância "No segmento | Ver total" (guardada no navegador); calculados dos lotes das buscas (cache `lotesLidos`,
  compartilhado com Meus leads; 1 leitura por lote por visita — o Início não lê mais `estatisticas`), cada recorte com
  o segmento das suas buscas, igual ao detalhe. Gráfico: até 7 dias com busca nos últimos 30 → só esses dias.
- **Exportação**: colunas FIXAS (as de sempre + categorias + no_segmento); escolher colunas vale só para a tabela.
  **Aprovado pelo Breno (23/09)**, junto com: "Sair" volta o endereço ao Início (sem #leads/#mapa do usuário anterior)
  e ranking do Mercado só com indicadores lado a lado (sem nota/índice calculado).
- **Duplicados**: o mesmo lugar em outra busca completa os campos vazios (dado real do Google).
- `admin-usuarios` listar devolve `semana` (7 dias de `estatisticas/{dia}__{uid}`: 7 leituras por usuário).
- Motor grava `latitude`/`longitude` (campo "longtitude" do scraper); leads antigos: coordenadas do `link_maps`.
- Testes: `testes/rotas-cdn.mjs` (CDN do node_modules + `medirLargura`); `tela.test.mjs` reescrito (6 testes);
  `ferramentas/testar_tela_producao.mjs` e `capturar_telas.mjs` (SEMEAR=1 = busca fictícia temporária) para a v2.

## Estado atual
- Fase 1 concluída e validada com execução real (PRs 1 e 2 mergeados).
- Fase 2 implementada (PR 3): 90 testes (53 pytest + 7 motor no emulador + 12 lógica Node + 7 regras
  + 11 Functions no emulador) + teste de fumaça da página no Chromium com emuladores.
- Configuração da Fase 2 feita pelo Breno (site: https://mapaleads-rn.netlify.app). 1º teste real: login falhou
  (502 em /api/config-publica, ERR_REQUIRE_ESM) → corrigido no PR 4 (firebase-admin 13.10.0).
  2º teste: login ok, criar-busca 500 no acesso ao Firestore → PR 5 (Firestore via REST + log detalhado + diagnóstico).
- PRs 5–8: Firestore REST, chave privada normalizada, diagnóstico criar_e_cancelar — Fase 2 validada em produção.
- **Fase 3a (PR 9)**: tela definitiva + perfis + saúde do motor + despertador + disjuntor novo + estatísticas.
- **PR 11**: bug de sessão corrigido + relevância do segmento (categorias, sinônimos, sem cidade).
- **Fase 3a v2 (tela nova)**: Etapa 0 aprovada com ajustes; todas as telas no PR 12 (deploy preview) — aguardando a
  aprovação visual do Breno (capturas 1366 e celular) antes do merge; depois CI verde + teste real → merge.
  Testes: pytest do motor, lógica Node, regras, Functions (fonte e empacotadas), motor no emulador e tela no Chrome.
- Ainda não medido de verdade: tempos de normal/completa e com e-mail; confirmação do "fim real" no scraper real.

## Fase 3 — Nordeste (decisão do Breno; próximo PR depois da 3a — apresentar plano antes de implementar)
- O sistema **não pode ficar travado no RN**. **UF vira campo** em buscas (parâmetros e consultas), leads
  (`uf`), regiões, filtros, estatísticas e nomes de arquivo (`segmento-UF-data` no lugar de `segmento-RN-data`).
- Carregar municípios e microrregiões (e regiões imediatas) dos **9 estados do Nordeste** (AL, BA, CE, MA, PB,
  PE, PI, RN, SE) pela **API oficial de Localidades do IBGE** em `dados/ibge_nordeste.json` (coleta por workflow
  temporário, como no RN; o proxy do ambiente de dev bloqueia o IBGE).
- Tela: seletor **Estado → Microrregião → Cidade** (mantendo micro/imediata e o desmarcar cidade a cidade).
- **"RN inteiro" vira "Estado inteiro"** (só admin, bloqueado no servidor; não conta no limite diário).
- **Só os estados que o Breno ativar** aparecem na tela: lista de UFs ativas numa config (ex.: `config/geral.ufs_ativas`,
  gravada só pelo servidor/admin) e conferida também no servidor ao criar busca.
- Cuidados já identificados: nomes de município repetidos entre estados (ex.: Santa Cruz RN/PE, "Santa Luzia")
  → cidade sempre identificada por **código IBGE + UF**; `cidade_confere` passa a comparar cidade **e** UF;
  dedup continua por id_lugar. Dados atuais do RN (buscas/leads sem `uf`) contam como RN.
- **Decisão do Breno (após o PR 9): por enquanto SÓ O RN ativo.** Deixar a estrutura pronta — campo UF,
  cidade por código IBGE + UF, config de estados ativos (só `RN` ligado) — sem ativar outro estado.
- **Adiado para quando o Breno for ativar outro estado** (perguntar nessa hora, não antes): (1) faixas de
  profundidade por população (Censo 2022, SIDRA t4709) fora do RN — mesmas do RN?; (2) quais capitais/cidades
  grandes por bairro (malha de bairros IBGE CD2022) e a partir de qual população; (3) limite ou aviso de tempo
  para estados grandes (ex.: BA, 417 municípios, muitas horas por termo). "Estado inteiro" de outra UF só
  depois dessas respostas.
- Fase 3c (Oportunidades x IBGE, mapa) passa a valer por estado.

## Fase 3b (registrada, NÃO implementar antes de aprovar)
- **Enriquecimento por CNPJ** (Receita Federal, Dados Abertos do CNPJ): baixar/filtrar só o RN no GitHub
  Actions; casar lead ↔ estabelecimento por telefone, por nome + município e por CEP; mostrar selo de
  **confiança** do casamento; **nunca mostrar sócios**. Custo zero (arquivos públicos + Actions).
- **Pontuação de leads (lead scoring)**: regras e pesos definidos pelo Breno (perguntar antes).
- **Mini-CRM**: status do lead (ex.: novo / contatado / negociando / cliente / descartado) — gravação só
  pelo servidor (Function), respeitando a cota do Firestore.

## Fase 3c (registrada, NÃO implementar antes de aprovar)
- **Aba "Oportunidades x IBGE"** (pedido do Breno em 23/09): cruza os leads de um segmento com dados do IBGE
  por município do RN — qtd de leads, leads por 10 mil habitantes, % com WhatsApp, destaque de cidades com
  poucos estabelecimentos para o tamanho da população (possível mercado pouco atendido). Tabela ordenável +
  mapa do RN colorido por município. Só CDN, custo zero, sem leituras pesadas no Firestore (usar os leads
  da busca-mãe já consolidada); números do IBGE em arquivo fixo no repo. **Só dados reais** (IBGE oficial +
  leads coletados), nada estimado. **Antes de implementar: perguntar ao Breno quais indicadores do IBGE usar
  (população, PIB per capita, etc.) e a fonte exata de cada um.** A malha geográfica do mapa também
  precisa de fonte oficial (IBGE) — confirmar com ele.
- **Relatório de mercado em PDF** gerado no navegador (mesmas regras: só dados reais, fontes citadas).

## Fase 4 — Comercialização (registrada; NÃO implementar agora)
Objetivo do Breno: vender o sistema por **assinatura de R$ 19,99/mês**.
**Antes de começar a Fase 4: apresentar ao Breno a análise de custo x receita por nº de clientes, para ele decidir.**
- **Cadastro público** (hoje só o admin cria usuários) com confirmação de e-mail.
- **Cobrança recorrente**: Asaas, Mercado Pago ou Stripe (comparar taxas por transação/Pix/boleto/cartão,
  webhooks, split, custo fixo) — escolha do Breno.
- **Bloqueio de acesso por assinatura vencida** (conferido no servidor em toda Function, não só na tela;
  status da assinatura atualizado por webhook do meio de pagamento).
- **Plano de cotas por assinante** (buscas/dia, profundidade, e-mail, estados liberados, "Estado inteiro"?) —
  valores de negócio definidos pelo Breno.
- **Política de privacidade (LGPD) e termos de uso**: base legal para tratar dados de estabelecimentos,
  direitos do titular, retenção/exclusão, encarregado (DPO), uso aceitável.
- **Migração de infraestrutura**: motor **fora do GitHub Actions gratuito** (uso comercial e escala: ex.
  VPS/Cloud Run/fila própria), Firebase **Blaze** (já ativo) com cotas e alertas, Netlify (limites do Free),
  repositório possivelmente privado (Actions deixa de ser ilimitado).
- **Estimativa de custo mensal por nº de clientes** (ex.: 10 / 50 / 100 / 500): execução do motor (horas de
  máquina por busca medidas em `config/metricas`), leituras/gravações do Firestore, Functions, e-mail,
  taxas do meio de pagamento e impostos → margem por assinante x R$ 19,99.
- Riscos a apresentar junto com a análise: termos de uso do Google Maps para coleta automatizada, bloqueios
  por volume maior (IPs/proxies), e responsabilidade sobre os dados vendidos.
