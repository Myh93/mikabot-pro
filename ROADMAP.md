# Roadmap

## Progresso da aprovação de links

- [x] ETAPA 9.1.3 — solicitação, análise, aprovação, rejeição e publicação pelo MikaBot.
- [ ] Antiflood e Antispam.
- [ ] Painel central `!seguranca`.

## Central de Moderação v2.1

- [x] ETAPA 9.1.2 — Antilink inteligente, remoção controlada e banimentos lógicos.
- [ ] Fila privada e aprovação de links.
- [ ] Antiflood, Antispam e painel `!seguranca`.

Este roadmap registra possibilidades posteriores à v2.0 Stable. Nenhum item abaixo está ativo ou prometido até ser aprovado, especificado e testado separadamente.

## Manutenção da linha 2.0

- Correções compatíveis identificadas por testes ou operação.
- Expansão da cobertura de contratos visuais.
- Auditorias periódicas de índices, backups e restauração.
- Documentação operacional de implantação e recuperação.

## Linha 2.1 — Central de Moderação

- [x] ETAPA 9.1.0: banco versionado, repositório, serviço, histórico, modelos de advertência e links, regras de domínio e segurança de URLs.
- [x] ETAPA 9.1.1: comandos manuais de advertência, consulta, paginação, limite informativo e reset confirmado.
- [ ] Antilink e aprovação de links.
- [ ] Whitelist, blacklist e reputação operacional.
- [ ] Antiflood e antispam.
- [ ] Painel privado de segurança.

Os itens pendentes não estão implementados nem ativados.

## Evoluções candidatas

- Aplicação das preferências de avisos pelos módulos responsáveis.
- Novos adaptadores de plataforma mantendo os serviços independentes.
- Ferramentas administrativas de diagnóstico sem exposição de dados privados.
- Observabilidade estruturada e métricas de saúde.
- Estratégia formal de arquivamento e retenção de históricos.

## Critérios para futuras releases

Toda evolução deve:

1. preservar privacidade e compatibilidade;
2. reutilizar serviços e repositórios existentes;
3. evitar listeners paralelos;
4. incluir testes específicos e regressão completa;
5. documentar alterações de dados antes de qualquer migração;
6. manter comandos e aliases antigos ou registrar formalmente a transição.
