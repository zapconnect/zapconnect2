import { getDB } from "../database";
import { ensureFreshAnalyticsReportForUser } from "../services/analyticsService";

const ANALYTICS_WORKER_IDLE_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.ANALYTICS_WORKER_IDLE_MS || 60 * 60 * 1000)
);
const ANALYTICS_WORKER_BATCH_SIZE = Math.max(
  5,
  Number(process.env.ANALYTICS_WORKER_BATCH_SIZE || 25)
);
const ANALYTICS_WORKER_DELAY_BETWEEN_USERS_MS = Math.max(
  250,
  Number(process.env.ANALYTICS_WORKER_DELAY_BETWEEN_USERS_MS || 1_000)
);
const ANALYTICS_SOURCE_LOOKBACK_HOURS = Math.max(
  24,
  Number(process.env.ANALYTICS_SOURCE_LOOKBACK_HOURS || 36)
);

type AnalyticsWorkerState = {
  running: boolean;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  lastUserId: number;
};

type CandidateUserRow = {
  id: number;
  timezone_offset: number | string | null;
};

let sharedState: AnalyticsWorkerState | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listCandidateUsers(afterUserId: number) {
  const db = getDB();
  const rows = await db.all<CandidateUserRow>(
    `
    SELECT DISTINCT
      u.id,
      u.timezone_offset
    FROM users u
    INNER JOIN chat_histories ch
      ON ch.user_id = u.id
    WHERE ch.updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
      AND u.id > ?
    ORDER BY u.id ASC
    LIMIT ?
    `,
    [ANALYTICS_SOURCE_LOOKBACK_HOURS, afterUserId, ANALYTICS_WORKER_BATCH_SIZE]
  );

  if (rows.length || afterUserId <= 0) {
    return rows;
  }

  return db.all<CandidateUserRow>(
    `
    SELECT DISTINCT
      u.id,
      u.timezone_offset
    FROM users u
    INNER JOIN chat_histories ch
      ON ch.user_id = u.id
    WHERE ch.updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
    ORDER BY u.id ASC
    LIMIT ?
    `,
    [ANALYTICS_SOURCE_LOOKBACK_HOURS, ANALYTICS_WORKER_BATCH_SIZE]
  );
}

async function runAnalyticsSweep(state: AnalyticsWorkerState) {
  if (state.running || state.stopped) return;
  state.running = true;

  try {
    const users = await listCandidateUsers(state.lastUserId);

    for (const user of users) {
      if (state.stopped) break;

      try {
        await ensureFreshAnalyticsReportForUser({
          userId: Number(user.id),
          timezoneOffsetMinutes: Number(user.timezone_offset || -180),
          minAgeMs: ANALYTICS_WORKER_IDLE_MS,
        });
      } catch (err) {
        console.error("Erro ao gerar analytics diário:", {
          userId: user.id,
          err,
        });
      }

      state.lastUserId = Number(user.id) || state.lastUserId;
      await sleep(ANALYTICS_WORKER_DELAY_BETWEEN_USERS_MS);
    }
  } catch (err) {
    console.error("Erro no sweep de analytics:", err);
  } finally {
    state.running = false;

    if (!state.stopped) {
      state.timer = setTimeout(
        () => runAnalyticsSweep(state),
        ANALYTICS_WORKER_IDLE_MS
      );
      if (typeof state.timer.unref === "function") {
        state.timer.unref();
      }
    }
  }
}

export function startAnalyticsWorker() {
  if (sharedState) return sharedState;

  sharedState = {
    running: false,
    stopped: false,
    timer: null,
    lastUserId: 0,
  };

  void runAnalyticsSweep(sharedState);
  return sharedState;
}
