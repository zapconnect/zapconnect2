import express from "express";
import { getDB } from "../database";

const router = express.Router();

type QuickReplyRow = {
  id: number;
  shortcut: string;
  title: string;
  content: string;
  created_at: string;
};

function normalizeShortcut(raw: unknown) {
  return String(raw || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 50);
}

function clipText(raw: unknown, maxLength: number) {
  return String(raw || "").trim().slice(0, maxLength);
}

router.get("/api/quick-replies", async (req, res) => {
  try {
    const user = (req as any).user;
    const userId = Number(user?.id || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "Usuário não autenticado.",
      });
    }

    const db = getDB();
    const replies = await db.all<QuickReplyRow>(
      `
      SELECT id, shortcut, title, content, created_at
      FROM quick_replies
      WHERE user_id = ?
      ORDER BY shortcut ASC, created_at DESC
      `,
      [userId]
    );

    return res.json({
      ok: true,
      replies,
    });
  } catch (err) {
    console.error("Erro ao listar quick replies:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível carregar as respostas rápidas.",
    });
  }
});

router.post("/api/quick-replies", async (req, res) => {
  try {
    const user = (req as any).user;
    const userId = Number(user?.id || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "Usuário não autenticado.",
      });
    }

    const shortcut = normalizeShortcut(req.body?.shortcut);
    const title = clipText(req.body?.title, 100);
    const content = clipText(req.body?.content, 6000);

    if (!shortcut || shortcut.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "Informe um atalho com pelo menos 2 caracteres.",
      });
    }

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Informe um título para a resposta rápida.",
      });
    }

    if (!content) {
      return res.status(400).json({
        ok: false,
        error: "Informe o conteúdo da resposta rápida.",
      });
    }

    const db = getDB();
    const existing = await db.get<{ id: number }>(
      `
      SELECT id
      FROM quick_replies
      WHERE user_id = ? AND shortcut = ?
      LIMIT 1
      `,
      [userId, shortcut]
    );

    if (existing?.id) {
      return res.status(409).json({
        ok: false,
        error: `O atalho /${shortcut} já existe.`,
      });
    }

    const result = await db.run(
      `
      INSERT INTO quick_replies (user_id, shortcut, title, content, created_at)
      VALUES (?, ?, ?, ?, NOW())
      `,
      [userId, shortcut, title, content]
    );

    const reply = await db.get<QuickReplyRow>(
      `
      SELECT id, shortcut, title, content, created_at
      FROM quick_replies
      WHERE id = ?
      LIMIT 1
      `,
      [Number(result.insertId)]
    );

    return res.json({
      ok: true,
      reply,
    });
  } catch (err) {
    console.error("Erro ao criar quick reply:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível salvar a resposta rápida.",
    });
  }
});

router.delete("/api/quick-replies/:id", async (req, res) => {
  try {
    const user = (req as any).user;
    const userId = Number(user?.id || 0);
    const id = Number(req.params.id || 0);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "Usuário não autenticado.",
      });
    }

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Resposta rápida inválida.",
      });
    }

    const db = getDB();
    const result = await db.run(
      `
      DELETE FROM quick_replies
      WHERE id = ? AND user_id = ?
      `,
      [id, userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        ok: false,
        error: "Resposta rápida não encontrada.",
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao remover quick reply:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível remover a resposta rápida.",
    });
  }
});

export default router;
