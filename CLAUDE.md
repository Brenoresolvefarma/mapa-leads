# CLAUDE.md — contexto do projeto MapaLeads

## O que é
Sistema multiusuário de prospecção B2B via Google Maps para o Breno (prospecção comercial, RN).
Admin (Breno) + usuários comuns. Buscas sob demanda: termos e cidades livres, e "RN inteiro" (só admin).

## Regras de trabalho combinadas com o Breno
- Mostrar o plano e esperar autorização antes de criar/alterar arquivos.
- Perguntar quando algo for ambíguo; **não definir valores de negócio** sem perguntar.
- **Custo ZERO obrigatório**: só repo público (Actions grátis), Firebase **Spark** (sem cartão, sem Blaze,
  sem Cloud Functions), Netlify Free. Qualquer coisa que exija plano pago: avisar antes e propor alternativa.
- Respeitar a cota grátis do Firestore (50 mil leituras / 20 mil gravações por dia) no motor e na tela.
- Nunca colocar tokens/chaves/senhas no código (secrets do GitHub / env vars do Netlify).
- Código simples, comentado em português.
- Ao fim de cada fase: atualizar README.md e CLAUDE.md; passar passo a passo de configuração.
- Trabalhar na branch designada, abrir PR para `main` e **nunca fazer merge sozinho** (o Breno faz).
- Repositório PÚBLICO: nunca logar dados de leads, termos, cidades, UID ou tokens; sem upload-artifact;
  sem commit de CSV/JSON de resultados; temporários apagados do runner.
- Só dados reais (IBGE oficial + leads coletados); nada estimado apresentado como dado.

## Arquitetura
1. Tela HTML single-file (CDN) no Netlify — Fase 3 (hoje: `publico/index.html` = página de TESTE da Fase 2).
2. Firebase Auth e-mail/senha, sem cadastro público (admin cria/remove) — **Fase 2 (feito)**.
3. Netlify Functions (`/api/criar-busca`, `/api/cancelar-busca`, `/api/admin-usuarios`, `/api/config-publica`):
   guardam token do GitHub e credencial admin do Firebase; validam ID token (checkRevoked) — **Fase 2 (feito)**.
4. Motor: GitHub Actions (`workflow_dispatch` + `schedule` */15) — Fases 1 e 2 (feito).
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
- **Disjuntor**: 3 consultas seguidas sem nenhum lead no RN → pausa de 30 min (mãe + filhas na fila com
  `pausada_ate`), consultas restantes voltam à fila. Município pequeno sem resultado também conta.
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
- **Netlify**: credencial do Firebase em 3 variáveis (limite de tamanho das env vars de Functions);
  token GitHub fine-grained só com Actions RW. Config web pública via `/api/config-publica`.
- Datas na tela sempre em America/Fortaleza.

## Pendente para o próximo PR (decidido pelo Breno em 24/09)
- **Disjuntor**: cidade pequena sem resultado NÃO conta como sinal de bloqueio. Só contar consulta vazia se
  o scraper também teve falha/erro (motivo da vigia ≠ fim normal, ou código de erro) OU se a cidade tem
  mais de 20 mil habitantes (Censo 2022). Consultas por bairro (Natal/Mossoró/Parnamirim) contam como > 20 mil.
- Somar a isso o que aparecer no teste real da Fase 2.

## Estado atual
- Fase 1 concluída e validada com execução real (PRs 1 e 2 mergeados).
- Fase 2 implementada (PR 3): 90 testes (53 pytest + 7 motor no emulador + 12 lógica Node + 7 regras
  + 11 Functions no emulador) + teste de fumaça da página no Chromium com emuladores.
- Configuração da Fase 2 feita pelo Breno (site: https://mapaleads-rn.netlify.app). 1º teste real: login falhou
  (502 em /api/config-publica, ERR_REQUIRE_ESM) → corrigido no PR 4 (firebase-admin 13.10.0).
- Pendente: validação real
  (busca comum pela página, limite, 403 no RN para usuário comum, preempção durante RN, cancelamento).
- Ainda não medido de verdade: tempos de normal/completa e com e-mail; confirmação do "fim real" no scraper real.

## Pendências da Fase 3 (não implementar antes)
- Tela definitiva single-file (login, nova busca, minhas buscas com filtro "só da cidade pedida" ligado
  por padrão, tabela de leads, download .xlsx no navegador `segmento-cidade-data.xlsx` / `segmento-RN-data.xlsx`
  com coluna `cidade_confere`, painel admin).
- **Aba "Oportunidades x IBGE"** (pedido do Breno em 23/09): cruza os leads de um segmento com dados do IBGE
  por município do RN — qtd de leads, leads por 10 mil habitantes, % com WhatsApp, destaque de cidades com
  poucos estabelecimentos para o tamanho da população (possível mercado pouco atendido). Tabela ordenável +
  mapa do RN colorido por município. Só CDN, custo zero, sem leituras pesadas no Firestore (usar os leads
  da busca-mãe já consolidada); números do IBGE em arquivo fixo no repo. **Só dados reais** (IBGE oficial +
  leads coletados), nada estimado. **Antes de implementar: perguntar ao Breno quais indicadores do IBGE usar
  (população, PIB per capita, etc.) e a fonte exata de cada um.** A malha geográfica do mapa também
  precisa de fonte oficial (IBGE) — confirmar com ele.
