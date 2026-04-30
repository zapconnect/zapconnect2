// src/database.ts
import mysql, { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";

let pool: mysql.Pool;
type Queryable = mysql.Pool | PoolConnection;

type IndexRow = RowDataPacket & {
  Key_name: string;
  Column_name: string;
  Seq_in_index: number;
};

type ColumnRow = RowDataPacket & {
  DATA_TYPE: string;
};

async function getIndexColumns(tableName: string, indexName: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(`SHOW INDEX FROM ${tableName}`);
  return (rows as IndexRow[])
    .filter((row) => row.Key_name === indexName)
    .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
    .map((row) => String(row.Column_name));
}

async function getColumnType(
  tableName: string,
  columnName: string
): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );

  const dataType = String((rows as ColumnRow[])[0]?.DATA_TYPE || "").trim().toLowerCase();
  return dataType || null;
}

async function migrateChatHistoriesToSharedScope() {
  try {
    await pool.query(
      "ALTER TABLE chat_histories MODIFY COLUMN session_name VARCHAR(255) NULL"
    );
  } catch {
    // coluna já está compatível
  }

  const uniqueColumns = await getIndexColumns("chat_histories", "uniq_chat_history");
  const alreadyShared =
    uniqueColumns.length === 2 &&
    uniqueColumns[0] === "user_id" &&
    uniqueColumns[1] === "chat_id";

  if (!alreadyShared) {
    const [duplicates] = await pool.query<RowDataPacket[]>(
      `SELECT user_id, chat_id, COUNT(*) AS total
       FROM chat_histories
       GROUP BY user_id, chat_id
       HAVING COUNT(*) > 1
       LIMIT 1`
    );

    if ((duplicates as RowDataPacket[]).length) {
      const [cleanupResult] = await pool.query<ResultSetHeader>(
        `DELETE older
         FROM chat_histories older
         INNER JOIN chat_histories newer
           ON older.user_id = newer.user_id
          AND older.chat_id = newer.chat_id
          AND (
            older.updated_at < newer.updated_at OR
            (older.updated_at = newer.updated_at AND older.id < newer.id)
          )`
      );

      if (cleanupResult.affectedRows) {
        console.log(
          `✅ chat_histories consolidado: ${cleanupResult.affectedRows} registro(s) antigo(s) removido(s) para unificar por user_id + chat_id`
        );
      }
    }

    try {
      await pool.query("ALTER TABLE chat_histories DROP INDEX uniq_chat_history");
    } catch {
      // índice antigo já não existe
    }

    await pool.query(
      "ALTER TABLE chat_histories ADD UNIQUE KEY uniq_chat_history (user_id, chat_id)"
    );
    console.log("✅ chat_histories agora usa chave única por user_id + chat_id");
  }

  try {
    await pool.query(
      "ALTER TABLE chat_histories DROP INDEX idx_chat_histories_user_session_chat"
    );
  } catch {
    // índice legado pode não existir
  }
}

async function migrateChatHistoriesStorage() {
  const currentType = await getColumnType("chat_histories", "history");
  if (!currentType) return;

  if (currentType === "json") {
    await pool.query(
      "ALTER TABLE chat_histories MODIFY COLUMN history LONGTEXT NOT NULL"
    );
    console.log("✅ chat_histories.history migrado de JSON para LONGTEXT");
  }

  const updatedType = await getColumnType("chat_histories", "history");
  if (updatedType !== "longblob") {
    await pool.query(
      "ALTER TABLE chat_histories MODIFY COLUMN history LONGBLOB NOT NULL"
    );
    console.log("✅ chat_histories.history agora usa LONGBLOB");
  }
}

export async function initDB() {
  console.log("DB_HOST =", process.env.DB_HOST);
  console.log("DB_PORT =", process.env.DB_PORT);
  console.log("DB_USER =", process.env.DB_USER);
  console.log("DB_NAME =", process.env.DB_NAME);
  
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: Number(process.env.DB_POOL_LIMIT || 30),
    charset: "utf8mb4",
  });

  // 🔥 Teste de conexão
  await pool.query("SELECT 1");
  console.log("✅ MySQL conectado");

  // Migração: adicionar deal_value se não existir (seguro rodar múltiplas vezes)
  try {
    await pool.query(
      "ALTER TABLE crm ADD COLUMN deal_value DECIMAL(10,2) DEFAULT 0"
    );
    console.log("✅ Coluna deal_value adicionada ao CRM");
  } catch {
    // Coluna já existe — ignorar
  }

  // Migração: adicionar colunas de horário de silêncio
  try {
    await pool.query("ALTER TABLE users ADD COLUMN ia_silence_start INT DEFAULT NULL");
    await pool.query("ALTER TABLE users ADD COLUMN ia_silence_end INT DEFAULT NULL");
    console.log("✅ Colunas ia_silence adicionadas");
  } catch { }

  // Migração: timezone do usuário
  try {
    await pool.query("ALTER TABLE users ADD COLUMN timezone_offset INT DEFAULT -180");
    console.log("✅ Coluna timezone_offset adicionada em users");
  } catch { }

  // Migração: adicionar follow_up_date se não existir
  try {
    await pool.query(
      "ALTER TABLE crm ADD COLUMN follow_up_date BIGINT DEFAULT NULL"
    );
    console.log("✅ Coluna follow_up_date adicionada ao CRM");
  } catch {
    // Coluna já existe — ignorar
  }

  // Migração: recorrência nos agendamentos
  try {
    await pool.query(
      "ALTER TABLE schedules ADD COLUMN recurrence VARCHAR(20) DEFAULT 'none'"
    );
    console.log("✅ Coluna recurrence adicionada a schedules");
  } catch {
    // Coluna já existe
  }
  // Migração: data de encerramento da recorrência
  try {
    await pool.query(
      "ALTER TABLE schedules ADD COLUMN recurrence_end BIGINT DEFAULT NULL"
    );
    console.log("✅ Coluna recurrence_end adicionada a schedules");
  } catch {
    // já existe
  }
  // Migração: marcação de início de processamento do agendamento
  try {
    await pool.query(
      "ALTER TABLE schedules ADD COLUMN processing_started_at BIGINT DEFAULT NULL"
    );
    console.log("✅ Coluna processing_started_at adicionada a schedules");
  } catch {
    // já existe
  }
  // Migração: tabela de itens de log de agendamento
  try {
    await pool.query(
      `CREATE TABLE schedule_log_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        log_id INT NOT NULL,
        schedule_id INT NOT NULL,
        user_id INT NOT NULL,
        number VARCHAR(30) NOT NULL,
        status VARCHAR(20) NOT NULL,
        error TEXT,
        sent_at BIGINT NOT NULL,
        FOREIGN KEY (log_id) REFERENCES schedule_logs(id) ON DELETE CASCADE,
        FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`
    );
    console.log("✅ Tabela schedule_log_items criada");
  } catch {
    // já existe
  }

  // ===============================
  // 🔧 CRIAÇÃO DAS TABELAS (MARIA DB SAFE)
  // ===============================
  const tables = [
    `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      email_normalized VARCHAR(255) UNIQUE,
      signup_device_id VARCHAR(255),
      password VARCHAR(255) NOT NULL,
      prompt TEXT,
      token VARCHAR(255) UNIQUE NOT NULL,
      token_expires_at BIGINT DEFAULT NULL,

      -- 🔐 CONFIRMAÇÃO DE EMAIL
      email_verified TINYINT DEFAULT 0,
      email_verify_token VARCHAR(255),
      email_verify_expires BIGINT,

      ia_enabled TINYINT DEFAULT 1,
      ia_messages_used INT DEFAULT 0,
      ia_messages_reset_at BIGINT,
      ia_silence_start INT DEFAULT NULL,
      ia_silence_end INT DEFAULT NULL,
      timezone_offset INT DEFAULT -180,
      default_ddi VARCHAR(4) DEFAULT '55',
      default_session_name VARCHAR(255) DEFAULT NULL,
      billing_default_type VARCHAR(30) DEFAULT 'PIX',
      billing_default_description VARCHAR(255) DEFAULT NULL,
      billing_default_pix_key VARCHAR(255) DEFAULT NULL,
      billing_default_link_pagamento TEXT,
      billing_default_multa DECIMAL(5,2) DEFAULT 0,
      billing_default_juros DECIMAL(5,2) DEFAULT 0,
      billing_default_desconto DECIMAL(5,2) DEFAULT 0,
      billing_default_desconto_dias INT DEFAULT 0,
      template_cobranca_criacao TEXT,
      template_cobranca_lembrete TEXT,
      template_cobranca_atraso TEXT,
      template_cobranca_confirmacao TEXT,
      template_cobranca_cancelamento TEXT,
      chat_history_cleaned_at BIGINT DEFAULT NULL,

      plan VARCHAR(50) DEFAULT 'free',
      plan_expires_at BIGINT,
      subscription_id VARCHAR(255),
      subscription_status VARCHAR(50) DEFAULT 'trial'
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS mercadopago_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      public_key VARCHAR(255),
      webhook_secret VARCHAR(255),
      test_mode TINYINT DEFAULT 0,
      notify_whatsapp TINYINT DEFAULT 0,
      connected_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT,
      sender VARCHAR(50),
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      numbers LONGTEXT NOT NULL,
      message TEXT,
      file LONGTEXT,
      filename VARCHAR(255),
      preferred_session VARCHAR(255),
      send_at BIGINT NOT NULL,
      recurrence VARCHAR(20) DEFAULT 'none',
      recurrence_end BIGINT DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      processing_started_at BIGINT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS schedule_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT NOT NULL,
      user_id INT NOT NULL,
      success_count INT DEFAULT 0,
      failure_count INT DEFAULT 0,
      sent_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS schedule_log_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      log_id INT NOT NULL,
      schedule_id INT NOT NULL,
      user_id INT NOT NULL,
      number VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL,
      error TEXT,
      sent_at BIGINT NOT NULL,
      FOREIGN KEY (log_id) REFERENCES schedule_logs(id) ON DELETE CASCADE,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS drip_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      trigger_stage VARCHAR(100) NOT NULL,
      preferred_session VARCHAR(255) DEFAULT NULL,
      active TINYINT DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS drip_steps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT NOT NULL,
      step_order INT NOT NULL,
      delay_ms BIGINT NOT NULL DEFAULT 0,
      message TEXT,
      file LONGTEXT,
      filename VARCHAR(255) DEFAULT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES drip_campaigns(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS drip_enrollments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT NOT NULL,
      user_id INT NOT NULL,
      crm_id INT DEFAULT NULL,
      contact_name VARCHAR(255) DEFAULT NULL,
      contact_phone VARCHAR(30) NOT NULL,
      current_step INT NOT NULL DEFAULT 0,
      next_send_at BIGINT DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempt_count INT NOT NULL DEFAULT 0,
      last_attempt_at BIGINT DEFAULT NULL,
      processing_started_at BIGINT DEFAULT NULL,
      last_session_name VARCHAR(255) DEFAULT NULL,
      last_error TEXT,
      completed_at BIGINT DEFAULT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_drip_campaign_crm (campaign_id, crm_id),
      FOREIGN KEY (campaign_id) REFERENCES drip_campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (crm_id) REFERENCES crm(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS qualification_flows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      trigger_keywords LONGTEXT,
      steps LONGTEXT NOT NULL,
      settings LONGTEXT,
      active TINYINT DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS qualification_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      flow_id INT NOT NULL,
      crm_id INT DEFAULT NULL,
      session_name VARCHAR(255) DEFAULT NULL,
      chat_id VARCHAR(255) NOT NULL,
      contact_phone VARCHAR(30) NOT NULL,
      contact_name VARCHAR(255) DEFAULT NULL,
      current_step INT NOT NULL DEFAULT 0,
      answers LONGTEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      score INT DEFAULT NULL,
      last_question_at BIGINT DEFAULT NULL,
      last_answer_at BIGINT DEFAULT NULL,
      started_at BIGINT NOT NULL,
      completed_at BIGINT DEFAULT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (flow_id) REFERENCES qualification_flows(id) ON DELETE CASCADE,
      FOREIGN KEY (crm_id) REFERENCES crm(id) ON DELETE SET NULL
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS crm (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      citystate VARCHAR(255),
      tags LONGTEXT,
      notes LONGTEXT,
      stage VARCHAR(100) DEFAULT 'Novo',
      last_seen BIGINT,
      avatar TEXT,
      deal_value DECIMAL(10,2) DEFAULT 0,
      follow_up_date BIGINT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS cobranca_clientes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      nome VARCHAR(255) NOT NULL,
      telefone VARCHAR(30) NOT NULL,
      email VARCHAR(255),
      cpf_cnpj VARCHAR(20),
      observacoes TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_cliente_telefone (user_id, telefone),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS cobrancas_recorrencias (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      cliente_id INT NOT NULL,
      cliente_nome VARCHAR(255) NOT NULL,
      billing_type VARCHAR(30) NOT NULL,
      cycle VARCHAR(20) NOT NULL,
      valor DECIMAL(10,2) NOT NULL,
      descricao TEXT,
      proxima_cobranca VARCHAR(20) NOT NULL,
      data_fim VARCHAR(20),
      ativa TINYINT DEFAULT 1,
      session_name VARCHAR(255),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (cliente_id) REFERENCES cobranca_clientes(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS cobrancas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      cliente_id INT NOT NULL,
      cliente_nome VARCHAR(255) NOT NULL,
      cliente_telefone VARCHAR(30) NOT NULL,
      billing_type VARCHAR(30) NOT NULL,
      valor DECIMAL(10,2) NOT NULL,
      valor_pago DECIMAL(10,2),
      descricao TEXT NOT NULL,
      vencimento VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
      observacoes TEXT,
      chave_pix VARCHAR(255),
      link_pagamento TEXT,
      multa_percentual DECIMAL(5,2) DEFAULT 0,
      juros_percentual DECIMAL(5,2) DEFAULT 0,
      desconto_percentual DECIMAL(5,2) DEFAULT 0,
      desconto_limite_dias INT DEFAULT 0,
      parcelas INT DEFAULT 1,
      parcela_atual INT DEFAULT 1,
      cobranca_pai_id INT,
      recorrente TINYINT DEFAULT 0,
      recorrencia_id INT,
      session_name VARCHAR(255),
      whatsapp_ultimo_tipo VARCHAR(30),
      whatsapp_ultimo_status VARCHAR(20),
      whatsapp_ultimo_ack INT,
      whatsapp_ultima_mensagem_id VARCHAR(255),
      whatsapp_ultimo_erro TEXT,
      whatsapp_ultimo_envio_em BIGINT,
      whatsapp_ultimo_entregue_em BIGINT,
      whatsapp_ultimo_lido_em BIGINT,
      whatsapp_ultimo_status_em BIGINT,
      mp_preference_id VARCHAR(255),
      mp_payment_id VARCHAR(255),
      mp_checkout_url TEXT,
      mp_status VARCHAR(50),
      mp_updated_at BIGINT,
      notificado_criacao TINYINT DEFAULT 0,
      notificado_vencimento TINYINT DEFAULT 0,
      notificado_atraso TINYINT DEFAULT 0,
      notificado_confirmacao_pagamento TINYINT DEFAULT 0,
      pago_em BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (cliente_id) REFERENCES cobranca_clientes(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS cobranca_recebimentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cobranca_id INT NOT NULL,
      user_id INT NOT NULL,
      valor DECIMAL(10,2) NOT NULL,
      recebido_em BIGINT NOT NULL,
      observacao TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (cobranca_id) REFERENCES cobrancas(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS mp_webhook_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      cobranca_id INT,
      payment_id VARCHAR(255),
      event_type VARCHAR(50),
      mp_status VARCHAR(50),
      raw_payload LONGTEXT,
      processed TINYINT DEFAULT 0,
      error TEXT,
      created_at BIGINT NOT NULL,
      INDEX idx_mp_webhook_user (user_id),
      INDEX idx_mp_webhook_payment (payment_id)
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS flows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      trigger_type VARCHAR(255) NOT NULL,
      actions LONGTEXT NOT NULL,
      active TINYINT DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS welcome_flows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      actions LONGTEXT NOT NULL,
      active TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      payment_id VARCHAR(255),
      status VARCHAR(50),
      amount DECIMAL(10,2),
      plan_name VARCHAR(100),
      payment_method VARCHAR(50),
      created_at BIGINT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
      plan VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS checkout_leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      email VARCHAR(255),
      stripe_preapproval_id VARCHAR(255),
      stripe_payment_id VARCHAR(255),
      plan VARCHAR(100),
      amount DECIMAL(10,2),
      status VARCHAR(50),
      failure_reason VARCHAR(100),
      payment_method VARCHAR(50),
      card_last_four VARCHAR(4),
      event_type VARCHAR(100),
      raw_event LONGTEXT,
      created_at BIGINT
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS chat_ai_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      chat_id VARCHAR(255) NOT NULL,
      ai_enabled TINYINT DEFAULT 1,
      updated_at BIGINT,
      UNIQUE KEY unique_chat (user_id, chat_id)
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS stripe_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      type VARCHAR(255) NOT NULL,
      created_at BIGINT NOT NULL
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS stripe_webhook_failures (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      reason VARCHAR(255) NOT NULL,
      payload LONGTEXT NOT NULL,
      resolved TINYINT DEFAULT 0,
      resolved_at BIGINT DEFAULT NULL,
      resolved_by VARCHAR(100) DEFAULT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_stripe_webhook_failure_event (event_id)
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS disparo_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      total_numbers INT NOT NULL,
      success_count INT NOT NULL,
      fail_count INT NOT NULL,
      success_rate DECIMAL(5,2) NOT NULL,
      message TEXT,
      status VARCHAR(20) DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS dispatch_suppressions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      phone VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      reason VARCHAR(100) NOT NULL,
      source VARCHAR(50) NOT NULL,
      notes TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_dispatch_suppression (user_id, phone),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS dispatch_contact_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255),
      campaign_kind VARCHAR(20) NOT NULL,
      campaign_ref VARCHAR(64),
      phone VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL,
      error_code VARCHAR(64),
      error_message TEXT,
      metadata LONGTEXT,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS rate_limits (
      rate_key VARCHAR(255) PRIMARY KEY,
      count INT DEFAULT 0,
      first_attempt BIGINT DEFAULT 0,
      blocked_until BIGINT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS fallback_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255) NOT NULL,

      enable_fallback BOOLEAN DEFAULT TRUE,
      fallback_message TEXT,
      send_transfer_message BOOLEAN DEFAULT FALSE,
      internal_note_only BOOLEAN DEFAULT TRUE,

      fallback_sensitivity VARCHAR(10),

      max_repetitions INT,
      max_frustration INT,
      max_ia_failures INT,

      trigger_words JSON,
      frustration_words JSON,
      ai_uncertainty_phrases JSON,
      ai_transfer_phrases JSON,

      human_mode_duration INT,

      notify_panel BOOLEAN,
      notify_webhook BOOLEAN,
      webhook_url TEXT,
      alert_phone VARCHAR(32),
      alert_message TEXT,
      fallback_cooldown_minutes INT,

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      UNIQUE KEY uniq_user_session (user_id, session_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS chat_histories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255),
      chat_id VARCHAR(255) NOT NULL,
      history LONGBLOB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_chat_history (user_id, chat_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS analytics_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      report_date DATE NOT NULL,
      window_start BIGINT NOT NULL,
      window_end BIGINT NOT NULL,
      data LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_analytics_report_user_date (user_id, report_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS chat_notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255) NOT NULL,
      chat_id VARCHAR(255) NOT NULL,
      attendant_id INT DEFAULT NULL,
      author_name VARCHAR(255),
      content TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_chat_notes_lookup (user_id, session_name, chat_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS kb_sources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(10) NOT NULL,
      name VARCHAR(255) NOT NULL,
      source_url TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      error TEXT,
      embedding_version INT DEFAULT 1,
      tokens INT DEFAULT 0,
      chunks INT DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source_id INT NOT NULL,
      user_id INT NOT NULL,
      session_scope VARCHAR(255),
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      embedding JSON,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS kb_queries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255),
      chat_id VARCHAR(255),
      query TEXT NOT NULL,
      latency_ms INT,
      result_count INT,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS email_templates (
      template_key VARCHAR(50) PRIMARY KEY,
      subject VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS plan_configs (
      plan_key VARCHAR(50) PRIMARY KEY,
      display_name VARCHAR(80) NOT NULL,
      badge_label VARCHAR(80),
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      max_sessions INT NOT NULL DEFAULT 1,
      max_ia_messages VARCHAR(20) NOT NULL DEFAULT '0',
      max_broadcast_numbers INT NOT NULL DEFAULT 50,
      feature_list LONGTEXT,
      highlight TINYINT DEFAULT 0,
      updated_at BIGINT NOT NULL
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS ai_metrics (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_name VARCHAR(255) NOT NULL,
      chat_id VARCHAR(255) NOT NULL,
      provider VARCHAR(10) NOT NULL,
      latency_ms INT NOT NULL,
      input_chars INT NOT NULL,
      output_chars INT NOT NULL,
      success TINYINT NOT NULL,
      error_code VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ai_metrics_user (user_id),
      INDEX idx_ai_metrics_session (session_name),
      INDEX idx_ai_metrics_chat (chat_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NULL,
      entity_id VARCHAR(255) NULL,
      meta LONGTEXT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_audit_user_created (user_id, created_at),
      INDEX idx_audit_action_created (action, created_at)
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS device_fingerprints (
      device_id VARCHAR(64) PRIMARY KEY,
      user_id INT NULL,
      account_count INT DEFAULT 1,
      blocked TINYINT DEFAULT 0,
      block_reason VARCHAR(255),
      first_seen_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS ip_registrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ip VARCHAR(45) NOT NULL,
      user_id INT NOT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_ip_reg_ip_created (ip, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS webhook_delivery_failures (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      target_url TEXT NOT NULL,
      payload LONGTEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 3,
      status VARCHAR(20) NOT NULL DEFAULT 'dead_letter',
      last_error TEXT,
      last_attempt_at BIGINT DEFAULT NULL,
      next_retry_at BIGINT DEFAULT NULL,
      resolved_at BIGINT DEFAULT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS cobranca_regua_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      slot INT NOT NULL DEFAULT 0,
      nome VARCHAR(80) NOT NULL,
      gatilho VARCHAR(30) NOT NULL,
      dias_offset INT NOT NULL DEFAULT 0,
      horario_envio VARCHAR(5) NOT NULL DEFAULT '09:00',
      canal VARCHAR(20) NOT NULL DEFAULT 'WHATSAPP',
      ativo TINYINT NOT NULL DEFAULT 1,
      template_customizado TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_cobranca_regua_slot (user_id, slot),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `,

    `
    CREATE TABLE IF NOT EXISTS cobranca_notifications_queue (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cobranca_id INT NOT NULL,
      user_id INT NOT NULL,
      tipo VARCHAR(30) NOT NULL,
      regua_rule_id INT NOT NULL DEFAULT 0,
      tentativas INT NOT NULL DEFAULT 0,
      max_tentativas INT NOT NULL DEFAULT 3,
      agendado_para BIGINT NOT NULL,
      processado_em BIGINT DEFAULT NULL,
      processing_started_at BIGINT DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      erro TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_cobranca_notification (cobranca_id, tipo, regua_rule_id),
      FOREIGN KEY (cobranca_id) REFERENCES cobrancas(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  ];

  // Ajustes incrementais de schema (idempotentes)
  const alters = [
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS alert_phone VARCHAR(32)`,
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS alert_message TEXT`,
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS fallback_cooldown_minutes INT`,
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS send_transfer_message BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS internal_note_only BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS conditions JSON`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS triggers JSON`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS active TINYINT DEFAULT 1`,
    `ALTER TABLE schedules ADD COLUMN IF NOT EXISTS preferred_session VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_normalized VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_device_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at BIGINT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at BIGINT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_day1_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_day3_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_day6_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_last_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_onboarding_done TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS default_ddi VARCHAR(4) DEFAULT '55'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS default_session_name VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_type VARCHAR(30) DEFAULT 'PIX'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_description VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_pix_key VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_link_pagamento TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_multa DECIMAL(5,2) DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_juros DECIMAL(5,2) DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_desconto DECIMAL(5,2) DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_default_desconto_dias INT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS template_cobranca_criacao TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS template_cobranca_lembrete TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS template_cobranca_atraso TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS template_cobranca_confirmacao TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS template_cobranca_cancelamento TEXT`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS public_key VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS test_mode TINYINT DEFAULT 0`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS notify_whatsapp TINYINT DEFAULT 0`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS connected_at BIGINT DEFAULT NULL`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT 0`,
    `ALTER TABLE mercadopago_settings ADD COLUMN IF NOT EXISTS updated_at BIGINT DEFAULT 0`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_tipo VARCHAR(30) DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_status VARCHAR(20) DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_ack INT DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultima_mensagem_id VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_erro TEXT`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_envio_em BIGINT DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_entregue_em BIGINT DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_lido_em BIGINT DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS whatsapp_ultimo_status_em BIGINT DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS mp_preference_id VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS mp_payment_id VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS mp_checkout_url TEXT`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS mp_status VARCHAR(50) DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS mp_updated_at BIGINT DEFAULT NULL`,
    `ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS notificado_confirmacao_pagamento TINYINT DEFAULT 0`,
    `ALTER TABLE cobranca_regua_rules ADD COLUMN IF NOT EXISTS slot INT NOT NULL DEFAULT 0`,
    `ALTER TABLE cobranca_notifications_queue ADD COLUMN IF NOT EXISTS regua_rule_id INT NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_history_cleaned_at BIGINT DEFAULT NULL`,
    `ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS embedding_version INT DEFAULT 1`
  ];

  for (const sql of tables) {
    await pool.query(sql);
  }

  for (const sql of alters) {
    await pool.query(sql);
  }

  try {
    await pool.query(
      `ALTER TABLE cobranca_notifications_queue DROP INDEX uniq_cobranca_notification`
    );
  } catch {
    // índice antigo pode não existir em bases novas
  }

  try {
    await pool.query(
      `ALTER TABLE cobranca_notifications_queue ADD UNIQUE KEY uniq_cobranca_notification (cobranca_id, tipo, regua_rule_id)`
    );
  } catch {
    // ignora se a chave já estiver no formato novo
  }

  try {
    await pool.query(
      `ALTER TABLE cobranca_regua_rules ADD UNIQUE KEY uniq_cobranca_regua_slot (user_id, slot)`
    );
  } catch {
    // ignora se a chave da régua já existir
  }

  await migrateChatHistoriesToSharedScope();
  await migrateChatHistoriesStorage();

  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_schedules_status_send_at ON schedules (status, send_at)",
    "CREATE INDEX IF NOT EXISTS idx_schedules_status_processing_started_at ON schedules (status, processing_started_at)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions (user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_drip_campaigns_user_active_stage ON drip_campaigns (user_id, active, trigger_stage)",
    "CREATE INDEX IF NOT EXISTS idx_drip_steps_campaign_order ON drip_steps (campaign_id, step_order)",
    "CREATE INDEX IF NOT EXISTS idx_drip_enrollments_status_next_send ON drip_enrollments (status, next_send_at)",
    "CREATE INDEX IF NOT EXISTS idx_drip_enrollments_processing_started ON drip_enrollments (status, processing_started_at)",
    "CREATE INDEX IF NOT EXISTS idx_drip_enrollments_user_created ON drip_enrollments (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_drip_enrollments_campaign_status ON drip_enrollments (campaign_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_drip_enrollments_contact_phone ON drip_enrollments (contact_phone)",
    "CREATE INDEX IF NOT EXISTS idx_qualification_flows_user_active ON qualification_flows (user_id, active)",
    "CREATE INDEX IF NOT EXISTS idx_qualification_flows_updated ON qualification_flows (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_qualification_sessions_chat_status ON qualification_sessions (user_id, chat_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_qualification_sessions_flow_status ON qualification_sessions (flow_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_qualification_sessions_user_updated ON qualification_sessions (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_qualification_sessions_crm ON qualification_sessions (crm_id)",
    "CREATE INDEX IF NOT EXISTS idx_chat_histories_updated ON chat_histories (updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_chat_histories_user_updated ON chat_histories (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_analytics_reports_user_updated ON analytics_reports (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_analytics_reports_date ON analytics_reports (report_date)",
    "CREATE INDEX IF NOT EXISTS idx_crm_user_phone ON crm (user_id, phone)",
    "CREATE INDEX IF NOT EXISTS idx_cobrancas_user_status ON cobrancas (user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_cobrancas_vencimento ON cobrancas (vencimento)",
    "CREATE INDEX IF NOT EXISTS idx_cobrancas_cliente ON cobrancas (user_id, cliente_id)",
    "CREATE INDEX IF NOT EXISTS idx_cobrancas_whatsapp_message ON cobrancas (user_id, whatsapp_ultima_mensagem_id)",
    "CREATE INDEX IF NOT EXISTS idx_cobranca_recebimentos_cobranca_data ON cobranca_recebimentos (cobranca_id, recebido_em)",
    "CREATE INDEX IF NOT EXISTS idx_cobranca_recebimentos_user_data ON cobranca_recebimentos (user_id, recebido_em)",
    "CREATE INDEX IF NOT EXISTS idx_recorrencias_user ON cobrancas_recorrencias (user_id, ativa)",
    "CREATE INDEX IF NOT EXISTS idx_clientes_user ON cobranca_clientes (user_id)",
    "CREATE INDEX IF NOT EXISTS idx_dispatch_suppressions_user_status_phone ON dispatch_suppressions (user_id, status, phone)",
    "CREATE INDEX IF NOT EXISTS idx_dispatch_contact_events_user_phone_created ON dispatch_contact_events (user_id, phone, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_dispatch_contact_events_user_session_created ON dispatch_contact_events (user_id, session_name, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_dispatch_contact_events_user_status_created ON dispatch_contact_events (user_id, status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_chat_notes_lookup ON chat_notes (user_id, session_name, chat_id)",
    "CREATE INDEX IF NOT EXISTS idx_kb_sources_user ON kb_sources (user_id)",
    "CREATE INDEX IF NOT EXISTS idx_kb_chunks_scope ON kb_chunks (user_id, session_scope)",
    "CREATE INDEX IF NOT EXISTS idx_cobranca_regua_user_active ON cobranca_regua_rules (user_id, ativo)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users (email_normalized)",
    "CREATE INDEX IF NOT EXISTS idx_users_signup_device ON users (signup_device_id)",
    "CREATE INDEX IF NOT EXISTS idx_users_subscription_status_id ON users (subscription_status, subscription_id)",
    "CREATE INDEX IF NOT EXISTS idx_device_fingerprints_blocked ON device_fingerprints (blocked)",
    "CREATE INDEX IF NOT EXISTS idx_webhook_delivery_failures_user_created ON webhook_delivery_failures (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_webhook_delivery_failures_status_created ON webhook_delivery_failures (status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_stripe_webhook_failures_resolved_created ON stripe_webhook_failures (resolved, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_stripe_webhook_failures_type_created ON stripe_webhook_failures (event_type, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_cobranca_queue_status_schedule ON cobranca_notifications_queue (status, agendado_para)",
    "CREATE INDEX IF NOT EXISTS idx_cobranca_queue_user_status ON cobranca_notifications_queue (user_id, status)",
    "CREATE FULLTEXT INDEX idx_kb_chunks_content ON kb_chunks (content)",
  ];

  for (const sql of indexes) {
    try {
      await pool.query(sql);
    } catch {
      // ignorar se índice já existir ou IF NOT EXISTS não for suportado
    }
  }

  console.log("📌 Tabelas verificadas/criadas com sucesso");
}

export async function closeDB() {
  try {
    if (pool) {
      await pool.end();
      console.log("🛑 Pool MySQL fechado");
    }
  } catch (err) {
    console.error("Erro ao fechar pool MySQL:", err);
  }
}

function createDBClient(executor: Queryable) {
  return {
    /**
     * Retorna UM registro ou null
     * Uso: db.get<User>()
     */
    async get<T = any>(sql: string, params?: any[]): Promise<T | null> {
      const [rows] = await executor.query<RowDataPacket[]>(sql, params);
      return (rows as T[])[0] ?? null;
    },

    /**
     * Retorna ARRAY sempre
     * Uso seguro: rows.length, for..of, map
     */
    async all<T = any>(sql: string, params?: any[]): Promise<T[]> {
      const [rows] = await executor.query<RowDataPacket[]>(sql, params);
      return rows as T[];
    },

    /**
     * INSERT / UPDATE / DELETE
     */
    async run(sql: string, params?: any[]): Promise<ResultSetHeader> {
      const [result] = await executor.query<ResultSetHeader>(sql, params);
      return result;
    }
  };
}

export type DBClient = ReturnType<typeof createDBClient>;

export function getDB() {
  if (!pool) throw new Error("DB não inicializado");

  return createDBClient(pool);
}

export async function withDBTransaction<T>(
  handler: (db: DBClient, connection: PoolConnection) => Promise<T>
): Promise<T> {
  if (!pool) throw new Error("DB nao inicializado");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const db = createDBClient(connection);
    const result = await handler(db, connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      // ignore rollback failure so the original error can surface
    }
    throw err;
  } finally {
    connection.release();
  }
}
