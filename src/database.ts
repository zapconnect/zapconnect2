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
    connectionLimit: 10,
    charset: "utf8mb4",
  });

  // 🔥 Teste de conexão
  await pool.query("SELECT 1");
  console.log("✅ MySQL conectado");

  // ===============================
  // 🔧 CRIAÇÃO DAS TABELAS (MARIA DB SAFE)
  // ===============================
  const tables = [
    `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      prompt TEXT,
      token VARCHAR(255) UNIQUE NOT NULL,

      ia_enabled TINYINT DEFAULT 1,
      ia_messages_used INT DEFAULT 0,
      ia_messages_reset_at BIGINT,

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
      send_at BIGINT NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
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
    `
  ];

  for (const sql of tables) {
    await pool.query(sql);
  }

  console.log("📌 Tabelas verificadas/criadas com sucesso");
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