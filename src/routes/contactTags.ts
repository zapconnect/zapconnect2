import express from "express";
import { getDB } from "../database";
import { emitToUser } from "../lib/socketEmitter";

const router = express.Router();

const CONTACT_TAG_PRESETS = [
  "Quente",
  "Morno",
  "Frio",
  "VIP",
  "Suporte",
] as const;

type ContactTagPreset = (typeof CONTACT_TAG_PRESETS)[number];

type CrmTagRow = {
  id: number;
  phone: string;
  name: string;
  tags: string | null;
};

function normalizePhone(raw: unknown) {
  return String(raw || "")
    .trim()
    .replace(/@.*/, "")
    .replace(/\D/g, "")
    .slice(0, 30);
}

function normalizeText(raw: unknown, maxLength: number) {
  return String(raw || "").trim().slice(0, maxLength);
}

function parseTags(raw: unknown) {
  try {
    const list = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
    if (!Array.isArray(list)) return [];

    const seen = new Set<string>();
    return list
      .map((item) => normalizeText(item, 30))
      .filter((item) => {
        if (!item) return false;
        const key = item.toLocaleLowerCase("pt-BR");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch {
    return [];
  }
}

function normalizePresetTag(raw: unknown): ContactTagPreset | "" {
  const incoming = normalizeText(raw, 30).toLocaleLowerCase("pt-BR");
  const match = CONTACT_TAG_PRESETS.find(
    (tag) => tag.toLocaleLowerCase("pt-BR") === incoming
  );
  return match || "";
}

router.get("/api/contact-tags", async (req, res) => {
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
    const rows = await db.all<CrmTagRow>(
      `
      SELECT id, phone, name, tags
      FROM crm
      WHERE user_id = ?
      ORDER BY id DESC
      `,
      [userId]
    );

    const tagsByPhone: Record<string, string[]> = {};
    for (const row of rows) {
      const phone = normalizePhone(row.phone);
      if (!phone) continue;
      const tags = parseTags(row.tags);
      if (!tags.length) continue;
      tagsByPhone[phone] = tags;
    }

    return res.json({
      ok: true,
      tagsByPhone,
      presets: CONTACT_TAG_PRESETS,
    });
  } catch (err) {
    console.error("Erro ao listar contact tags:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível carregar as tags dos contatos.",
    });
  }
});

router.post("/api/contact-tags/:phone", async (req, res) => {
  try {
    const user = (req as any).user;
    const userId = Number(user?.id || 0);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "Usuário não autenticado.",
      });
    }

    const phone = normalizePhone(req.params.phone || req.body?.phone || req.body?.chatId);
    const tag = normalizePresetTag(req.body?.tag);
    const fallbackName = normalizeText(req.body?.name, 255);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Contato inválido.",
      });
    }

    if (!tag) {
      return res.status(400).json({
        ok: false,
        error: "Tag inválida.",
      });
    }

    const db = getDB();
    let row = await db.get<CrmTagRow>(
      `
      SELECT id, phone, name, tags
      FROM crm
      WHERE user_id = ? AND phone = ?
      LIMIT 1
      `,
      [userId, phone]
    );
    const hadExistingRow = Boolean(row?.id);

    if (!row?.id) {
      const displayName = fallbackName || phone;
      const insertResult = await db.run(
        `
        INSERT INTO crm (
          user_id,
          name,
          phone,
          citystate,
          tags,
          notes,
          stage,
          last_seen,
          avatar,
          deal_value,
          follow_up_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          userId,
          displayName,
          phone,
          "",
          "[]",
          "[]",
          "Novo",
          Date.now(),
          null,
          0,
          null,
        ]
      );

      row = {
        id: Number((insertResult as any)?.insertId || 0),
        phone,
        name: displayName,
        tags: "[]",
      };
    }

    const tags = parseTags(row.tags);
    if (!tags.includes(tag)) {
      tags.push(tag);
      await db.run(`UPDATE crm SET tags = ? WHERE id = ? AND user_id = ?`, [
        JSON.stringify(tags),
        row.id,
        userId,
      ]);
    }

    emitToUser(userId, "contact-tags:changed", {
      chatId: `${phone}@c.us`,
      phone,
      tags,
    });
    emitToUser(userId, "crm:changed", {
      type: hadExistingRow ? "update" : "create",
      id: row?.id || null,
    });

    return res.json({
      ok: true,
      phone,
      chatId: `${phone}@c.us`,
      tags,
    });
  } catch (err) {
    console.error("Erro ao salvar contact tag:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível salvar a tag do contato.",
    });
  }
});

router.delete("/api/contact-tags/:phone", async (req, res) => {
  try {
    const user = (req as any).user;
    const userId = Number(user?.id || 0);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "Usuário não autenticado.",
      });
    }

    const phone = normalizePhone(req.params.phone || req.body?.phone || req.body?.chatId);
    const tag = normalizeText(req.body?.tag, 30);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Contato inválido.",
      });
    }

    if (!tag) {
      return res.status(400).json({
        ok: false,
        error: "Tag inválida.",
      });
    }

    const db = getDB();
    const row = await db.get<CrmTagRow>(
      `
      SELECT id, phone, name, tags
      FROM crm
      WHERE user_id = ? AND phone = ?
      LIMIT 1
      `,
      [userId, phone]
    );

    if (!row?.id) {
      return res.json({
        ok: true,
        phone,
        chatId: `${phone}@c.us`,
        tags: [],
      });
    }

    const tags = parseTags(row.tags).filter(
      (item) => item.toLocaleLowerCase("pt-BR") !== tag.toLocaleLowerCase("pt-BR")
    );

    await db.run(`UPDATE crm SET tags = ? WHERE id = ? AND user_id = ?`, [
      JSON.stringify(tags),
      row.id,
      userId,
    ]);

    emitToUser(userId, "contact-tags:changed", {
      chatId: `${phone}@c.us`,
      phone,
      tags,
    });
    emitToUser(userId, "crm:changed", {
      type: "update",
      id: row.id,
    });

    return res.json({
      ok: true,
      phone,
      chatId: `${phone}@c.us`,
      tags,
    });
  } catch (err) {
    console.error("Erro ao remover contact tag:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível remover a tag do contato.",
    });
  }
});

export default router;
