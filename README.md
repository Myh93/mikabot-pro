# MikaBot PRO

## Fila privada de aprovação — v2.1 em desenvolvimento

A ETAPA 9.1.3 permite solicitar links no privado, escolher um grupo elegível, revisar, gerar protocolo `LINK-`, analisar, rejeitar ou publicar pelo próprio MikaBot. A aprovação permanece desativada por padrão e é ativada individualmente com `!aprovacaolink on`.

Blacklist bloqueia solicitações e whitelist é apenas informativa: nenhum domínio é aprovado automaticamente. Não há leitura externa de páginas, requisições HTTP, redirecionamentos ou IA externa. Antiflood, Antispam e `!seguranca` continuam fora do escopo. A v2.0 permanece Stable.

**Versão oficial:** 2.0.0 Stable  
**Release:** 20 de julho de 2026

> **Desenvolvimento atual:** MikaBot PRO v2.1 — ETAPA 9.1.1, Sistema Central de Advertências. Os comandos manuais de advertência estão disponíveis em grupos; detectores automáticos e punições permanecem desativados.

MikaBot PRO é um bot modular para comunidades Pokémon GO no WhatsApp. A versão 2.0 Stable consolida cadastro de treinadores, consultas públicas com privacidade, Quiz, Maratona, rankings, perfil, conquistas, progressão, Raids, Eventos, administração e menus guiados.

## Requisitos

- Node.js compatível com CommonJS.
- WhatsApp Web acessível pelo `whatsapp-web.js`.
- Configuração local em `config.json`.
- PM2 é opcional e operado externamente ao código.

## Instalação e validação

```powershell
npm install
npm test
npm start
```

Para verificar apenas a entrada principal:

```powershell
npm run check
```

## Módulos

- **Cadastro 2.0:** cadastro privado guiado, conta principal, contas secundárias, Telegram, preferências, privacidade e edição parcial.
- **Consultas:** `!treinador`, `!contas`, `!fc` e aliases, respeitando as preferências do dono.
- **Quiz e Maratona:** perguntas, sessões, pontuação, placares e persistência.
- **Jogador:** perfil, ranking, progresso e conquistas.
- **Raids:** criação, publicação, participação, encerramento e arquivamento.
- **Eventos:** criação guiada, edição, publicação, avisos e ciclo de vida.
- **Administração:** permissões, diretório de grupos, configuração e moderação.
- **Moderação v2.1:** fundação versionada e comandos manuais `!warn`, `!warnings`, `!resetwarn` e `!clearwarns`. Não há kick, ban, mute, antilink ou punição automática.
- **Menus:** navegação contextual com sessões persistentes.

## Comandos principais

| Área | Comandos |
|---|---|
| Cadastro | `cadastro`, `!editarcadastro`, `!privacidade` |
| Consulta | `!treinador`, `!contas`, `!fc`, `!friendcode` |
| Quiz | `!quiz`, `!jogar quiz`, `!responder` |
| Maratona | `!maratona`, `!parar maratona` |
| Jogador | `!perfil`, `!ranking`, `!conquistas` |
| Raids | `!raid`, `!criar raid`, `!listar raids` |
| Eventos | `!evento`, `!eventos` e ações relacionadas |
| Navegação | `!menu`, `!voltar`, `!cancelar`, `!sair` |
| Moderação | `!warn`, `!warnings`, `!resetwarn`, `!clearwarns` |

Os aliases históricos permanecem válidos. A relação detalhada está nas propriedades `name` e `aliases` dos arquivos em `src/commands`.

## Segurança e privacidade

- Cadastro, edição e configuração de privacidade acontecem no privado.
- Friend Codes e contas secundárias obedecem às preferências persistidas.
- Somente o próprio treinador ignora suas restrições ao consultar os próprios dados.
- Administradores não ignoram privacidade.
- Identificadores internos não são apresentados em respostas públicas.

## Arquitetura e dados

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para as camadas, fluxos e bancos. Mudanças da versão estão em [CHANGELOG.md](CHANGELOG.md), histórico em [VERSIONS.md](VERSIONS.md) e planejamento em [ROADMAP.md](ROADMAP.md).

## Operação

O processo principal é iniciado por `index.js`. O Loader descobre comandos e coordena os listeners existentes. Scheduler, PM2 e autenticação são componentes operacionais independentes e não são modificados por tarefas de padronização.

## Licença

ISC.

## Antilink inteligente — v2.1 em desenvolvimento

A ETAPA 9.1.2 adiciona `!banidos`, `!desbanir` e aliases, além da configuração administrativa mínima. O detector trabalha localmente em texto e legendas, sem abrir URLs ou realizar requisições externas. A proteção é individual por grupo e permanece desativada por padrão, assim como remoção e banimento automáticos.

A fila privada de aprovação, Antiflood, Antispam e o painel `!seguranca` ainda não foram implementados. A versão pública estável continua sendo a v2.0.
