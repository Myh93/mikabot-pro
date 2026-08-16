# Catálogo oficial de configurações — MikaBot PRO

Versão documental: 1.0.0  
Etapa: 3.5A.1  
Estado: catálogo sem integração funcional

Este documento define os nomes oficiais das chaves que poderão ser atendidas
futuramente pelo Centro de Configurações. Ele não é carregado pelo bot, não
altera defaults e não autoriza migração de consumidores ou persistência.

## Convenções

- Chaves usam `camelCase` e o formato `namespace.subNamespace.property`.
- O namespace identifica o domínio proprietário.
- Nomes completos são únicos.
- Não são usadas abreviações ambíguas como `ttl`, `cfg`, `mod` ou `req`.
- Durações incluem a unidade no nome: `Milliseconds`, `Seconds`, `Minutes` ou
  `Days`.
- Uma chave ausente é diferente de `false`, `0`, `null` ou string vazia.
- Escopos oficiais: `global`, `community`, `platform`, `group`, `runtime` e
  `invariant`.
- `runtime` é temporário e nunca é persistido.
- `invariant` representa contrato técnico e nunca permite override.
- Precedência futura, quando autorizada:
  `runtime > group > platform > community > global > default`.
- Uma chave só pode participar dos escopos explicitamente indicados.

## Sensibilidade

| Classe | Definição | Persistência futura |
|---|---|---|
| Pública | Pode ser exibida sem expor operação interna ou pessoas. | Permitida |
| Operacional | Controla comportamento do bot, mas não é credencial. | Permitida com auditoria |
| Restrita | Identifica pessoas, grupos ou regras críticas. | Somente armazenamento protegido |
| Segredo | Token, senha, chave, cookie, sessão ou credencial. | Proibida no banco de configurações |

## Regras de override

- `Sim`: pode receber override apenas nos escopos indicados.
- `Não`: possui valor único e não pode ser alterada pelo Centro.
- `Invariante`: integra schema, persistência ou regra estrutural.
- Chaves de owner protegida nunca podem ser alteradas por configuração de
  comunidade, plataforma ou grupo.
- Chaves de segurança exigirão autorização e auditoria próprias.
- Nenhum override pode mudar silenciosamente um comportamento legado.

## Namespace `system`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `system.commandPrefix` | Prefixo dos comandos do bot. | string não vazia | `!` | global | Loader | Loader e comandos | `config.json` | Operacional | Sim | legado |
| `system.applicationName` | Nome público da aplicação. | string | `MikaBot PRO` | global | Inicialização | Mensagens institucionais | textos do projeto | Pública | Sim | reservado |
| `system.applicationVersion` | Versão pública do bot. | semver | versão do pacote | global | Inicialização | Logs e diagnóstico | `package.json` e texto do boot | Pública | Não | reservado |
| `system.defaultTimezone` | Fuso padrão para domínios que não definem fuso próprio. | timezone IANA | `America/Fortaleza` | global, community | Sistema | futuros adaptadores | constantes espalhadas | Operacional | Sim | novo |
| `system.runtimeEnvironment` | Ambiente de execução. | enum | não definido | runtime | Inicialização | Logs e diagnóstico | inexistente | Operacional | Não | reservado |

## Namespace `permissions`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `permissions.protectedOwnerNumber` | Identidade da única owner principal protegida. | identidade canônica | valor protegido existente | global | Permission Service | Permissões, Moderação e Disciplina | `config.json` | Restrita | Não | legado |
| `permissions.ownerNumbers` | Owners adicionais autorizados. | lista de identidades | lista existente | global | Permission Service | Loader e comandos | `config.json` | Restrita | Sim, apenas fluxo protegido | legado |
| `permissions.trustedGroupCreatorNumber` | Criador confiável com administração especial no grupo autorizado. | identidade canônica | valor protegido existente | global, group | Permission Service | Resolução de cargo | `config.json` | Restrita | Sim, apenas fluxo protegido | legado |
| `permissions.adminNumbers` | Administradores fixos adicionais do bot. | lista de identidades | lista vazia | global, community | Permission Service | Resolução de cargo | `config.json` | Restrita | Sim, apenas owner | legado |
| `permissions.roleHierarchy` | Ordem protectedOwner, owner, trustedGroupCreator, admin, moderator e member. | lista ordenada | hierarquia atual | invariant | Permission Service | Loader e serviços protegidos | `ROLE_RANK` | Operacional | Invariante | legado |
| `permissions.connectedBotIsHumanRole` | Define se o número conectado recebe cargo humano. | boolean | `false` | invariant | Permission Service | Resolução de cargo | regra do serviço | Restrita | Invariante | legado |

## Namespace `joinRequest`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `joinRequest.enabled` | Habilita detecção e processamento de pedidos. | boolean | `true` pelo boot atual | global, community, platform, group | Join Request | Loader e Join Request Service | integração do loader | Operacional | Sim | novo |
| `joinRequest.pollIntervalMilliseconds` | Intervalo da consulta de pedidos pendentes. | inteiro positivo | `30000` | global, platform, runtime | Join Request | Join Request Service | `POLL_INTERVAL_MS` | Operacional | Sim, com limite | legado |
| `joinRequest.autoApproveAfterRegistration` | Permite aprovação somente após cadastro persistido. | boolean | `true` | community, platform, group | Join Request | Join Request Service | fluxo de aprovação | Restrita | Sim, sem antecipar aprovação | legado |
| `joinRequest.requireCompletedRegistration` | Impede aprovação antes da conclusão do cadastro. | boolean | `true` | invariant | Join Request | Join Request Service | regra homologada | Restrita | Invariante | legado |
| `joinRequest.blockDisciplinaryRestrictions` | Consulta bloqueios disciplinares antes da aprovação. | boolean | `true` | invariant | Join Request/Disciplina | Join Request Service | integração disciplinar | Restrita | Invariante | legado |
| `joinRequest.orientationCooldownMinutes` | Janela contra orientações privadas repetidas do mesmo ciclo. | inteiro não negativo | comportamento persistente atual | global, platform | Join Request | Join Request Service | ciclo/deduplicação | Operacional | Sim | reservado |
| `joinRequest.privateFailureNotifyAdministrators` | Avisa administração quando o contato privado falha. | boolean | fallback atual | community, group | Join Request | Join Request Service | tratamento de falha | Operacional | Sim | reservado |

## Namespace `moderation`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `moderation.enabled` | Ativa a moderação do grupo. | boolean | `false` | group | Moderação | Moderation Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.warnings.enabled` | Ativa advertências. | boolean | `false` | group | Moderação | Warns e AntiLink | Moderation Repository | Operacional | Sim | legado |
| `moderation.warnings.limit` | Limite de advertências ativas. | inteiro ≥ 1 | `3` | group | Moderação | Moderation Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.warnings.finalAction` | Ação ao atingir o limite. | enum | `notify_admins` | group | Moderação | Warns e ações finais | Moderation Repository | Restrita | Sim | legado |
| `moderation.antiLink.enabled` | Ativa proteção contra links. | boolean | `false` | group | Moderação | AntiLink Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.antiLink.deleteMessage` | Apaga mensagens bloqueadas quando possível. | boolean | `true` | group | Moderação | AntiLink Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.antiLink.warnUser` | Registra advertência por link bloqueado. | boolean | `true` | group | Moderação | AntiLink Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.antiLink.adminsBypass` | Permite bypass administrativo. | boolean | `true` | group | Moderação | AntiLink Service | Moderation Repository | Restrita | Sim | legado |
| `moderation.antiLink.requireApproval` | Exige aprovação prévia para publicação. | boolean | `true` | group | Moderação | AntiLink/Link Approval | Moderation Repository | Operacional | Sim | legado |
| `moderation.bans.enabled` | Habilita banimento lógico do grupo. | boolean | `false` | group | Moderação | Bans e Warns | Moderation Repository | Restrita | Sim | legado |
| `moderation.bans.blockReentry` | Remove novamente membro com ban ativo. | boolean | `true` | group | Moderação | Moderation Service | Moderation Repository | Restrita | Sim | legado |
| `moderation.linkApproval.enabled` | Habilita pedidos de aprovação de links. | boolean | `false` | group | Moderação | Link Approval Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.linkApproval.allowModeratorReview` | Permite revisão por moderadores. | boolean | `false` | group | Moderação | Link Approval Service | Moderation Repository | Restrita | Sim | legado |
| `moderation.linkApproval.requestExpiresDays` | Prazo do pedido de link. | inteiro ≥ 1 | `7` | group | Moderação | Link Approval Service | Moderation Repository | Operacional | Sim | legado |
| `moderation.linkApproval.notifyAdminsPrivately` | Direciona avisos de aprovação aos admins. | boolean | `true` | group | Moderação | Link Approval | Moderation Repository | Operacional | Sim | legado |
| `moderation.linkApproval.publishByBotOnly` | Restringe publicação aprovada ao bot. | boolean | `true` | group | Moderação | Link Approval | Moderation Repository | Restrita | Sim | legado |
| `moderation.antiFlood.enabled` | Ativa anti-flood. | boolean | `false` | group | Moderação | Moderação | Moderation Repository | Operacional | Sim | legado |
| `moderation.antiSpam.enabled` | Ativa anti-spam. | boolean | `false` | group | Moderação | Moderação | Moderation Repository | Operacional | Sim | legado |

## Namespace `discipline`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `discipline.communityBanThreshold` | Quantidade de bans ativos que produz bloqueio comunitário. | inteiro ≥ 1 | `3` | community | Disciplina | Discipline Service | regra atual do serviço | Restrita | Sim, apenas owner protegida | legado |
| `discipline.supportedPlatforms` | Plataformas reconhecidas pelo domínio disciplinar. | lista enum | WhatsApp e Telegram | invariant | Disciplina | Discipline Service | `VALID_PLATFORMS` | Operacional | Invariante | legado |
| `discipline.supportedScopes` | Escopos group, platform e community. | lista enum | lista atual | invariant | Disciplina | Discipline Service | `VALID_SCOPES` | Operacional | Invariante | legado |
| `discipline.preserveRegistrationOnBan` | Garante que banimento não apague cadastro. | boolean | `true` | invariant | Disciplina | Disciplina/Cadastro | regra homologada | Restrita | Invariante | legado |
| `discipline.notifyAdministratorsOnCommunityBan` | Notifica administração no bloqueio comunitário. | boolean | `true` conceitual | community | Disciplina | Discipline Service | callback atual | Operacional | Sim | reservado |

## Namespace `memberLifecycle`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `memberLifecycle.removalPolicy` | Política never, immediate ou delayed. | enum | `never` | community | Ciclo de Vida | Member Leave Service | Member Lifecycle Repository | Restrita | Sim, apenas owner | legado |
| `memberLifecycle.removalGraceDays` | Prazo antes da remoção definitiva. | inteiro ≥ 0 | `7` | community | Ciclo de Vida | Member Leave Service | Member Lifecycle Repository | Restrita | Sim, apenas owner | legado |
| `memberLifecycle.preserveWhileJoinRequestPending` | Impede remoção com pedido pendente. | boolean | `true` | invariant | Ciclo de Vida | Member Leave Service | regra homologada | Restrita | Invariante | legado |
| `memberLifecycle.preserveAcrossActivePlatforms` | Mantém cadastro com outra plataforma ativa. | boolean | `true` | invariant | Ciclo de Vida | Member Leave Service | regra homologada | Restrita | Invariante | legado |

## Namespace `events`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `events.timezone` | Fuso usado em criação, exibição e scheduler. | timezone IANA | `America/Fortaleza` | community, platform, group | Eventos | Event Service, Formatter e Scheduler | constantes duplicadas | Operacional | Sim | legado |
| `events.scheduler.enabled` | Ativa o scheduler de eventos. | boolean | `true` no boot | global, community | Eventos | Inicialização/Scheduler | `index.js` | Operacional | Sim | novo |
| `events.scheduler.intervalMilliseconds` | Intervalo de verificação. | inteiro positivo | `30000` | global, runtime | Eventos | Event Scheduler | `INTERVAL_MS` | Operacional | Sim, com limite | legado |
| `events.notifications.reminder24Hours.enabled` | Habilita aviso de 24 horas. | boolean | `true` se não houver configuração no evento | community, group | Eventos | Event Scheduler | definições do scheduler | Operacional | Sim | legado |
| `events.notifications.reminder1Hour.enabled` | Habilita aviso de uma hora. | boolean | `true` se não houver configuração no evento | community, group | Eventos | Event Scheduler | definições do scheduler | Operacional | Sim | legado |
| `events.notifications.reminder30Minutes.enabled` | Habilita aviso de 30 minutos. | boolean | `true` se não houver configuração no evento | community, group | Eventos | Event Scheduler | definições do scheduler | Operacional | Sim | legado |
| `events.notifications.reminder10Minutes.enabled` | Habilita aviso de 10 minutos. | boolean | `true` se não houver configuração no evento | community, group | Eventos | Event Scheduler | definições do scheduler | Operacional | Sim | legado |
| `events.notifications.criticalDestination` | Destino padrão de notificações críticas. | enum | `group` | community, group | Eventos | Event Scheduler | `LEVEL_DESTINATIONS` | Operacional | Sim | legado |
| `events.notifications.importantDestination` | Destino padrão de notificações importantes. | enum | `group` | community, group | Eventos | Event Scheduler | `LEVEL_DESTINATIONS` | Operacional | Sim | legado |
| `events.notifications.normalDestination` | Destino padrão de notificações normais. | enum | `group` | community, group | Eventos | Event Scheduler | `LEVEL_DESTINATIONS` | Operacional | Sim | legado |
| `events.notifications.administrativeDestination` | Destino padrão de mensagens administrativas. | enum | `owner` | community | Eventos | Event Scheduler | `LEVEL_DESTINATIONS` | Restrita | Sim | legado |
| `events.notifications.debugDestination` | Destino de depuração. | enum | `owner` | global, runtime | Eventos | Event Scheduler | `LEVEL_DESTINATIONS` | Restrita | Sim | legado |

## Namespace `quiz`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `quiz.enabled` | Ativa o Quiz no grupo. | boolean | `true` ao criar settings | platform, group | Quiz | Quiz Service/Commands | Quiz Repository | Operacional | Sim | legado |
| `quiz.timezone` | Fuso dos agendamentos do Quiz. | timezone IANA | `UTC` | platform, group | Quiz | Quiz Repository/futuro scheduler | Quiz Repository | Operacional | Sim | legado |
| `quiz.cooldownSeconds` | Intervalo mínimo configurado entre ações. | inteiro ≥ 0 | `0` | platform, group | Quiz | Quiz Repository | Quiz Repository | Operacional | Sim | legado |
| `quiz.roundDurationMilliseconds` | Tempo de uma rodada comum. | inteiro positivo | `60000` | global, community, group | Quiz | Quiz Service | constante do serviço | Operacional | Sim | legado |
| `quiz.recentQuestionRetentionDays` | Retenção antirrepetição. | inteiro ≥ 0 | `7` | global, group | Quiz | Quiz Service | constante do serviço | Operacional | Sim | legado |
| `quiz.language.display` | Idioma de exibição. | locale | `pt-BR` | community, platform, group | Quiz/Localização | Locale e Question Service | Locale Service | Pública | Sim | legado |
| `quiz.language.accepted` | Idiomas aceitos nas respostas. | lista de locale | PT-BR e EN | community, platform, group | Quiz/Localização | Answer Normalizer | Locale Service | Pública | Sim | legado |
| `quiz.questions.distribution` | Pesos das categorias de pergunta. | mapa numérico | distribuição atual do gerador | global, community | Quiz | Question Service | `QUESTION_DISTRIBUTION` | Operacional | Sim, versionado | legado |
| `quiz.questions.recentPokemonWindow` | Janela para evitar Pokémon recentes. | inteiro ≥ 0 | `50` | global, group | Quiz | Question Service | configuração interna | Operacional | Sim | legado |
| `quiz.scoring.easyPoints` | Pontos de pergunta fácil. | número positivo | `10` | global, community | Quiz | Question Service | `DEFAULT_POINTS` | Operacional | Sim, versionado | legado |
| `quiz.scoring.normalPoints` | Pontos de pergunta normal. | número positivo | `15` | global, community | Quiz | Question Service | `DEFAULT_POINTS` | Operacional | Sim, versionado | legado |
| `quiz.scoring.hardPoints` | Pontos de pergunta difícil. | número positivo | `20` | global, community | Quiz | Question Service | `DEFAULT_POINTS` | Operacional | Sim, versionado | legado |
| `quiz.progression.easyExperience` | XP por acerto fácil. | inteiro positivo | `10` | global, community | Progressão | Player Progress Service | `XP_BY_DIFFICULTY` | Operacional | Sim, versionado | legado |
| `quiz.progression.normalExperience` | XP por acerto normal. | inteiro positivo | `15` | global, community | Progressão | Player Progress Service | `XP_BY_DIFFICULTY` | Operacional | Sim, versionado | legado |
| `quiz.progression.hardExperience` | XP por acerto difícil. | inteiro positivo | `20` | global, community | Progressão | Player Progress Service | `XP_BY_DIFFICULTY` | Operacional | Sim, versionado | legado |
| `quiz.ranking.pageSize` | Quantidade por página no ranking. | inteiro positivo | `10` | global, group | Rankings | Player Ranking Service | `PAGE_SIZE` | Pública | Sim | legado |
| `quiz.marathon.questionDurationMilliseconds` | Tempo por pergunta da Maratona. | inteiro positivo | `120000` | global, community, group | Maratona | Marathon Service/Formatter | constante duplicada em texto | Operacional | Sim | legado |
| `quiz.marathon.nextQuestionDelayMilliseconds` | Intervalo entre perguntas. | inteiro ≥ 0 | `3000` | global, community, group | Maratona | Marathon Service/Formatter | `INTERVAL_MS` | Operacional | Sim | legado |

## Namespace `registration`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `registration.guidedFlowExpirationMinutes` | Expiração do fluxo de Cadastro. | inteiro positivo | `15` pelo GuidedFlow | global, runtime | Cadastro/GuidedFlow | Registration Guided Flow | Guided Flow Service | Operacional | Sim | legado |
| `registration.defaultNotificationPreferences` | Defaults de Raids, Eventos, Quiz e Notícias. | mapa booleano | todos habilitados | community, platform | Cadastro | Registration Service | normalização do Cadastro | Operacional | Sim | legado |
| `registration.defaultPrivacy` | Visibilidade inicial de Friend Code e contas. | mapa booleano | ambos públicos | community, platform | Cadastro | Registration Service | normalização do Cadastro | Restrita | Sim | legado |
| `registration.preserveLegacyTelegramFields` | Mantém leitura de username, groupName e groupLink antigos. | boolean | `true` | invariant | Cadastro | Registration Service | compatibilidade homologada | Restrita | Invariante | legado |

## Namespace `telegram`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `telegram.officialGroupInvite` | Convite para o grupo oficial. | URL | valor operacional existente | community | Cadastro/Telegram | Registration Guided Flow | constante do fluxo | Restrita | Sim, apenas owner | legado |
| `telegram.botToken` | Credencial futura do bot Telegram. | string secreta | inexistente | runtime | Integração Telegram | futuro cliente Telegram | inexistente | Segredo | Não persistível | reservado |
| `telegram.integrationEnabled` | Ativa a futura integração. | boolean | `false` | global, community | Telegram | futuro adaptador | inexistente | Operacional | Sim | reservado |

## Namespace `whatsapp`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `whatsapp.authenticationStrategy` | Estratégia de autenticação. | enum | `LocalAuth` | invariant | Inicialização | Cliente WhatsApp | `index.js` | Restrita | Invariante | legado |
| `whatsapp.puppeteer.noSandbox` | Flag operacional do Chromium. | boolean | `true` | global | Inicialização | Cliente WhatsApp | `index.js` | Operacional | Não pelo Centro | legado |
| `whatsapp.puppeteer.disableSetuidSandbox` | Flag operacional do Chromium. | boolean | `true` | global | Inicialização | Cliente WhatsApp | `index.js` | Operacional | Não pelo Centro | legado |
| `whatsapp.groupChatCacheMilliseconds` | Retenção do cache seguro de chats. | inteiro ≥ 0 | `45000` | runtime | Resolvedor de chat | Group Chat Resolver | `DEFAULT_TTL_MS` | Operacional | Sim, runtime | legado |
| `whatsapp.warningSuppressionWindowMilliseconds` | Janela contra warnings repetidos. | inteiro ≥ 0 | `300000` | global, runtime | Logging WhatsApp | Warning Limiter | `DEFAULT_WINDOW_MS` | Operacional | Sim | legado |
| `whatsapp.sessionData` | Sessão, cookies e credenciais LocalAuth. | dados secretos | gerenciado externamente | invariant | WhatsApp/LocalAuth | Cliente WhatsApp | diretório LocalAuth | Segredo | Não persistível | legado |

## Namespace `menus`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `menus.sessionDurationMilliseconds` | Tempo de validade de um menu numérico. | inteiro positivo | `120000` | global, runtime | Menus | Menu Session Service | constante do serviço | Operacional | Sim | legado |
| `menus.directCommandsRemainAvailable` | Garante comandos diretos equivalentes. | boolean | `true` | invariant | Menus | Menu Registry/Commands | regra homologada | Operacional | Invariante | legado |

## Namespace `raids`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `raids.firstPersistentNumber` | Primeiro número persistente de Raid. | inteiro | `1024` | invariant | Raids | Raid Repository | `FIRST_RAID_NUMBER` | Operacional | Invariante | legado |
| `raids.activeStatuses` | Status considerados ativos. | lista enum | active e published | invariant | Raids | Raid Repository/Commands | `ACTIVE_STATUSES` | Operacional | Invariante | legado |
| `raids.guidedFlowExpirationMinutes` | Validade operacional do fluxo guiado. | inteiro positivo | `15` por fallback atual | global, runtime | Raids | Raid Service/Guided Flow | constante interna | Operacional | Sim | legado |
| `raids.allowRegisteredMemberCreation` | Permite criação por membro cadastrado. | boolean | `true` | invariant | Raids | Raid Service | regra homologada | Operacional | Invariante | legado |

## Namespace `pokemon`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `pokemon.datasetManifestPath` | Caminho do manifesto ativo. | caminho | manifesto atual | invariant | Pokémon Data | Pokemon Data Service | `DEFAULT_MANIFEST` | Operacional | Invariante | legado |
| `pokemon.datasetSchemaVersion` | Versão estrutural da base. | inteiro | manifesto ativo | invariant | Pokémon Data | Pokemon Data Service | manifesto | Operacional | Invariante | legado |
| `pokemon.blockConflictingRecords` | Exclui conflitos de perguntas de identidade única. | boolean | `true` | invariant | Pokémon Data | Quiz/Pokemon Data | manifesto e serviço | Operacional | Invariante | legado |

## Namespace `logging`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `logging.level` | Nível mínimo futuro de logs. | enum | não centralizado | global, runtime | Logging | Todos os módulos | inexistente | Operacional | Sim | reservado |
| `logging.sanitizeSensitiveData` | Obriga sanitização de identidades e dados privados. | boolean | `true` | invariant | Logging | Todos os módulos | regra homologada | Restrita | Invariante | legado |
| `logging.includeStackTraceForInternalErrors` | Inclui stack apenas em canal interno. | boolean | comportamento atual por logger | global, runtime | Logging | Logger central | utilitário de logs | Restrita | Sim | legado |
| `logging.debugGroupIdentifiers` | Autoriza exposição de IDs de grupo. | boolean | `false` | invariant | Logging | Todos os módulos | regra de privacidade | Restrita | Invariante | novo |

## Namespace `backup`

| Chave | Descrição | Tipo | Default atual | Escopos | Proprietário | Consumidores | Origem atual | Sensibilidade | Override | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `backup.checksumAlgorithm` | Algoritmo dos manifestos. | enum | `sha256` | invariant | Repositories | Moderação, Quiz, Eventos, Pokémon e Cadastro | repositories | Operacional | Invariante | legado |
| `backup.avoidIdenticalDuplicates` | Evita conjunto de backup integralmente idêntico. | boolean | `true` nos módulos preparados | invariant | Repositories | rotinas de backup | repositories/scripts | Operacional | Invariante | legado |
| `backup.retentionCount` | Limite futuro de backups por domínio. | inteiro ou null | ilimitado | global, community | Backup | futuros repositories | inexistente | Operacional | Sim | reservado |
| `backup.automaticBeforeMigration` | Exige backup validado antes de migração. | boolean | `true` por política | invariant | Backup | scripts de migração | política homologada | Operacional | Invariante | legado |

## Colisões e equivalências detectadas

### Mesmo significado com origens diferentes

1. `events.timezone` está representado por `DEFAULT_TIMEZONE` e `TIMEZONE` em
   Event Service, Formatter, Scheduler e Repository.
2. `quiz.marathon.questionDurationMilliseconds` também está embutido no texto
   público “2 minutos”.
3. `quiz.marathon.nextQuestionDelayMilliseconds` também está embutido no texto
   “3 segundos”.
4. Defaults da Moderação são definidos no Repository e novamente normalizados
   no Service.
5. Configurações de notificações de Eventos existem no fluxo, no evento
   persistido e no Scheduler.

### Valores iguais com significados diferentes

1. Pontos 10/15/20 e XP 10/15/20 não são a mesma configuração.
2. Intervalos de 30 segundos do Scheduler de Eventos e do polling de Join
   Request são independentes.
3. Expiração de GuidedFlow e fluxo de Raid pode coincidir, mas pertence a
   domínios diferentes.

### Nomes deliberadamente separados

- `events.timezone` não será fundido automaticamente com `quiz.timezone`.
- `quiz.scoring.*Points` não será fundido com
  `quiz.progression.*Experience`.
- `moderation.bans.*` representa ban lógico do grupo; `discipline.*`
  representa histórico e reincidência multiplataforma.

Não existem nomes completos duplicados neste catálogo.

## Sugestões de padronização futura

1. Usar sempre unidade explícita em duração.
2. Usar `enabled` apenas para feature toggles booleanos.
3. Usar singular para valor único e plural para listas.
4. Usar `community`, e não traduções ou abreviações, no identificador interno
   de escopo.
5. Manter `owner` somente para cargo do bot; criador de grupo deve usar
   `trustedGroupCreator`.
6. Tratar URLs operacionais como `Restrita`, mesmo quando não são segredo.
7. Exigir versão para mudanças em pontos, XP e distribuição de perguntas.
8. Não disponibilizar invariantes no menu administrativo.
9. Não registrar valores de chaves classificadas como Restrita ou Segredo.
10. Chaves reservadas não devem produzir comportamento até uma etapa própria.

## Garantias desta versão documental

- Este arquivo não é importado por nenhum módulo.
- Não existe serviço central de leitura ou escrita.
- Nenhum consumidor foi migrado.
- Nenhum override foi criado.
- Nenhum banco foi alterado.
- Nenhum default funcional foi alterado.
