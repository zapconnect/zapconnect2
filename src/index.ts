// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import { initDB } from "./database";
import {
  restoreSessionsOnStartup,
  markAppReady,
  startCobrancasSweepCron,
} from "./server";
import { cleanupInactiveTokens } from "./wppManager";
import { setupLogging } from "./utils/logger";
import { startScheduleWorker } from "./workers/scheduleWorker";
import { startNotificationWorker } from "./workers/notificationWorker";
import { startSubscriptionReconciler } from "./workers/subscriptionReconciler";
import { startAnalyticsWorker } from "./workers/analyticsWorker";
import { startDripWorker } from "./workers/dripWorker";

async function start() {
  try {
    setupLogging();

    await initDB();
    console.log("📄 Banco de dados inicializado");

    await cleanupInactiveTokens();
    console.log("🧹 Tokens inativos limpos");

    await restoreSessionsOnStartup();
    console.log("♻️ Sessões restauradas");

    startScheduleWorker();
    console.log("Worker de agendamentos iniciado");

    startNotificationWorker();
    console.log("Worker de notificações de cobrança iniciado");

    startSubscriptionReconciler();
    console.log("Reconciliador de assinaturas iniciado");

    startAnalyticsWorker();
    console.log("Worker de analytics iniciado");

    startDripWorker();
    console.log("Worker de drip iniciado");

    startCobrancasSweepCron();
    console.log("Sweep de cobranças iniciado");

    markAppReady(true);
  } catch (err) {
    console.error("❌ Erro ao iniciar aplicação:", err);
    process.exit(1);
  }
}

start();
