// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import { initDB } from "./database";
import {
  restoreSessionsOnStartup,
  markAppReady,
  startCobrancasSweepCron,
} from "./server";
import { cleanupInactiveTokens } from "./wppManager"; // 👉 NOVO
import { setupLogging } from "./utils/logger";
import { startScheduleWorker } from "./workers/scheduleWorker";

async function start() {
  try {
    setupLogging();
    // 1️⃣ Banco
    await initDB();
    console.log("📄 Banco de dados inicializado");

    // 2️⃣ Limpar tokens órfãos
    await cleanupInactiveTokens();
    console.log("🧹 Tokens inativos limpos");

    // 3️⃣ Restaurar sessões válidas
    await restoreSessionsOnStartup();
    console.log("♻️ Sessões restauradas");

    // 4️⃣ Sinalizar readiness
    startScheduleWorker();
    console.log("Worker de agendamentos iniciado");
    startCobrancasSweepCron();
    console.log("Sweep de cobranças iniciado");
    markAppReady(true);

  } catch (err) {
    console.error("❌ Erro ao iniciar aplicação:", err);
    process.exit(1);
  }
}

start();
