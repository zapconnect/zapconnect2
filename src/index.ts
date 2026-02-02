// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import { initDB } from "./database";
import { restoreSessionsOnStartup } from "./server";

// importa e já inicia o servidor

async function start() {
  try {
    await initDB();
    console.log("📌 Banco de dados inicializado");

    await restoreSessionsOnStartup();
  } catch (err) {
    console.error("❌ Erro ao iniciar aplicação:", err);
    process.exit(1);
  }
}

start();
  
