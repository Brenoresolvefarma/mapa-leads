# MapaLeads

Prospecção B2B multiusuário via Google Maps, 100% na nuvem e com **custo zero**
(GitHub Actions em repositório público + Firebase plano Spark + Netlify Free).

> **Estado atual: Fase 1** — motor no GitHub Actions gravando no Firestore,
> disparado manualmente pelo botão **Run workflow**. Login, fila pela tela,
> limite diário (Fase 2) e a tela HTML (Fase 3) ainda não existem.

## Como funciona (Fase 1)

1. Você abre **Actions › Motor MapaLeads › Run workflow** e preenche:
   - **termos**: vários, separados por vírgula (ex.: `home care, cuidador de idosos`);
   - **cidades**: várias, separadas por vírgula (padrão `Natal RN`);
   - **extrair e-mail**: marca se quiser (a busca fica ~2× mais lenta);
   - **profundidade**: `rapida` (~20 lugares por consulta), `normal` (~60) ou `completa` (até ~120, o teto do Google).
2. O motor cria a busca no Firestore (`status: na_fila`), pega a busca mais antiga da fila,
   marca `rodando` e roda o scraper [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
   (Docker, versão fixa `v1.18.1`) uma vez para cada combinação **termo × cidade**.
3. Os dados são tratados:
   - duplicados removidos (ID do lugar no Google; na falta, nome + telefone);
   - telefone no formato `(84) 99999-9999` e link `wa.me` quando é celular;
   - Instagram só quando o site cadastrado no Maps é um perfil do Instagram;
   - **nada é inventado**: campo não encontrado fica vazio.
4. Os leads são gravados no Firestore e a busca fica `concluida` (ou `erro`, com mensagem clara).

### Tempo estimado por busca

Por consulta (termo × cidade), além de ~1,5 min de preparo por execução:

| Profundidade | Sem e-mail | Com e-mail |
|---|---|---|
| Rápida (~20) | ~1–2 min | ~2–3 min |
| Normal (~60) | ~3–4 min | ~5–7 min |
| Completa (~120) | ~5–7 min | ~9–13 min |

### Vigia de tempo (nenhuma consulta fica presa)

O scraper às vezes não encerra sozinho. Cada consulta roda sob uma vigia que encerra o
container e **aproveita os leads já coletados** (o scraper grava cada lead assim que o encontra):

| Profundidade | Limite sem e-mail | Limite com e-mail |
|---|---|---|
| Rápida | 6 min | 12 min |
| Normal | 12 min | 24 min |
| Completa | 20 min | 40 min |

Além do limite, a consulta é encerrada se **não gravar nenhum lead nos primeiros 5 min** ou se
ficar **3 min sem gravar lead novo**. Consulta encerrada com leads = aviso "encerrada por tempo"
na busca (status `concluida`); só vira `erro` se todas as consultas terminarem sem nenhum lugar.

Para cada consulta, o log mostra só um diagnóstico em números, por exemplo:
`término: sozinha (código 0), 142s, etapas ok=21 falhas=0, inatividade=não, consentimento=não`.
A telemetria do scraper fica desligada (`DISABLE_TELEMETRY=1`).

Cada busca grava `duracao_segundos` no Firestore para calibrarmos esses números com dados reais.
Minutos do Actions são gratuitos e ilimitados em repositório público; uma execução pode durar
até ~5h50 (limite configurado).

## Onde ficam os dados (Firestore)

- `buscas/{id}` — dono, data, status (`na_fila`, `rodando`, `concluida`, `erro`), parâmetros,
  progresso (`2/6`), resumo (total, com telefone, com e-mail, com site, com WhatsApp),
  aviso, mensagem de erro, duração.
- `buscas/{id}/lotes/{0,1,2…}` — até 300 leads por documento, com os campos:
  `nome, categoria, telefone, whatsapp_link, email, site, instagram, endereco, cidade,
  nota, qtd_avaliacoes, link_maps, termo_que_encontrou`.

Guardar os leads em lotes é o que mantém o projeto dentro da cota grátis do Firestore
(50 mil leituras / 20 mil gravações por dia): uma busca de 300 leads custa **1 gravação**
para salvar e **1 leitura** para abrir, em vez de 300.

## Privacidade (repositório público)

- Os logs do Actions mostram **só contagens e status**. Nunca dados de leads, termos ou tokens.
- A saída bruta do scraper fica num arquivo temporário do runner e é apagada ao final.
- Não há upload de artefatos nem commit de resultados: os dados vão só para o Firestore.
- Os campos do formulário são lidos pelo motor direto do evento do GitHub (não aparecem no
  cabeçalho do log). Eles ficam visíveis na página da execução para quem abrir o Actions,
  por isso na Fase 2 a tela passará a enviar só o ID da busca.

## Configuração (na ordem)

### 1. Firebase (plano Spark — sem cartão)

Nunca clique em "Fazer upgrade" / plano Blaze. Tudo aqui funciona no Spark.

1. Acesse <https://console.firebase.google.com> › **Adicionar projeto** › nome `mapaleads`
   (pode desativar o Google Analytics).
2. **Criação › Firestore Database › Criar banco de dados** › modo **produção** ›
   local `southamerica-east1 (São Paulo)`.
3. Na aba **Regras** do Firestore, cole o conteúdo de [`firestore.rules`](firestore.rules) e clique **Publicar**.
4. **Criação › Authentication › Vamos começar** › método **E-mail/senha** › ativar.
5. Em **Authentication › Usuários › Adicionar usuário**, crie o seu usuário (e-mail e senha)
   e copie o **UID** que aparece na lista.
6. **Configurações do projeto (engrenagem) › Contas de serviço › Gerar nova chave privada**.
   Um arquivo `.json` será baixado. **Não envie esse arquivo para o repositório nem para ninguém.**

### 2. GitHub

Em **github.com/Brenoresolvefarma/mapa-leads › Settings › Secrets and variables › Actions**:

| Tipo | Nome | Valor |
|---|---|---|
| Aba **Secrets** › New repository secret | `FIREBASE_SERVICE_ACCOUNT` | conteúdo **inteiro** do arquivo `.json` da chave (abra no bloco de notas, copie tudo, cole) |
| Aba **Variables** › New repository variable | `MAPALEADS_ADMIN_UID` | o seu UID do passo 1.5 |

Depois de cadastrar o secret, apague o `.json` do seu computador (ou guarde em local seguro).

### 3. Rodar uma busca

1. **Actions › Motor MapaLeads › Run workflow** (branch `main`).
2. Preencha os campos e clique **Run workflow**.
3. Acompanhe o status no log (só contagens) e veja os dados no console do Firebase:
   **Firestore › buscas › (documento) › lotes**.

O botão **Run workflow** só aparece quando o workflow está na branch padrão (`main`).

## Desenvolvimento

```bash
pip install -r motor/requirements.txt -r motor/requirements-dev.txt
cd motor && pytest -q
```

Os testes usam somente dados fictícios e rodam automaticamente no workflow **Testes** a cada push/PR.

## Estrutura

```
.github/workflows/motor.yml   # motor (workflow_dispatch + fila por concurrency)
.github/workflows/testes.yml  # pytest a cada push/PR
motor/motor.py                # fila, status, scraper, gravação no Firestore
motor/tratamento.py           # limpeza dos dados (funções puras)
motor/vigia.py                # vigia de tempo do scraper + diagnóstico em números
motor/test_*.py               # testes
firestore.rules               # regras de segurança (Fase 1: navegador sem acesso)
```
