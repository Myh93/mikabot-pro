# Arquitetura do MikaBot PRO v2.0 Stable

## ETAPA 9.1.3 — Fila Privada de Aprovação de Links

Mensagens privadas e comandos reutilizam o contexto central, `linkApprovalFlowService`, `linkApprovalService`, `moderationService` e o banco único `pendingLinks`. Nenhum listener adicional foi criado. Solicitações usam sessões isoladas, expiração sob demanda e transições atômicas `pending → publishing → published`, com rollback para `pending` em falha de envio.

Somente o MikaBot publica o link sanitizado no grupo. A própria mensagem do bot é reconhecida pelo Antilink como autorizada. Recibos impedem notificações e publicações duplicadas.

## Antilink e banimentos — ETAPA 9.1.2

O listener central existente encaminha mensagens de grupo ao `antiLinkService`, que usa `moderationService` e `moderationRepository`. O detector considera texto e legendas, extrai o domínio efetivo, aplica blacklist/whitelist por escopo e nunca acessa a URL. Advertências automáticas reutilizam a contagem e os recibos centrais. Banimentos ficam em `bans` no mesmo JSON e são lógicos.

A função de bloqueio de reentrada está preparada, mas não foi conectada porque não existe evento central seguro de entrada. Nenhum listener foi acrescentado.

## Visão geral

O projeto usa CommonJS e separa entrada, comandos, eventos, serviços, repositórios e persistência local.

```text
WhatsApp
   ↓
index.js
   ↓
loader.js ──→ commands/
   │
   └───────→ events/
                 ↓
              services/
                 ↓
            repositories/
                 ↓
             database/
```

## Camadas

### Entrada e carregamento

- `index.js`: inicialização do cliente e conexão com o Loader.
- `src/loader.js`: descoberta de comandos, criação de contexto, permissões e encaminhamento aos handlers já registrados.
- `src/utils/platformContext.js`: contexto normalizado da mensagem.

### Comandos

Os arquivos em `src/commands` declaram `name`, `aliases` e `execute`. Eles validam o contexto imediato e delegam regras aos serviços. Comandos com mais de uma palavra são resolvidos pelo Loader sem eliminar aliases antigos.

### Eventos e fluxos guiados

- `quizAnswer.js`: respostas das rodadas do Quiz.
- `menuAnswer.js`: escolhas em menus ativos.
- `guidedFlowAnswer.js`: fluxo privado de Eventos.
- `registrationGuidedFlowAnswer.js`: Cadastro, Privacidade e Edição do Cadastro.

Não há listeners dentro dos serviços. Os handlers reutilizam os listeners centrais existentes.

### Serviços

- `inputResolverService`: normalização central de números, texto, aliases e navegação.
- `messageStyleService`: separador e estados visuais compartilhados.
- `identityService`: identidades equivalentes e nome público seguro.
- `registrationService`: validação e gravação do Cadastro 2.0.
- `registrationGuidedFlowService`: coordenação dos fluxos privados do cadastro.
- `registrationEditFlowService`: edição parcial com salvamento imediato.
- `registrationPublicQueryService`: projeção pública e aplicação da privacidade.
- Serviços de Quiz, Maratona, jogador, Raids e Eventos contêm suas regras de domínio.

### Repositórios

Os repositórios encapsulam arquivos, envelopes, validação, índices, histórico, escrita atômica e backup. Serviços não escrevem JSON diretamente.

Principais garantias:

- escrita em arquivo temporário seguida de substituição;
- filas por base para serializar mutações;
- validação antes e depois das alterações;
- índices reconstruídos a partir dos registros;
- checksums SHA-256 em bases versionadas;
- backups validados antes de restauração.

## Persistência

| Área | Diretório/arquivo principal |
|---|---|
| Cadastro | `src/database/registrations/` |
| Quiz | `src/database/quiz/` |
| Maratona | `src/database/quiz-marathon/` |
| Progressão | `src/database/player-progress/` |
| Eventos | `src/database/events/` |
| Raids | `src/database/raids.json` |
| Menus | `src/database/menus/` |
| Fluxos guiados | `src/database/guided-flows/` |
| Diretório de grupos | `src/database/groups/` |

Arquivos legados permanecem disponíveis somente para compatibilidade e migrações controladas.

## Cadastro 2.0

Um registro possui identidade, dados pessoais, `mainAccount`, `secondaryAccounts`, contatos, preferências e privacidade. `mainAccount.nick` é a identidade pública. Cadastros antigos são normalizados durante a leitura.

Fluxos privados:

```text
!cadastro ────────→ cadastro completo → revisão → confirmação
!privacidade ─────→ escolha do campo → gravação imediata
!editarcadastro ──→ seção/campo → validação → confirmação crítica → gravação
```

## Resolução de entradas

Fluxos guiados utilizam `inputResolverService` para:

- normalizar caixa, acentos e espaços;
- resolver Sim/Não;
- resolver menu, voltar, repetir e cancelar;
- resolver opções e aliases de comandos.

## Privacidade

`registrationPublicQueryService` consulta as preferências normalizadas. Friend Code e contas secundárias podem ser ocultados. A exceção é somente a consulta feita pelo próprio dono.

## Testes

Os testes usam `node:test`, bases temporárias e instâncias injetadas. A regressão cobre serviços, repositórios, comandos, fluxos, integridade, concorrência, backups e compatibilidade.

## Central de Moderação — v2.1 em desenvolvimento

A ETAPA 9.1.0 adiciona somente uma fundação isolada:

```text
Comandos e detectores futuros
   ↓
moderationService
   ↓
moderationRepository
   ↓
data/moderation/moderation.json
```

O banco único possui configurações por grupo, advertências preparadas, histórico paginado, links pendentes, whitelist, blacklist, reputação e recibos sequenciais. O repositório fornece escrita atômica, fila, manifesto, checksum, backups e recuperação segura.

O serviço normaliza domínios, classifica links localmente e remove credenciais de URLs antes do histórico. Não realiza requisições externas e não apaga mensagens.

### Advertências manuais — ETAPA 9.1.1

```text
!warn / !warnings / !resetwarn / !clearwarns
   ↓
resolução segura de identidade e permissão existente
   ↓
moderationService
   ↓
moderationRepository
```

Menções e mensagens respondidas são resolvidas pelos metadados do WhatsApp. O serviço protege bot, autor, dono e administradores, controla idempotência por hash do `messageId`, conta somente advertências ativas e registra o primeiro cruzamento do limite. O reset usa uma sessão isolada no `guidedFlowService` e o encaminhador central já existente, sem listener adicional.

O limite apenas produz aviso e histórico `warning_limit_reached`. Nenhuma expulsão, remoção ou forma de silenciamento foi implementada.
