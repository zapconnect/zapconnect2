import express from "express";
import { subscriptionGuard } from "../middlewares/subscriptionGuard";
import {
  buildAnalyticsTrend,
  clampAnalyticsDays,
  ensureFreshAnalyticsReportForUser,
  formatReportDateForOffset,
  getAnalyticsAccess,
  getAnalyticsReportByDate,
  listAnalyticsReportsForUser,
  renderAnalyticsReportHtml,
} from "../services/analyticsService";

const router = express.Router();

function getUserTimezoneOffset(user: any) {
  const parsed = Number(user?.timezone_offset);
  return Number.isFinite(parsed) ? parsed : -180;
}

function serializeAccess(access: ReturnType<typeof getAnalyticsAccess>) {
  return {
    plan: access.plan,
    canExportPdf: access.canExportPdf,
    maxHistoryDays: access.maxHistoryDays,
    fullHistoryEnabled: access.fullHistoryEnabled,
  };
}

router.get("/analytics", subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const access = getAnalyticsAccess(user?.plan);

  res.render("analytics", {
    user,
    analyticsAccess: serializeAccess(access),
  });
});

router.get("/api/analytics/reports", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const access = getAnalyticsAccess(user?.plan);
    const timezoneOffsetMinutes = getUserTimezoneOffset(user);
    const days = clampAnalyticsDays(req.query.days, access);
    const shouldEnsure = String(req.query.ensure ?? "1") !== "0";
    const forceRefresh = String(req.query.refresh || "").trim() === "1";

    if (shouldEnsure) {
      await ensureFreshAnalyticsReportForUser({
        userId: Number(user.id),
        timezoneOffsetMinutes,
        force: forceRefresh,
      });
    }

    const reports = await listAnalyticsReportsForUser({
      userId: Number(user.id),
      days,
    });

    return res.json({
      ok: true,
      access: serializeAccess(access),
      days,
      todayReportDate: formatReportDateForOffset(Date.now(), timezoneOffsetMinutes),
      latestReport: reports[0] || null,
      reports,
      trend: buildAnalyticsTrend(reports),
    });
  } catch (err) {
    console.error("Erro ao listar analytics:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível carregar os relatórios de analytics.",
    });
  }
});

router.post("/api/analytics/generate", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const report = await ensureFreshAnalyticsReportForUser({
      userId: Number(user.id),
      timezoneOffsetMinutes: getUserTimezoneOffset(user),
      force: true,
    });

    return res.json({
      ok: true,
      report,
      access: serializeAccess(getAnalyticsAccess(user?.plan)),
    });
  } catch (err) {
    console.error("Erro ao gerar analytics manualmente:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível gerar o relatório agora.",
    });
  }
});

router.get("/api/analytics/export.pdf", subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const access = getAnalyticsAccess(user?.plan);

  if (!access.canExportPdf) {
    return res.status(403).json({
      ok: false,
      error: "Exportação em PDF disponível apenas no plano Pro.",
      upgradeRequired: true,
    });
  }

  try {
    const timezoneOffsetMinutes = getUserTimezoneOffset(user);
    const reportDate =
      String(req.query.reportDate || "").trim() ||
      formatReportDateForOffset(Date.now(), timezoneOffsetMinutes);
    const todayReportDate = formatReportDateForOffset(
      Date.now(),
      timezoneOffsetMinutes
    );

    let report = await getAnalyticsReportByDate(Number(user.id), reportDate);
    if (!report && reportDate === todayReportDate) {
      report = await ensureFreshAnalyticsReportForUser({
        userId: Number(user.id),
        timezoneOffsetMinutes,
        force: true,
      });
    }

    if (!report) {
      return res.status(404).json({
        ok: false,
        error: "Relatório não encontrado para exportação.",
      });
    }

    const puppeteerModule = await import("puppeteer");
    const browser = await puppeteerModule.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(
        renderAnalyticsReportHtml({
          userName: String(user?.name || "Cliente"),
          report,
        }),
        { waitUntil: "networkidle0" }
      );

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "20px",
          right: "20px",
          bottom: "20px",
          left: "20px",
        },
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="analytics-${report.reportDate}.pdf"`
      );
      return res.send(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error("Erro ao exportar analytics em PDF:", err);
    return res.status(500).json({
      ok: false,
      error: "Falha ao gerar o PDF do relatório.",
    });
  }
});

export default router;
