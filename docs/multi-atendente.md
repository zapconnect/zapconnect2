# Plano técnico — Multi-atendente por sessão

## Objetivo
Permitir que mais de um atendente opere a mesma sessão WhatsApp de um cliente (user), com fila, distribuição automática e histórico por atendente, sem quebrar integrações atuais.

## Requisitos funcionais (v1)
- Convite e login de atendentes subordinados a um `user` titular.
- Atribuição de atendentes a sessões específicas.
- Fila de chats por sessão; distribuição automática (round-robin ou menos carregado) e manual.
- Visualização de histórico/estatísticas por atendente (chats atendidos, tempos, satisfação futura).
- Restrições de permissão: atendente só enxerga sessões e chats atribuídos; titular vê tudo.

## Proposta de schema (MySQL)
- `attendants` — pessoas do time.
  - `id`, `user_id` (FK `users`), `name`, `email`, `password_hash`, `role` (`owner|agent|admin`), `active`, `created_at`.
  - `UNIQUE (user_id, email)` para evitar duplicados por conta.
- `session_attendants`
  - `id`, `session_id` (FK `sessions`), `attendant_id` (FK `attendants`), `can_assign` (bool), `active`.
  - `UNIQUE (session_id, attendant_id)`.
- `chat_assignments`
  - `id`, `user_id` (FK `users`), `session_name`, `chat_id`, `attendant_id` (nullable), `status` (`queued|assigned|closed`), `priority` (int), `assigned_at`, `closed_at`, `closed_reason`, `last_message_at`.
  - `UNIQUE (user_id, session_name, chat_id)`, índice em `(status, last_message_at)`.
- Extensões de tabelas existentes:
  - `messages`: adicionar `chat_id VARCHAR(255)` e `attendant_id INT NULL` (FK `attendants`) para auditar quem respondeu.
  - Opcional: `chat_histories`: manter como está; o vínculo atendente vem de `chat_assignments`.

## Fluxos principais
1) **Autenticação**  
   - Novo endpoint `/auth/attendant/login` que emite token próprio (cookie `attendant_token`).  
   - `authMiddleware` passa a aceitar `token` (titular) OU `attendant_token` (escopo reduzido), populando `req.actor = { type: 'owner' | 'attendant', userId, attendantId }`.
2) **Convite e gestão de atendentes**  
   - Rotas para criar/inativar atendente e definir sessões permitidas (`session_attendants`).
3) **Fila e distribuição**  
   - Ao receber mensagem (webhook WPP), localizar `chat_assignments`; se inexistente, criar com `status='queued'` e `last_message_at=NOW()`.  
   - Worker/cron ou lógica inline decide atendente:  
     - Filtra atendentes ativos da sessão; escolhe o de menor carga ou round-robin; grava `attendant_id`, `status='assigned'`, `assigned_at=NOW()`.  
     - Emite via Socket.IO evento `chat:assigned` para painel.
4) **Atendimento humano**  
   - Quando atendente envia mensagem, salvar `attendant_id` em `messages` e manter `chat_assignments.status='assigned'`.  
   - Encerramento manual ou por inatividade define `status='closed'` e `closed_at`.
5) **Histórico e métricas**  
   - Relatórios por atendente: contar chats fechados, tempo médio de primeira resposta ( `assigned_at -> primeira mensagem do atendente` ), duração ( `assigned_at -> closed_at` ).

## Mudanças de backend (mínimas para v1)
- `src/database.ts`: incluir CREATE TABLEs acima e `ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id ...`, `attendant_id ...`.
- Middleware: expandir `authMiddleware` para ler `attendant_token` e limitar acesso às sessões listadas em `session_attendants`.
- Novas rotas (esqueleto):
  - POST `/attendants` (criar), GET `/attendants` (listar), PATCH `/attendants/:id` (ativar/inativar).
  - POST `/attendants/:id/sessions` (vincular a uma sessão).
  - POST `/auth/attendant/login`.
  - GET `/queue` (listar filas por sessão), POST `/queue/assign` (atribuição manual/opcionalmente reatribuir).
- Serviço de distribuição automática (`services/dispatcher.ts`) invocado pelo webhook ou cron.

## Impactos no frontend/painel
- Tela de login para atendente.
- Painel de fila por sessão: colunas chatId, cliente, tempo na fila, atendente atual; ação “assumir”.
- Indicador de status do atendente (disponível/ausente/ocupado) usado pelo distribuidor.
- Filtro “Meus chats” e histórico por atendente.

## Rollout sugerido
1. Migrar schema e adicionar rotas de atendentes + login (sem alterar fluxo atual do titular).  
2. Implementar fila e distribuição automática simples (round-robin / menor carga).  
3. Ajustar painel e métricas; permitir reatribuição e encerramento manual.  
4. Otimizar métricas e relatórios.

## Próximos passos imediatos (ação rápida)
- [ ] Aplicar migrações no `src/database.ts` (tabelas novas + columns em `messages`).  
- [ ] Criar middleware de ator (`req.actor`) e separar permissões.  
- [ ] Expor rotas de CRUD de atendentes e vinculação de sessão.  
- [ ] Esqueleto de distribuidor automático com estratégia configurável.

