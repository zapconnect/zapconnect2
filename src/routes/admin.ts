import express from "express";
import { getDB } from "../database";
import { PLAN_NAMES } from "../config/plans";
import { listPlanConfigs, savePlanConfig } from "../services/planConfigs";
import { availableTrialKeys, listTrialTemplates, saveTrialTemplate } from "../services/trialTemplates";

const router = express.Router();
const email = "viniciussowza16@gmail.com";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ABANDONED_LEAD_WINDOW_MS = 30 * 60 * 1000;
const DASHBOARD_CACHE_TTL_MS = 2 * 60 * 1000;
const DASHBOARD_MAX_PAGE_SIZE = 100;
const DASHBOARD_DEFAULT_PAGE_SIZE = 15;
const DASHBOARD_SORT_FIELDS: Record<string, string> = {
  name: "u.name",
  plan: "u.plan",
  subscription_status: "u.subscription_status",
  last_payment_at: "lp.created_at",
  failures: "COALESCE(pf.failures, 0)",
};
let dashboardSummaryCache:
  | {
      data: {
        stats: Record<string, any>;
        chartData: Record<string, any>;
      };
      ts: number;
    }
  | null = null;

function clampInt(value: any, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function parseDashboardUsersQuery(req: express.Request) {
  const page = clampInt(req.query.page, 1, 1, 10_000);
  const pageSize = clampInt(
    req.query.pageSize,
    DASHBOARD_DEFAULT_PAGE_SIZE,
    1,
    DASHBOARD_MAX_PAGE_SIZE
  );
  const sortKeyRaw = String(req.query.sortKey || "").trim();
  const sortKey = Object.prototype.hasOwnProperty.call(
    DASHBOARD_SORT_FIELDS,
    sortKeyRaw
  )
    ? sortKeyRaw
    : null;
  const sortDir =
    String(req.query.sortDir || "").toLowerCase() === "desc" ? "DESC" : "ASC";
  const search = String(req.query.search || "").trim().slice(0, 100);
  const plan = PLAN_NAMES.includes(String(req.query.plan || "").trim().toLowerCase() as any)
    ? String(req.query.plan || "").trim().toLowerCase()
    : "";
  const status = ["active", "trial", "past_due", "cancelled"].includes(
    String(req.query.status || "").trim().toLowerCase()
  )
    ? String(req.query.status || "").trim().toLowerCase()
    : "";

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search,
    plan,
    status,
    sortKey,
    sortDir,
  };
}

function buildDashboardUserWhere(query: {
  search: string;
  plan: string;
  status: string;
}) {
  const clauses = ["1 = 1"];
  const params: any[] = [];

  if (query.search) {
    const term = `%${query.search}%`;
    clauses.push("(u.name LIKE ? OR u.email LIKE ?)");
    params.push(term, term);
  }

  if (query.plan) {
    clauses.push("u.plan = ?");
    params.push(query.plan);
  }

  if (query.status) {
    clauses.push("u.subscription_status = ?");
    params.push(query.status);
  }

  return {
    sql: clauses.join(" AND "),
    params,
  };
}

async function computeDashboardSummary(db: ReturnType<typeof getDB>) {
  const now = Date.now();
  const last30Days = now - THIRTY_DAYS_MS;
  const abandonedBefore = now - ABANDONED_LEAD_WINDOW_MS;

  const [
    userStats,
    paymentStats,
    leadStats,
    monthlyRevenue,
    dailyNewUsers,
    dailyPayments,
    rawPlanDistribution,
    topFailures,
  ] = await Promise.all([
    db.get<{
      totalUsers: number;
      active: number;
      cancelled: number;
      pastDue: number;
    }>(
      `
      SELECT
        COUNT(*) AS totalUsers,
        SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN subscription_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN subscription_status = 'past_due' THEN 1 ELSE 0 END) AS pastDue
      FROM users
      `
    ),
    db.get<{
      revenue: number;
      mrr: number;
      ticket: number;
    }>(
      `
      SELECT
        IFNULL(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0) AS revenue,
        IFNULL(SUM(CASE WHEN status = 'approved' AND created_at >= ? THEN amount ELSE 0 END), 0) AS mrr,
        IFNULL(AVG(CASE WHEN status = 'approved' THEN amount END), 0) AS ticket
      FROM payments
      `,
      [last30Days]
    ),
    db.get<{
      leads: number;
      abandoned: number;
    }>(
      `
      SELECT
        COUNT(CASE WHEN cl.event_type = 'preapproval_created' THEN 1 END) AS leads,
        COUNT(
          CASE
            WHEN cl.event_type = 'preapproval_created'
             AND cl.created_at < ?
             AND paid.user_id IS NULL
            THEN 1
          END
        ) AS abandoned
      FROM checkout_leads cl
      LEFT JOIN (
        SELECT DISTINCT user_id
        FROM payments
        WHERE status = 'approved'
      ) paid ON paid.user_id = cl.user_id
      `,
      [abandonedBefore]
    ),
    db.all(
      `
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m') AS month,
        SUM(amount) AS total
      FROM payments
      WHERE status = 'approved'
        AND created_at >= ?
      GROUP BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m')
      ORDER BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m') ASC
      `,
      [now - 7 * 30 * 24 * 60 * 60 * 1000]
    ),
    db.all(
      `
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
        COUNT(*) AS count
      FROM payments
      WHERE status = 'approved'
        AND created_at >= ?
      GROUP BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d')
      ORDER BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') ASC
      `,
      [now - 28 * 24 * 60 * 60 * 1000]
    ),
    db.all(
      `
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
        COUNT(*) AS count
      FROM payments
      WHERE status = 'approved'
        AND created_at >= ?
      GROUP BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d')
      ORDER BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') ASC
      `,
      [now - 49 * 24 * 60 * 60 * 1000]
    ),
    db.all<{ plan: string; total: number }>(
      `
      SELECT LOWER(COALESCE(plan, 'free')) AS plan, COUNT(*) AS total
      FROM users
      GROUP BY LOWER(COALESCE(plan, 'free'))
      `
    ),
    db.all(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.plan,
        pf.failures
      FROM users u
      JOIN (
        SELECT user_id, COUNT(*) AS failures
        FROM payments
        WHERE status <> 'approved'
        GROUP BY user_id
      ) pf ON pf.user_id = u.id
      ORDER BY pf.failures DESC, u.id DESC
      LIMIT 5
      `
    ),
  ]);

  const planDistribution = {
    free: 0,
    starter: 0,
    pro: 0,
  };

  for (const row of rawPlanDistribution || []) {
    const planName = String(row.plan || "free").toLowerCase();
    if (planName in planDistribution) {
      planDistribution[planName as keyof typeof planDistribution] += Number(
        row.total || 0
      );
    } else {
      planDistribution.free += Number(row.total || 0);
    }
  }

  return {
    stats: {
      totalUsers: Number(userStats?.totalUsers || 0),
      active: Number(userStats?.active || 0),
      cancelled: Number(userStats?.cancelled || 0),
      pastDue: Number(userStats?.pastDue || 0),
      revenue: Number(paymentStats?.revenue || 0),
      mrr: Number(paymentStats?.mrr || 0),
      ticket: Number(paymentStats?.ticket || 0),
      leads: Number(leadStats?.leads || 0),
      abandoned: Number(leadStats?.abandoned || 0),
    },
    chartData: {
      monthlyRevenue,
      dailyNewUsers,
      dailyPayments,
      planDistribution,
      topFailures,
    },
  };
}

async function getDashboardSummary(
  db: ReturnType<typeof getDB>,
  forceRefresh = false
) {
  if (
    !forceRefresh &&
    dashboardSummaryCache &&
    Date.now() - dashboardSummaryCache.ts < DASHBOARD_CACHE_TTL_MS
  ) {
    return dashboardSummaryCache.data;
  }

  const data = await computeDashboardSummary(db);
  dashboardSummaryCache = { data, ts: Date.now() };
  return data;
}

const getRequestIp = (req: any): string | null => {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = raw?.toString().split(",")[0].trim() || req.socket?.remoteAddress || null;
  return ip ? ip.replace(/^::ffff:/, "") : null;
};

router.get("/", (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).send("Acesso negado");
  res.render("dashboard");
});

router.get("/dashboard-data-legacy", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });
  return res.status(410).json({ error: "Endpoint legado desativado" });

  const db = getDB();

  // ── Stats gerais ──────────────────────────────────────────
  const totalUsers = (await db.get<{ t: number }>(`SELECT COUNT(*) t FROM users`))?.t ?? 0;
  const active     = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='active'`)).t;
  const cancelled  = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='cancelled'`)).t;
  const pastDue    = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='past_due'`)).t;

  const revenue = (await db.get(`
    SELECT IFNULL(SUM(amount),0) t
    FROM payments WHERE status='approved'
  `)).t;

  const mrr = (await db.get(`
    SELECT IFNULL(SUM(amount),0) t
    FROM payments
    WHERE status='approved'
      AND created_at >= ?
  `, [Date.now() - 30 * 24 * 60 * 60 * 1000])).t;

  const ticket = (await db.get(`
    SELECT IFNULL(AVG(amount),0) t
    FROM payments WHERE status='approved'
  `)).t;

  const leads = (await db.get(`
    SELECT COUNT(*) t
    FROM checkout_leads WHERE event_type='preapproval_created'
  `)).t;

  const abandoned = (await db.get(`
    SELECT COUNT(*) t FROM checkout_leads l
    WHERE l.event_type='preapproval_created'
      AND NOT EXISTS (
        SELECT 1 FROM payments p WHERE p.user_id = l.user_id
      )
  `)).t;

  // ── Receita mensal (últimos 7 meses) ──
  // payments.created_at é BIGINT (ms) — usa FROM_UNIXTIME(created_at / 1000)
  const monthlyRevenue = await db.all(`
    SELECT
      DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m') AS month,
      SUM(amount) AS total
    FROM payments
    WHERE status = 'approved'
      AND created_at >= ?
    GROUP BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m')
    ORDER BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m') ASC
  `, [Date.now() - 7 * 30 * 24 * 60 * 60 * 1000]);

  // ── Novos pagantes por dia (últimos 28 dias) ──
  // users não tem created_at — usa primeiro pagamento aprovado como proxy
  const dailyNewUsers = await db.all(`
    SELECT
      DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
      COUNT(*) AS count
    FROM payments
    WHERE status = 'approved'
      AND created_at >= ?
    GROUP BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d')
    ORDER BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') ASC
  `, [Date.now() - 28 * 24 * 60 * 60 * 1000]);

  // ── Pagamentos aprovados por dia (últimas 7 semanas — heatmap) ──
  const dailyPayments = await db.all(`
    SELECT
      DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
      COUNT(*) AS count
    FROM payments
    WHERE status = 'approved'
      AND created_at >= ?
    GROUP BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d')
    ORDER BY DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') ASC
  `, [Date.now() - 49 * 24 * 60 * 60 * 1000]);

  // ── Lista de usuários ──
  // users não tem created_at — removido da SELECT para evitar erro
  const users = await db.all(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.plan,
      u.subscription_status,

      (SELECT p.amount
       FROM payments p
       WHERE p.user_id = u.id AND p.status = 'approved'
       ORDER BY p.created_at DESC LIMIT 1) AS last_amount,

      (SELECT p.payment_method
       FROM payments p
       WHERE p.user_id = u.id AND p.status = 'approved'
       ORDER BY p.created_at DESC LIMIT 1) AS last_method,

      (SELECT p.created_at
       FROM payments p
       WHERE p.user_id = u.id AND p.status = 'approved'
       ORDER BY p.created_at DESC LIMIT 1) AS last_payment_at,

      (SELECT COUNT(*)
       FROM payments p
       WHERE p.user_id = u.id AND p.status != 'approved') AS failures,

      CASE
        WHEN EXISTS (
          SELECT 1 FROM checkout_leads cl
          WHERE cl.user_id = u.id
            AND cl.event_type = 'preapproval_created'
            AND cl.created_at < (UNIX_TIMESTAMP() * 1000 - 30 * 60 * 1000)
            AND NOT EXISTS (
              SELECT 1 FROM payments p2
              WHERE p2.user_id = u.id AND p2.status = 'approved'
            )
        ) THEN 1 ELSE 0
      END AS abandoned

    FROM users u
    ORDER BY abandoned DESC, u.id DESC
  `);

  res.json({
    stats: {
      totalUsers,
      active,
      cancelled,
      pastDue,
      revenue,
      mrr,
      ticket,
      leads,
      abandoned,
    },
    chartData: {
      monthlyRevenue,  // [{ month: '2025-01', total: 4200 }, ...]
      dailyNewUsers,   // [{ day: '2025-03-01', count: 12 }, ...]
      dailyPayments,   // [{ day: '2025-03-01', count: 8  }, ...]
    },
    users,
  });
});

router.get("/dashboard-data", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  try {
    const db = getDB();
    const forceRefresh = String(req.query.refresh || "") === "1";
    const query = parseDashboardUsersQuery(req);
    const summary = await getDashboardSummary(db, forceRefresh);
    const where = buildDashboardUserWhere(query);
    const abandonedBefore = Date.now() - ABANDONED_LEAD_WINDOW_MS;
    const totalRow = await db.get<{ total: number }>(
      `
      SELECT COUNT(*) AS total
      FROM users u
      WHERE ${where.sql}
      `,
      where.params
    );

    const sortSql = query.sortKey
      ? `${DASHBOARD_SORT_FIELDS[query.sortKey]} ${query.sortDir}, u.id DESC`
      : `abandoned DESC, u.id DESC`;

    const users = await db.all(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.plan,
        u.subscription_status,
        lp.amount AS last_amount,
        lp.payment_method AS last_method,
        lp.created_at AS last_payment_at,
        COALESCE(pf.failures, 0) AS failures,
        CASE WHEN ab.user_id IS NOT NULL THEN 1 ELSE 0 END AS abandoned
      FROM users u
      LEFT JOIN (
        SELECT ranked.user_id, ranked.amount, ranked.payment_method, ranked.created_at
        FROM (
          SELECT
            p.user_id,
            p.amount,
            p.payment_method,
            p.created_at,
            p.id,
            ROW_NUMBER() OVER (
              PARTITION BY p.user_id
              ORDER BY p.created_at DESC, p.id DESC
            ) AS rn
          FROM payments p
          WHERE p.status = 'approved'
        ) ranked
        WHERE ranked.rn = 1
      ) lp ON lp.user_id = u.id
      LEFT JOIN (
        SELECT p.user_id, COUNT(*) AS failures
        FROM payments p
        WHERE p.status <> 'approved'
        GROUP BY p.user_id
      ) pf ON pf.user_id = u.id
      LEFT JOIN (
        SELECT DISTINCT cl.user_id
        FROM checkout_leads cl
        LEFT JOIN (
          SELECT DISTINCT user_id
          FROM payments
          WHERE status = 'approved'
        ) paid ON paid.user_id = cl.user_id
        WHERE cl.event_type = 'preapproval_created'
          AND cl.created_at < ?
          AND paid.user_id IS NULL
      ) ab ON ab.user_id = u.id
      WHERE ${where.sql}
      ORDER BY ${sortSql}
      LIMIT ? OFFSET ?
      `,
      [abandonedBefore, ...where.params, query.pageSize, query.offset]
    );

    const total = Number(totalRow?.total || 0);
    const pages = Math.max(1, Math.ceil(total / query.pageSize));

    res.json({
      ...summary,
      users,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        pages,
      },
      filters: {
        search: query.search,
        plan: query.plan,
        status: query.status,
        sortKey: query.sortKey,
        sortDir: query.sortDir.toLowerCase(),
      },
    });
  } catch (error) {
    console.error("Erro ao carregar dashboard admin:", error);
    res.status(500).json({ error: "Falha ao carregar dashboard" });
  }
});

router.get("/plan-configs", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  try {
    const plans = await listPlanConfigs();
    return res.json({ ok: true, plans });
  } catch (err) {
    console.error("Erro ao listar configurações de plano:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar configurações" });
  }
});

router.post("/plan-configs", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  try {
    const {
      plan,
      displayName,
      badgeLabel,
      price,
      maxSessions,
      maxIaMessages,
      maxBroadcastNumbers,
      featureList,
      highlight,
    } = req.body || {};

    const safePlan = String(plan || "").trim().toLowerCase();
    if (!PLAN_NAMES.includes(safePlan as any)) {
      return res.status(400).json({ ok: false, error: "Plano inválido" });
    }

    const normalizedFeatures = Array.isArray(featureList)
      ? featureList
      : String(featureList || "")
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);

    if (!String(displayName || "").trim()) {
      return res.status(400).json({ ok: false, error: "Nome exibido é obrigatório" });
    }

    if (!normalizedFeatures.length) {
      return res.status(400).json({ ok: false, error: "Informe ao menos um benefício do plano" });
    }

    const saved = await savePlanConfig({
      plan: safePlan as any,
      displayName,
      badgeLabel,
      price,
      maxSessions,
      maxIaMessages,
      maxBroadcastNumbers,
      featureList: normalizedFeatures,
      highlight,
    });

    return res.json({ ok: true, plan: saved });
  } catch (err) {
    console.error("Erro ao salvar configuração de plano:", err);
    return res.status(500).json({ ok: false, error: "Erro ao salvar configuração" });
  }
});

// Templates de e-mail do trial
router.get("/email-templates", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  try {
    const templates = await listTrialTemplates();
    return res.json({ ok: true, templates });
  } catch (err) {
    console.error("Erro ao listar templates:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar templates" });
  }
});

router.post("/email-templates", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  try {
    const { key, subject, body } = req.body || {};
    const safeKey = String(key || "").trim();
    const safeSubject = String(subject || "").trim();
    const safeBody = String(body || "").trim();

    if (!safeKey || !availableTrialKeys().includes(safeKey as any)) {
      return res.status(400).json({ ok: false, error: "Template inválido" });
    }
    if (!safeSubject || !safeBody) {
      return res.status(400).json({ ok: false, error: "Subject e body são obrigatórios" });
    }

    await saveTrialTemplate({
      key: safeKey as any,
      subject: safeSubject.slice(0, 255),
      body: safeBody,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar template:", err);
    return res.status(500).json({ ok: false, error: "Erro ao salvar" });
  }
});

router.get("/abuse-report", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  try {
    const db = getDB();
    const since = Date.now() - THIRTY_DAYS_MS;

    const devices = await db.all(`
      SELECT device_id, user_id, account_count, blocked, block_reason, first_seen_at, last_seen_at
      FROM device_fingerprints
      WHERE account_count > 1
      ORDER BY account_count DESC, last_seen_at DESC
    `);

    const ips = await db.all(
      `
      SELECT
        ip,
        COUNT(DISTINCT user_id) AS accounts,
        MAX(created_at) AS last_seen
      FROM ip_registrations
      WHERE created_at >= ?
      GROUP BY ip
      HAVING accounts > 2
      ORDER BY accounts DESC, last_seen DESC
      `,
      [since]
    );

    const emails = await db.all(`
      SELECT email_normalized, COUNT(*) AS accounts
      FROM users
      WHERE email_normalized IS NOT NULL AND email_normalized <> ''
      GROUP BY email_normalized
      HAVING accounts > 1
      ORDER BY accounts DESC, email_normalized ASC
    `);

    return res.json({ ok: true, devices, ips, emails });
  } catch (err) {
    console.error("Erro ao gerar abuse-report:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

router.post("/block-device", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  const deviceId = String(req.body?.deviceId || "").trim();
  const reasonRaw = String(req.body?.reason || "").trim();
  const reason = reasonRaw ? reasonRaw.slice(0, 255) : "Bloqueado manualmente";

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId é obrigatório" });
  }

  try {
    const db = getDB();
    const device = await db.get<{ device_id: string }>(
      `SELECT device_id FROM device_fingerprints WHERE device_id = ?`,
      [deviceId]
    );

    if (!device) {
      return res.status(404).json({ error: "Dispositivo não encontrado" });
    }

    const now = Date.now();
    await db.run(
      `
      UPDATE device_fingerprints
      SET blocked = 1,
          block_reason = ?,
          last_seen_at = ?
      WHERE device_id = ?
      `,
      [reason, now, deviceId]
    );

    const trialUsers = await db.all<{ id: number }>(
      `
      SELECT id
      FROM users
      WHERE signup_device_id = ?
        AND subscription_status = 'trial'
      `,
      [deviceId]
    );

    for (const u of trialUsers) {
      await db.run(
        `
        UPDATE users
        SET subscription_status = 'cancelled',
            plan = 'free',
            plan_expires_at = ?
        WHERE id = ?
        `,
        [now, u.id]
      );
    }

    console.warn("device_blocked_admin", {
      reason,
      deviceId: deviceId.slice(0, 8),
      ip: getRequestIp(req),
      cancelledTrials: trialUsers.length,
    });

    return res.json({ ok: true, blocked: true, cancelledTrials: trialUsers.length });
  } catch (err) {
    console.error("Erro ao bloquear dispositivo:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

export default router;
