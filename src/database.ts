// src/database.ts
import mysql, { RowDataPacket, ResultSetHeader } from "mysql2/promise";

let pool: mysql.Pool;

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

      plan VARCHAR(50) DEFAULT 'free',
      plan_expires_at BIGINT,
      subscription_id VARCHAR(255),
      subscription_status VARCHAR(50) DEFAULT 'trial'
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
      session_name VARCHAR(255) NOT NULL,
      chat_id VARCHAR(255) NOT NULL,
      history JSON NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_chat_history (user_id, session_name, chat_id),
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
    `
  ];

  // Ajustes incrementais de schema (idempotentes)
  const alters = [
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS alert_phone VARCHAR(32)`,
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS alert_message TEXT`,
    `ALTER TABLE fallback_settings ADD COLUMN IF NOT EXISTS fallback_cooldown_minutes INT`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS conditions JSON`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS triggers JSON`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0`,
    `ALTER TABLE flows ADD COLUMN IF NOT EXISTS active TINYINT DEFAULT 1`,
    `ALTER TABLE schedules ADD COLUMN IF NOT EXISTS preferred_session VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_normalized VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_device_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at BIGINT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_day1_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_day3_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_day6_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_email_last_sent TINYINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_onboarding_done TINYINT DEFAULT 0`
  ];

  for (const sql of tables) {
    await pool.query(sql);
  }

  for (const sql of alters) {
    await pool.query(sql);
  }

  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_schedules_status_send_at ON schedules (status, send_at)",
    "CREATE INDEX IF NOT EXISTS idx_schedules_status_processing_started_at ON schedules (status, processing_started_at)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions (user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_chat_histories_user_session_chat ON chat_histories (user_id, session_name, chat_id)",
    "CREATE INDEX IF NOT EXISTS idx_chat_histories_updated ON chat_histories (updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_chat_histories_user_updated ON chat_histories (user_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_crm_user_phone ON crm (user_id, phone)",
    "CREATE INDEX IF NOT EXISTS idx_chat_notes_lookup ON chat_notes (user_id, session_name, chat_id)",
    "CREATE INDEX IF NOT EXISTS idx_kb_sources_user ON kb_sources (user_id)",
    "CREATE INDEX IF NOT EXISTS idx_kb_chunks_scope ON kb_chunks (user_id, session_scope)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users (email_normalized)",
    "CREATE INDEX IF NOT EXISTS idx_users_signup_device ON users (signup_device_id)",
    "CREATE INDEX IF NOT EXISTS idx_device_fingerprints_blocked ON device_fingerprints (blocked)",
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

export function getDB() {
  if (!pool) throw new Error("DB não inicializado");

  return {
    /**
     * Retorna UM registro ou null
     * Uso: db.get<User>()
     */
    async get<T = any>(sql: string, params?: any[]): Promise<T | null> {
      const [rows] = await pool.query<RowDataPacket[]>(sql, params);
      return (rows as T[])[0] ?? null;
    },

    /**
     * Retorna ARRAY sempre
     * Uso seguro: rows.length, for..of, map
     */
    async all<T = any>(sql: string, params?: any[]): Promise<T[]> {
      const [rows] = await pool.query<RowDataPacket[]>(sql, params);
      return rows as T[];
    },

    /**
     * INSERT / UPDATE / DELETE
     */
    async run(sql: string, params?: any[]): Promise<ResultSetHeader> {
      const [result] = await pool.query<ResultSetHeader>(sql, params);
      return result;
    }
  };
}
