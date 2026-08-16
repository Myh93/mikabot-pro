# Changelog

## ETAPA 9.1.3 — Fila Privada de Aprovação de Links

- Solicitação privada por link colado ou comandos `!enviarlink` e aliases.
- Escolha segura entre grupos elegíveis, descrição opcional e revisão.
- Protocolos `LINK-`, duplicidade ativa, expiração de sete dias e cancelamento lógico.
- Listagem e análise administrativa com aprovação ou rejeição confirmada.
- Reserva atômica e publicação exclusiva pelo MikaBot, sem publicação dupla.
- Blacklist bloqueante, whitelist informativa e aprovação desligada por padrão.

## ETAPA 9.1.2 — Antilink Inteligente e Controle de Banimentos

- Detector local de links em texto e legendas, sem HTTP ou redirecionamentos.
- Whitelist global e por grupo, com prioridade da blacklist.
- Exclusão verificada, advertência automática idempotente e ações finais configuráveis.
- Banimentos lógicos no banco central e comandos `!banidos` e `!desbanir`.
- Proteções automáticas desligadas por padrão; fila privada de aprovação não implementada.

Todas as mudanças relevantes do MikaBot PRO são registradas neste arquivo.

## [2.1.0-dev] — Em desenvolvimento

### ETAPA 9.1.0 — Fundação da Central de Moderação

- Banco único e versionado em `data/moderation/moderation.json`.
- Repositório com escrita atômica, fila, revision, manifesto, checksum, backup e recuperação segura.
- Configurações de moderação por grupo, desativadas por padrão.
- Modelos persistentes para advertências, histórico e links pendentes.
- Whitelist, blacklist e reputação no mesmo banco.
- Normalização segura de domínios e classificação local de links.
- Sanitização de URLs sem query strings, fragmentos ou credenciais.
- Nenhum comando, listener, detector ou proteção ativado.

### ETAPA 9.1.1 — Sistema Central de Advertências

- Comandos de grupo `!warn`, `!warnings`, `!resetwarn` e `!clearwarns`.
- Aliases `!advertir`, `!advertencia`, `!advertências` e `!avisos`.
- Permissões reutilizadas da hierarquia existente.
- Alvos aceitos somente por menção ou mensagem respondida.
- Proteção do bot, do próprio autor, do dono e de administradores.
- Idempotência por hash do identificador da mensagem.
- Consulta paginada com cinco advertências por página.
- Reset confirmado em fluxo isolado, preservando os registros.
- Histórico `warning_created`, `warning_reset` e `warning_limit_reached`.
- Nenhuma punição automática ou detector implementado.

## [2.0.0] — 2026-07-20 — Stable

### Cadastro 2.0

- Fundação versionada com repositório, índices, histórico, backups e compatibilidade legada.
- Cadastro guiado no privado.
- Resolvedor universal de entradas.
- Conta principal e contas secundárias ilimitadas.
- Consultas públicas por identidade e Nick.
- Contatos do Telegram, preferências e controles de privacidade.
- Aplicação das preferências nos comandos públicos.
- Comando privado `!privacidade`.
- Edição guiada e parcial por `!editarcadastro`.

### Quiz e jogador

- Quiz coletivo e individual com perguntas estruturadas.
- Maratona, placar e retomada persistente.
- Ranking, perfil, progressão e conquistas.

### Comunidade

- Raids com criação, publicação, participação e arquivamento.
- Eventos com fluxo privado, permissões, publicação, histórico e avisos.
- Menus contextuais e diretório seguro de grupos.

### Estabilização

- Mensagens visuais consolidadas sem mudança de significado.
- Navegação guiada centralizada no `inputResolverService`.
- Separador visual compartilhado por `messageStyleService`.
- Documentação de arquitetura, versões e roadmap.
- Metadados do pacote atualizados para 2.0.0.
- Regressão integral validada para a release.

### Compatibilidade

- Comandos e aliases existentes preservados.
- Bases existentes mantidas sem migração estrutural nesta release.
- Loader, autenticação, Scheduler e operação PM2 preservados.
