# CLAUDE.md — contexto do projeto MapaLeads

## O que é
Sistema multiusuário de prospecção B2B via Google Maps para o Breno (prospecção comercial, RN).
Admin (Breno) + usuários comuns. Buscas sob demanda: termos e cidades livres.

## Regras de trabalho combinadas com o Breno
- Mostrar o plano e esperar autorização antes de criar/alterar arquivos.
- Perguntar quando algo for ambíguo; **não definir valores de negócio** (ex.: limite diário) sem perguntar.
- **Custo ZERO obrigatório**: só repo público (Actions grátis), Firebase **Spark** (sem cartão, sem Blaze,
  sem Cloud Functions), Netlify Free. Qualquer coisa que exija plano pago: avisar antes e propor alternativa.
- Respeitar a cota grátis do Firestore (50 mil leituras / 20 mil gravações por dia) no motor e na tela.
- Nunca colocar tokens/chaves/senhas no código (secrets do GitHub / env vars do Netlify).
- Código simples, comentado em português.
- Ao fim de cada fase: atualizar README.md e CLAUDE.md; passar passo a passo de configuração.
- Trabalhar na branch designada, abrir PR para `main` e **nunca fazer merge sozinho** (o Breno faz).
- Repositório PÚBLICO: nunca logar dados de leads, conteúdo da busca ou tokens; sem upload-artifact;
  sem commit de CSV/JSON de resultados; temporários apagados do runner.

## Arquitetura (alvo)
1. Tela HTML single-file (CDN) no Netlify — Fase 3.
2. Firebase Auth e-mail/senha, sem cadastro público (admin cria/remove) — Fase 2.
3. Netlify Functions: guardam token do GitHub e credencial admin do Firebase; validam ID token — Fase 2.
4. Motor: GitHub Actions (`workflow_dispatch`) — **Fase 1 (feito)**.
5. Banco: Firestore.

## Decisões tomadas
- **Scraper**: `gosom/google-maps-scraper:v1.18.1` (Docker Hub, fixado). Flags usadas: `-input -results -json
  -depth -c 4 -lang pt-BR -exit-on-inactivity 3m [-email]`. Saída JSON por linha; campos usados:
  `title, category, categories, phone, web_site, emails, address, complete_address.city, review_rating,
  review_count, link, place_id, cid, input_id`.
- **Profundidade** (3 níveis, padrão Normal): rapida=`-depth 1` (~20), normal=`-depth 5` (~60),
  completa=`-depth 10` (até ~120, teto do Google).
- **Extrair e-mail**: padrão Não.
- **Papéis**: Custom Claims (`admin: true`) gravadas só pelo servidor (Admin SDK nas Netlify Functions);
  limite diário e perfil em `/usuarios/{uid}`, gravável só pelo servidor. (Implementar na Fase 2.)
- **Scraper roda uma vez por consulta** (termo × cidade): dá progresso "n/N" e isola falhas.
  A dedup entre consultas é feita no Python (place_id → cid → nome+telefone normalizado);
  termos que encontraram o mesmo lugar são juntados em `termo_que_encontrou`.
- **Leads em lotes** de 300 por documento (`buscas/{id}/lotes/{n}`) para caber na cota do Firestore.
  Resumo fica no doc da busca (lista de buscas não lê leads).
- **Fila sem perda**: `concurrency: mapaleads-motor` + `cancel-in-progress: false`; o motor esvazia a fila
  (transação pega a `na_fila` mais antiga; ordenação no Python para evitar índice composto).
  Ao iniciar, buscas em `rodando` são órfãs (só roda um motor por vez) → marcadas `erro`.
- Telefone: celular (DDD + 9 dígitos começando com 9) → `(84) 99999-9999` + `https://wa.me/55…`;
  fixo (10 dígitos) → `(84) 3333-3333`; número antigo de 8 dígitos NÃO ganha o 9; resto fica como veio.
- Instagram: só quando `web_site` é instagram.com (o scraper não traz Instagram de outro jeito).
- Nota 0 do scraper = sem nota → `None`.
- Inputs do formulário são lidos de `GITHUB_EVENT_PATH` (não aparecem no cabeçalho do log).
- `firestore.rules` na Fase 1 nega tudo ao navegador.
- **Vigia de tempo** (`motor/vigia.py`), aprovada pelo Breno após a 1ª execução real travar
  (run 35865786166, cancelada após ~14 min parada na consulta 1):
  - Causa provável (lida no código da v1.18.1/scrapemate v1.4.0): o scraper só encerra quando os contadores
    lugares encontrados = concluídos batem; senão depende do `-exit-on-inactivity`, e mesmo assim espera
    todos os workers/abas do navegador terminarem (`wg.Wait`) — uma aba travada prende o processo.
    Além disso, o `subprocess.run(timeout=...)` antigo matava só o cliente `docker`, não o container.
  - Limite rígido por consulta: rapida 6 / normal 12 / completa 20 min (×2 com e-mail).
    Encerra também se nenhum lead em 5 min ou 3 min sem lead novo. Parada via `docker stop`/`kill`
    pelo nome do container; leads já gravados são aproveitados (jsonwriter grava cada lead na hora).
  - Consulta encerrada com leads → aviso "encerrada por tempo" (status `concluida`); todas sem leads → `erro`.
  - `DISABLE_TELEMETRY=1` no container (scraper enviava telemetria ao PostHog por padrão).
  - Diagnóstico no log só com números: motivo de término, código, segundos, etapas ok/falhas
    (linhas "scrapemate stats"), inatividade sim/não, consentimento sim/não.

## Estado atual
- Fase 1 implementada: `motor/`, `.github/workflows/motor.yml`, `.github/workflows/testes.yml`,
  `firestore.rules`. Vigia de tempo adicionada (PR 2). 35 testes pytest passando (dados fictícios).
- Firebase e secrets do GitHub já configurados pelo Breno; motor conecta e cria a busca.
- Pendente: execução real completa após o merge da vigia; recalibrar tabela de tempos com
  `duracao_segundos` reais e checar o diagnóstico (inatividade/consentimento).

## Próximos passos (Fase 2 — só após aprovação)
- Perguntar ao Breno: limite diário padrão por usuário; fuso para "dia" (sugestão America/Fortaleza).
- Netlify Functions: criar busca (valida ID token + limite diário via contador em `/usuarios/{uid}`),
  disparar workflow com `busca_id`, CRUD de usuários + custom claims (admin).
- Regras do Firestore completas (dono lê o próprio; admin lê tudo; leads nunca gravados pelo navegador).
- `schedule` de segurança no motor para processar buscas que ficarem na fila; manter tudo no plano grátis.
