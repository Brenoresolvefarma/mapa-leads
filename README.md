# MapaLeads

Prospecção B2B multiusuário via Google Maps, 100% na nuvem e com **custo zero**
(GitHub Actions em repositório público + Firebase plano **Spark** + Netlify **Free**).

> **Estado atual: Fase 2** — login, Netlify Functions, regras de segurança, fila com
> prioridade, limite diário, RN inteiro e uma **página de teste** simples.
> A tela definitiva (tabela de leads, download .xlsx, painel completo) vem na **Fase 3**.

## Como funciona

```
Navegador (publico/index.html) ──login──> Firebase Auth
      │  (ID token)
      ▼
Netlify Functions (/api/...) ──valida token, limite, admin──> Firestore (buscas na fila)
      │  dispara
      ▼
GitHub Actions "Motor MapaLeads" ──esvazia a fila──> scraper (Docker) ──> Firestore (leads em lotes)
```

- **Busca comum** (qualquer usuário): termos e cidades livres, profundidade, e-mail sim/não.
  Conta no **limite diário** (padrão **20 por dia**, o admin muda por usuário; o dia vira à
  meia-noite de **Fortaleza/Natal**).
- **RN inteiro** (**só admin**, bloqueado no servidor): um segmento nos 167 municípios do RN.
  Não conta no limite diário. Detalhes abaixo.
- **Fila sem perda e sem travar ninguém**: buscas comuns passam na frente dos lotes do RN
  (o motor olha a fila antes de cada consulta do RN); entre usuários comuns, a fila alterna
  por dono. A tela mostra a posição na fila e o tempo estimado de espera.
- **Cancelar**: na fila, cancela na hora; rodando, para antes da próxima consulta e guarda os
  leads já coletados. No RN inteiro, cancela os lotes que faltam e fecha com o que já veio.

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
- **Disjuntor**: 3 consultas seguidas sem nenhum lead pausam o RN por 30 min (possível
  bloqueio); as buscas comuns continuam. Obs.: município pequeno sem nenhum resultado também
  conta como "vazia".
- 2 execuções em paralelo: código pronto, **desligado** (`MOTOR_PARALELO: "false"` no workflow).

### Custo zero e cotas do Firestore (50 mil leituras / 20 mil gravações por dia)
- Leads gravados em **lotes de 300 por documento**: uma busca de 300 leads = 1 gravação.
- A lista de buscas lê só os 20 documentos mais recentes (o resumo fica no documento da busca).
- Um RN inteiro ≈ 600–800 gravações. O agendamento de 15 em 15 min com fila vazia ≈ 8 leituras
  por execução e não grava nada se a fila não mudou.
- Se a cota estourar, o plano Spark só bloqueia até o dia seguinte — nunca cobra.

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
- Usuário removido: a conta é apagada, as buscas dele ficam visíveis para o admin (marcado "removido").
- Não há cadastro público nem "promover a admin" pela tela.

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
2. **Firestore › Índices › Composto › Criar índice** (2 índices, coleção `buscas`, escopo Coleção):
   - `lista` Crescente, `dono_uid` Crescente, `criada_em` Decrescente;
   - `lista` Crescente, `criada_em` Decrescente.
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

## Verificação em produção (GitHub Actions, manual)
- **Verificar Functions**: chama as 4 Functions no ar sem login (espera 200/401/405). Só status no log.
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
```
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
netlify/functions/    # criar-busca, cancelar-busca, admin-usuarios, config-publica
netlify/lib/          # lógica pura (testável) + utilidades de servidor
dados/                # municípios (Censo 2022) e bairros oficiais (IBGE)
publico/index.html    # página TEMPORÁRIA de teste da Fase 2
firestore.rules, firestore.indexes.json, firebase.json, netlify.toml
testes/               # testes Node (lógica, regras, Functions)
```
