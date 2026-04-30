import { getDB } from "../database";
import {
  buscarChargeCadenceRule,
  buscarCobranca,
  enviarNotificacaoWhatsApp,
  type ChargeMessageType,
} from "../services/cobrancaService";

const NOTIFICATION_DELAY_BETWEEN_MS = Math.max(
  500,
  Number(process.env.NOTIFICATION_DELAY_BETWEEN_MS || 3_000)
);
const NOTIFICATION_BATCH_SIZE = Math.max(
  1,
  Number(process.env.NOTIFICATION_BATCH_SIZE || 10)
);
const NOTIFICATION_WORKER_IDLE_MS = Math.max(
  1_000,
  Number(process.env.NOTIFICATION_WORKER_IDLE_MS || 15_000)
);
const NOTIFICATION_RETRY_BASE_MS = Math.max(
  60_000,
  Number(process.env.NOTIFICATION_RETRY_BASE_MS || 30 * 60 * 1000)
);
const NOTIFICATION_PROCESSING_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.NOTIFICATION_PROCESSING_TIMEOUT_MS || 10 * 60 * 1000)
);
const NOTIFICATION_WATCHDOG_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.NOTIFICATION_WATCHDOG_INTERVAL_MS || 5 * 60 * 1000)
);

type NotificationQueueStatus =
  | "pending"
  | "processing"
  | "sent"
  | "failed"
  | "skipped";

type NotificationQueueRow = {
  id: number;
  cobranca_id: number;
  user_id: number;
  tipo: ChargeMessageType;
  regua_rule_id: number;
  tentativas: number;
  max_tentativas: number;
  agendado_para: number;
  processado_em: number | null;
  processing_started_at: number | null;
  status: NotificationQueueStatus;
  erro: string | null;
  created_at: number;
  updated_at: number;
};

type WorkerState = {
  running: boolean;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  lastWatchdogAt: number;
};

const QUEUE_NOTIFICATION_TYPES: ChargeMessageType[] = [
  "criacao",
  "lembrete_vencimento",
  "atraso",
  "confirmacao_pagamento",
  "cancelamento",
];

let sharedWorkerState: WorkerState | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isQueueNotificationType(value: unknown): value is ChargeMessageType {
  return QUEUE_NOTIFICATION_TYPES.includes(value as ChargeMessageType);
}

function getNotificationFlagName(tipo: ChargeMessageType) {
  if (tipo === "criacao") return "notificado_criacao";
  if (tipo === "lembrete_vencimento") return "notificado_vencimento";
  if (tipo === "atraso") return "notificado_atraso";
  if (tipo === "confirmacao_pagamento") return "notificado_confirmacao_pagamento";
  return null;
}

function isNotificationStillRelevant(
  status: string,
  tipo: ChargeMessageType
) {
  if (tipo === "lembrete_vencimento") return status === "PENDENTE";
  if (tipo === "atraso") return status === "VENCIDO";
  if (tipo === "confirmacao_pagamento") return status === "PAGO";
  if (tipo === "cancelamento") return status === "CANCELADO";
  return status === "PENDENTE" || status === "PARCIAL";
}

function inClause(ids: number[]) {
  return ids.map(() => "?").join(", ");
}

async function releaseStuckNotifications() {
  const db = getDB();
  const threshold = Date.now() - NOTIFICATION_PROCESSING_TIMEOUT_MS;
  await db.run(
    `
    UPDATE cobranca_notifications_queue
    SET status = 'pending',
        processing_started_at = NULL,
        updated_at = ?,
        erro = COALESCE(erro, 'Item liberado pelo watchdog após timeout de processamento')
    WHERE status = 'processing'
      AND processing_started_at IS NOT NULL
      AND processing_started_at < ?
    `,
    [Date.now(), threshold]
  );
}

async function claimDueNotifications(limit: number): Promise<NotificationQueueRow[]> {
  const db = getDB();
  const now = Date.now();
  const due = await db.all<NotificationQueueRow>(
    `
    SELECT *
    FROM cobranca_notifications_queue
    WHERE status = 'pending'
      AND tentativas < max_tentativas
      AND agendado_para <= ?
    ORDER BY agendado_para ASC, id ASC
    LIMIT ?
    `,
    [now, limit]
  );

  if (!due.length) return [];

  const ids = due.map((item) => Number(item.id)).filter((id) => Number.isFinite(id));
  const claimedAt = Date.now();
  await db.run(
    `
    UPDATE cobranca_notifications_queue
    SET status = 'processing',
        processing_started_at = ?,
        updated_at = ?
    WHERE status = 'pending'
      AND id IN (${inClause(ids)})
    `,
    [claimedAt, claimedAt, ...ids]
  );

  return db.all<NotificationQueueRow>(
    `
    SELECT *
    FROM cobranca_notifications_queue
    WHERE status = 'processing'
      AND processing_started_at = ?
      AND id IN (${inClause(ids)})
    ORDER BY agendado_para ASC, id ASC
    `,
    [claimedAt, ...ids]
  );
}

async function markQueueItem(
  itemId: number,
  status: NotificationQueueStatus,
  input: {
    erro?: string | null;
    tentativas?: number;
    agendadoPara?: number | null;
    processadoEm?: number | null;
  } = {}
) {
  const db = getDB();
  const now = Date.now();
  await db.run(
    `
    UPDATE cobranca_notifications_queue
    SET status = ?,
        erro = ?,
        tentativas = COALESCE(?, tentativas),
        agendado_para = COALESCE(?, agendado_para),
        processado_em = ?,
        processing_started_at = NULL,
        updated_at = ?
    WHERE id = ?
    `,
    [
      status,
      input.erro ?? null,
      input.tentativas ?? null,
      input.agendadoPara ?? null,
      input.processadoEm ?? null,
      now,
      itemId,
    ]
  );
}

async function processQueueItem(item: NotificationQueueRow) {
  const charge = await buscarCobranca(item.user_id, item.cobranca_id);

  if (!charge) {
    await markQueueItem(item.id, "skipped", {
      erro: "Cobrança não encontrada",
      processadoEm: Date.now(),
    });
    return;
  }

  if (!isNotificationStillRelevant(String(charge.status || ""), item.tipo)) {
    await markQueueItem(item.id, "skipped", {
      erro: `Cobrança em status ${charge.status}, sem envio necessário`,
      processadoEm: Date.now(),
    });
    return;
  }

  let templateOverride: string | null = null;
  const isCadenceRule = Number(item.regua_rule_id || 0) > 0;

  if (isCadenceRule) {
    const rule = await buscarChargeCadenceRule(item.user_id, item.regua_rule_id);
    if (!rule || !rule.ativo) {
      await markQueueItem(item.id, "skipped", {
        erro: "Etapa da régua não está mais ativa",
        processadoEm: Date.now(),
      });
      return;
    }

    templateOverride = rule.template_customizado;
  } else {
    const flagName = getNotificationFlagName(item.tipo);
    if (flagName && charge[flagName]) {
      await markQueueItem(item.id, "skipped", {
        erro: "Notificação já enviada anteriormente",
        processadoEm: Date.now(),
      });
      return;
    }
  }

  const result = await enviarNotificacaoWhatsApp(item.user_id, charge, item.tipo, {
    templateOverride,
    updateNotificationFlags: !isCadenceRule,
  });
  if (!result.ok) {
    throw new Error(result.error || "Falha ao enviar notificação");
  }

  await markQueueItem(item.id, "sent", {
    erro: null,
    processadoEm: Date.now(),
  });
}

async function processClaimedNotifications(rows: NotificationQueueRow[]) {
  for (let index = 0; index < rows.length; index += 1) {
    const item = rows[index];

    if (index > 0) {
      await sleep(NOTIFICATION_DELAY_BETWEEN_MS);
    }

    try {
      await processQueueItem(item);
    } catch (error) {
      const nextAttempts = Number(item.tentativas || 0) + 1;
      const retryAt =
        nextAttempts < Number(item.max_tentativas || 3)
          ? Date.now() + nextAttempts * NOTIFICATION_RETRY_BASE_MS
          : null;

      await markQueueItem(item.id, retryAt ? "pending" : "failed", {
        tentativas: nextAttempts,
        agendadoPara: retryAt,
        erro: error instanceof Error ? error.message : "Erro desconhecido",
        processadoEm: retryAt ? null : Date.now(),
      });
    }
  }
}

function attachShutdownHooks(state: WorkerState) {
  const stop = () => {
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export async function queueChargeNotification(input: {
  cobrancaId: number;
  userId: number;
  tipo: ChargeMessageType;
  reguaRuleId?: number;
  delayMs?: number;
  maxTentativas?: number;
}) {
  if (!Number.isFinite(Number(input.cobrancaId)) || Number(input.cobrancaId) <= 0) {
    throw new Error("Cobrança inválida para fila de notificação");
  }
  if (!Number.isFinite(Number(input.userId)) || Number(input.userId) <= 0) {
    throw new Error("Usuário inválido para fila de notificação");
  }
  if (!isQueueNotificationType(input.tipo)) {
    throw new Error("Tipo de notificação inválido");
  }

  const db = getDB();
  const now = Date.now();
  const scheduledFor = now + Math.max(0, Number(input.delayMs || 0));
  const maxTentativas = Math.max(1, Number(input.maxTentativas || 3));
  const reguaRuleId = Math.max(0, Math.floor(Number(input.reguaRuleId || 0)));

  await db.run(
    `
    INSERT INTO cobranca_notifications_queue (
      cobranca_id,
      user_id,
      tipo,
      regua_rule_id,
      tentativas,
      max_tentativas,
      agendado_para,
      processado_em,
      processing_started_at,
      status,
      erro,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)
    ON DUPLICATE KEY UPDATE
      max_tentativas = VALUES(max_tentativas),
      status = CASE
        WHEN status IN ('sent', 'skipped', 'processing') THEN status
        ELSE 'pending'
      END,
      tentativas = CASE
        WHEN status = 'failed' THEN 0
        ELSE tentativas
      END,
      agendado_para = CASE
        WHEN status IN ('sent', 'skipped', 'processing') THEN agendado_para
        ELSE LEAST(agendado_para, VALUES(agendado_para))
      END,
      processado_em = CASE
        WHEN status = 'failed' THEN NULL
        ELSE processado_em
      END,
      processing_started_at = CASE
        WHEN status = 'failed' THEN NULL
        ELSE processing_started_at
      END,
      erro = CASE
        WHEN status = 'failed' THEN NULL
        ELSE erro
      END,
      updated_at = VALUES(updated_at)
    `,
    [
      input.cobrancaId,
      input.userId,
      input.tipo,
      reguaRuleId,
      maxTentativas,
      scheduledFor,
      now,
      now,
    ]
  );
}

export function startNotificationWorker() {
  if (sharedWorkerState) return;

  const state: WorkerState = {
    running: false,
    stopped: false,
    timer: null,
    lastWatchdogAt: 0,
  };

  sharedWorkerState = state;
  attachShutdownHooks(state);

  const scheduleNext = (delayMs: number) => {
    if (state.stopped) return;
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      void runCycle();
    }, Math.max(0, delayMs));
    state.timer.unref?.();
  };

  const runCycle = async () => {
    if (state.stopped || state.running) return;
    state.running = true;

    let claimedRows: NotificationQueueRow[] = [];
    try {
      const now = Date.now();
      if (now - state.lastWatchdogAt >= NOTIFICATION_WATCHDOG_INTERVAL_MS) {
        await releaseStuckNotifications();
        state.lastWatchdogAt = now;
      }

      claimedRows = await claimDueNotifications(NOTIFICATION_BATCH_SIZE);
      await processClaimedNotifications(claimedRows);
    } catch (error) {
      console.error("❌ Erro crítico no worker de notificações:", error);
    } finally {
      state.running = false;
      if (state.stopped) return;

      scheduleNext(claimedRows.length ? 0 : NOTIFICATION_WORKER_IDLE_MS);
    }
  };

  console.log(
    `📨 Worker de notificações de cobrança ativo (batch=${NOTIFICATION_BATCH_SIZE}, delay=${NOTIFICATION_DELAY_BETWEEN_MS}ms)`
  );
  scheduleNext(0);
}
