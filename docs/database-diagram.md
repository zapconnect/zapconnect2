# Database Diagram

Fonte principal: [src/database.ts](C:\Users\Vinicius\Desktop\projetos\whatsapp-bot-ia - multisessoes - 3.0 - Stripe - mysql\src\database.ts)

Este diagrama foi derivado do bootstrap do schema em `initDB()`. Para evitar um unico canvas enorme, ele foi separado por dominio funcional.

## 1. Contas, autenticacao e configuracoes

```mermaid
erDiagram
    users {
        INT id PK
        VARCHAR email UK
        VARCHAR email_normalized UK
        VARCHAR google_id UK
        VARCHAR token UK
        VARCHAR plan
        VARCHAR subscription_status
    }

    quick_replies {
        INT id PK
        INT user_id FK
        VARCHAR shortcut
        VARCHAR title
        TEXT content
    }

    mercadopago_settings {
        INT id PK
        INT user_id FK
        TEXT access_token
        VARCHAR public_key
        TINYINT notify_whatsapp
    }

    subscriptions {
        INT id PK
        INT user_id FK
        VARCHAR stripe_subscription_id UK
        VARCHAR plan
        VARCHAR status
    }

    payments {
        INT id PK
        INT user_id FK
        VARCHAR payment_id
        VARCHAR status
        DECIMAL amount
    }

    fallback_settings {
        INT id PK
        INT user_id FK
        VARCHAR session_name
        BOOLEAN enable_fallback
        TEXT fallback_message
    }

    device_fingerprints {
        VARCHAR device_id PK
        INT user_id FK
        INT account_count
        TINYINT blocked
    }

    ip_registrations {
        INT id PK
        VARCHAR ip
        INT user_id FK
    }

    users ||--o{ quick_replies : owns
    users ||--o| mercadopago_settings : configures
    users ||--o{ subscriptions : has
    users ||--o{ payments : receives
    users ||--o{ fallback_settings : configures
    users o|--o{ device_fingerprints : linked_to
    users ||--o{ ip_registrations : registers
```

## 2. WhatsApp, chats e automacoes de mensagem

```mermaid
erDiagram
    users {
        INT id PK
    }

    sessions {
        INT id PK
        INT user_id FK
        VARCHAR session_name
        VARCHAR status
    }

    messages {
        INT id PK
        INT session_id FK
        VARCHAR sender
        TEXT body
    }

    schedules {
        INT id PK
        INT user_id FK
        LONGTEXT numbers
        TEXT message
        VARCHAR status
        BIGINT send_at
    }

    schedule_logs {
        INT id PK
        INT schedule_id FK
        INT user_id FK
        INT success_count
        INT failure_count
    }

    schedule_log_items {
        INT id PK
        INT log_id FK
        INT schedule_id FK
        INT user_id FK
        VARCHAR number
        VARCHAR status
    }

    flows {
        INT id PK
        INT user_id FK
        VARCHAR name
        VARCHAR trigger_type
        LONGTEXT actions
    }

    welcome_flows {
        INT id PK
        INT user_id FK
        VARCHAR name
        LONGTEXT actions
        TINYINT active
    }

    chat_ai_settings {
        INT id PK
        INT user_id
        VARCHAR chat_id
        TINYINT ai_enabled
    }

    chat_histories {
        INT id PK
        INT user_id FK
        VARCHAR session_name
        VARCHAR chat_id
        LONGBLOB history
    }

    chat_notes {
        INT id PK
        INT user_id FK
        VARCHAR session_name
        VARCHAR chat_id
        TEXT content
    }

    disparo_history {
        INT id PK
        INT user_id FK
        INT total_numbers
        INT success_count
        INT fail_count
    }

    dispatch_suppressions {
        INT id PK
        INT user_id FK
        VARCHAR phone
        VARCHAR reason
        VARCHAR status
    }

    dispatch_contact_events {
        INT id PK
        INT user_id FK
        VARCHAR campaign_kind
        VARCHAR phone
        VARCHAR status
    }

    users ||--o{ sessions : owns
    sessions ||--o{ messages : stores
    users ||--o{ schedules : creates
    schedules ||--o{ schedule_logs : generates
    schedule_logs ||--o{ schedule_log_items : details
    schedules ||--o{ schedule_log_items : traces
    users ||--o{ flows : owns
    users ||--o{ welcome_flows : owns
    users ||--o{ chat_histories : stores
    users ||--o{ chat_notes : annotates
    users ||--o{ disparo_history : records
    users ||--o{ dispatch_suppressions : suppresses
    users ||--o{ dispatch_contact_events : logs
```

## 3. CRM, qualificacao e campanhas drip

```mermaid
erDiagram
    users {
        INT id PK
    }

    crm {
        INT id PK
        INT user_id FK
        VARCHAR name
        VARCHAR phone
        VARCHAR stage
        DECIMAL deal_value
    }

    qualification_flows {
        INT id PK
        INT user_id FK
        VARCHAR name
        LONGTEXT steps
        TINYINT active
    }

    qualification_sessions {
        INT id PK
        INT user_id FK
        INT flow_id FK
        INT crm_id FK
        VARCHAR chat_id
        VARCHAR status
        INT current_step
    }

    drip_campaigns {
        INT id PK
        INT user_id FK
        VARCHAR name
        VARCHAR trigger_stage
        TINYINT active
    }

    drip_steps {
        INT id PK
        INT campaign_id FK
        INT step_order
        BIGINT delay_ms
        TEXT message
    }

    drip_enrollments {
        INT id PK
        INT campaign_id FK
        INT user_id FK
        INT crm_id FK
        VARCHAR contact_phone
        INT current_step
        VARCHAR status
    }

    users ||--o{ crm : owns
    users ||--o{ qualification_flows : owns
    qualification_flows ||--o{ qualification_sessions : drives
    crm o|--o{ qualification_sessions : tracks
    users ||--o{ qualification_sessions : owns
    users ||--o{ drip_campaigns : owns
    drip_campaigns ||--o{ drip_steps : contains
    drip_campaigns ||--o{ drip_enrollments : enrolls
    crm o|--o{ drip_enrollments : target
    users ||--o{ drip_enrollments : owns
```

## 4. Cobrancas e recebimentos

```mermaid
erDiagram
    users {
        INT id PK
    }

    cobranca_clientes {
        INT id PK
        INT user_id FK
        VARCHAR nome
        VARCHAR telefone
    }

    cobrancas_recorrencias {
        INT id PK
        INT user_id FK
        INT cliente_id FK
        VARCHAR cycle
        DECIMAL valor
        TINYINT ativa
    }

    cobrancas {
        INT id PK
        INT user_id FK
        INT cliente_id FK
        VARCHAR billing_type
        DECIMAL valor
        VARCHAR status
        VARCHAR session_name
    }

    cobranca_recebimentos {
        INT id PK
        INT cobranca_id FK
        INT user_id FK
        DECIMAL valor
        BIGINT recebido_em
    }

    cobranca_regua_rules {
        INT id PK
        INT user_id FK
        INT slot
        VARCHAR gatilho
        VARCHAR canal
        TINYINT ativo
    }

    cobranca_notifications_queue {
        INT id PK
        INT cobranca_id FK
        INT user_id FK
        INT regua_rule_id
        VARCHAR tipo
        VARCHAR status
    }

    mp_webhook_logs {
        INT id PK
        INT user_id
        INT cobranca_id
        VARCHAR payment_id
        VARCHAR event_type
    }

    users ||--o{ cobranca_clientes : owns
    cobranca_clientes ||--o{ cobrancas_recorrencias : recurrence_for
    users ||--o{ cobrancas_recorrencias : owns
    cobranca_clientes ||--o{ cobrancas : billed_as
    users ||--o{ cobrancas : owns
    cobrancas ||--o{ cobranca_recebimentos : receives
    users ||--o{ cobranca_recebimentos : records
    users ||--o{ cobranca_regua_rules : owns
    cobrancas ||--o{ cobranca_notifications_queue : queues
    users ||--o{ cobranca_notifications_queue : owns
```

## 5. Base de conhecimento, analytics e operacao

```mermaid
erDiagram
    users {
        INT id PK
    }

    kb_sources {
        INT id PK
        INT user_id FK
        VARCHAR type
        VARCHAR name
        VARCHAR status
    }

    kb_chunks {
        INT id PK
        INT source_id FK
        INT user_id FK
        VARCHAR session_scope
        INT chunk_index
    }

    kb_queries {
        INT id PK
        INT user_id FK
        VARCHAR session_name
        VARCHAR chat_id
        TEXT query
    }

    analytics_reports {
        INT id PK
        INT user_id FK
        DATE report_date
        LONGTEXT data
    }

    ai_metrics {
        INT id PK
        INT user_id FK
        VARCHAR session_name
        VARCHAR chat_id
        VARCHAR provider
        INT latency_ms
    }

    webhook_delivery_failures {
        INT id PK
        INT user_id FK
        VARCHAR event_type
        VARCHAR status
        INT attempts
    }

    audit_logs {
        INT id PK
        INT user_id
        VARCHAR action
        VARCHAR entity_type
        VARCHAR entity_id
    }

    users ||--o{ kb_sources : owns
    kb_sources ||--o{ kb_chunks : splits_into
    users ||--o{ kb_chunks : scopes
    users ||--o{ kb_queries : asks
    users ||--o{ analytics_reports : aggregates
    users ||--o{ ai_metrics : measures
    users ||--o{ webhook_delivery_failures : retries
```

## 6. Tabelas auxiliares sem relacionamento forte no schema

- `checkout_leads`
- `stripe_events`
- `stripe_webhook_failures`
- `email_templates`
- `plan_configs`
- `rate_limits`

## Observacoes

- `mp_webhook_logs`, `chat_ai_settings` e `audit_logs` carregam chaves de negocio ligadas a usuario, mas sem `FOREIGN KEY` explicita no schema atual.
- O bootstrap em [src/database.ts](C:\Users\Vinicius\Desktop\projetos\whatsapp-bot-ia - multisessoes - 3.0 - Stripe - mysql\src\database.ts) contem criacao duplicada e idempotente de `crm` e `quick_replies`; para o diagrama foi considerada apenas uma versao logica de cada tabela.
- O foco aqui foi o modelo relacional. Indices auxiliares, colunas de telemetry e campos de payload longo foram resumidos para manter o diagrama legivel.
