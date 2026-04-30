import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const rootDir = process.cwd();
const carouselDir = path.join(
  rootDir,
  "public",
  "img",
  "carousel-zapconnect",
  "conheca-zapconnect-v5-ptbr-azul-bio",
);

const logoPath = path.join(rootDir, "public", "img", "logo3.png");
const backgrounds = {
  cover: path.join(
    rootDir,
    "public",
    "img",
    "carousel-zapconnect",
    "base",
    "bg-01-cover.png",
  ),
  ia: path.join(
    rootDir,
    "public",
    "img",
    "carousel-zapconnect",
    "base",
    "bg-02-ia.png",
  ),
  crm: path.join(
    rootDir,
    "public",
    "img",
    "carousel-zapconnect",
    "base",
    "bg-04-crm.png",
  ),
  campaign: path.join(
    rootDir,
    "public",
    "img",
    "carousel-zapconnect",
    "base",
    "bg-03-multissessoes.png",
  ),
  flows: path.join(
    rootDir,
    "public",
    "img",
    "carousel-zapconnect",
    "base",
    "bg-00-sobre.png",
  ),
  finance: path.join(
    rootDir,
    "public",
    "img",
    "carousel-zapconnect",
    "base",
    "bg-05-vendas.png",
  ),
  cta: path.join(
    os.homedir(),
    ".codex",
    "generated_images",
    "019dc60c-a121-7450-bfa1-9065da1e8b66",
    "ig_0730325e28c06ffe0169ed128c00dc819b9d26478a563816dd.png",
  ),
};

const BLUE_ACCENT = "#4F6EF7";

const slides = [
  {
    file: "slide-01-capa.png",
    number: "01",
    bg: backgrounds.cover,
    showSwipeHint: true,
    kicker: "CONHEÇA",
    titleLines: ["Conheça o", "ZapConnect"],
    body:
      "Atendimento, vendas e automação no WhatsApp em um só lugar para a sua operação crescer com mais controle.",
    chips: ["IA", "CRM", "Automação"],
    footer: "Arraste e veja como funciona.",
    accent: "#6C64EF",
  },
  {
    file: "slide-02-ia-24h.png",
    number: "02",
    bg: backgrounds.ia,
    showSwipeHint: true,
    kicker: "IA NO WHATSAPP",
    titleLines: ["Sua IA", "responde 24h"],
    body:
      "Automatize respostas com ChatGPT ou Gemini e mantenha seu atendimento ativo mesmo fora do horário.",
    chips: ["ChatGPT", "Gemini", "24h"],
    footer: "Mais velocidade, contexto e escala.",
    accent: BLUE_ACCENT,
  },
  {
    file: "slide-03-crm-kanban.png",
    number: "03",
    bg: backgrounds.crm,
    showSwipeHint: true,
    kicker: "CRM KANBAN",
    titleLines: ["Pipeline", "mais visível"],
    body:
      "Gerencie leads, etapas e acompanhamentos em um CRM visual para acompanhar o avançar de cada oportunidade.",
    chips: ["Leads", "Etapas", "Acompanhamento"],
    footer: "Venda com mais clareza no dia a dia.",
    accent: "#6C64EF",
  },
  {
    file: "slide-04-disparo-agendamento.png",
    number: "04",
    bg: backgrounds.campaign,
    showSwipeHint: true,
    kicker: "DISPARO E AGENDA",
    titleLines: ["Envie na", "hora certa"],
    body:
      "Dispare em massa, programe campanhas e agende mensagens para ativações, lembretes e reengajamento.",
    chips: ["Lista", "Agendamento", "Escala"],
    footer: "Mais previsibilidade para suas campanhas.",
    accent: "#6C64EF",
    sideCard: {
      title: "Agendado",
      lines: ["Lista pronta", "09:30 de amanhã"],
      accent: BLUE_ACCENT,
    },
  },
  {
    file: "slide-05-fluxos-automacao.png",
    number: "05",
    bg: backgrounds.flows,
    showSwipeHint: true,
    kicker: "FLUXOS INTELIGENTES",
    titleLines: ["Automação", "sem código"],
    body:
      "Crie fluxos para qualificar contatos, responder dúvidas e direcionar cada conversa para o próximo passo.",
    chips: ["Fluxos", "Gatilhos", "Sem código"],
    footer: "Processos que continuam rodando sozinhos.",
    accent: "#6C64EF",
    sideCard: {
      title: "Fluxo ativo",
      lines: ["Captou lead", "Qualificou e enviou"],
      accent: "#6C64EF",
    },
  },
  {
    file: "slide-06-cobrancas.png",
    number: "06",
    bg: backgrounds.finance,
    showSwipeHint: true,
    kicker: "COBRANÇAS",
    titleLines: ["Cobrança com", "aviso no WPP"],
    body:
      "Controle cobranças recorrentes e envie notificações no WhatsApp para lembrar, confirmar e acompanhar pagamentos.",
    chips: ["Recorrência", "Lembretes", "PIX"],
    footer: "Menos atraso e menos retrabalho no financeiro.",
    accent: BLUE_ACCENT,
    sideCard: {
      title: "Lembrete enviado",
      lines: ["Vencimento em 2 dias", "WhatsApp notificado"],
      accent: BLUE_ACCENT,
    },
  },
  {
    file: "slide-07-cta.png",
    number: "07",
    bg: backgrounds.cta,
    showSwipeHint: false,
    recolorBackground: "green-to-blue",
    kicker: "COMECE AGORA",
    titleLines: ["Comece com o", "ZapConnect"],
    body:
      "Centralize atendimento, vendas, automação e cobrança em uma plataforma pronta para escalar com você.",
    chips: ["Início rápido", "Escala", "Operação"],
    footer: "",
    accent: BLUE_ACCENT,
    cta: "Clique no link na bio",
  },
];

function esc(value) {
  const accentMap = new Map([
    ["á", "&#225;"],
    ["à", "&#224;"],
    ["â", "&#226;"],
    ["ã", "&#227;"],
    ["é", "&#233;"],
    ["ê", "&#234;"],
    ["í", "&#237;"],
    ["ó", "&#243;"],
    ["ô", "&#244;"],
    ["õ", "&#245;"],
    ["ú", "&#250;"],
    ["ç", "&#231;"],
    ["Á", "&#193;"],
    ["À", "&#192;"],
    ["Â", "&#194;"],
    ["Ã", "&#195;"],
    ["É", "&#201;"],
    ["Ê", "&#202;"],
    ["Í", "&#205;"],
    ["Ó", "&#211;"],
    ["Ô", "&#212;"],
    ["Õ", "&#213;"],
    ["Ú", "&#218;"],
    ["Ç", "&#199;"],
  ]);

  let safe = String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

  for (const [char, entity] of accentMap.entries()) {
    safe = safe.replaceAll(char, entity);
  }

  return safe;
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }

    h /= 6;
  }

  return { h: h * 360, s, l };
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;

  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }

  const hue2rgb = (p, q, t) => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hue) * 255),
    b: Math.round(hue2rgb(p, q, hue - 1 / 3) * 255),
  };
}

async function recolorGreenToBlue(buffer, targetHex) {
  const target = hexToRgb(targetHex);
  const targetHsl = rgbToHsl(target.r, target.g, target.b);
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const { h, s, l } = rgbToHsl(r, g, b);

    const isGreenish =
      h >= 110 &&
      h <= 190 &&
      s >= 0.2 &&
      l >= 0.12 &&
      l <= 0.92 &&
      g >= r * 1.05;

    if (!isGreenish) continue;

    const next = hslToRgb(targetHsl.h, Math.max(s, 0.5), l);
    data[i] = next.r;
    data[i + 1] = next.g;
    data[i + 2] = next.b;
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels,
    },
  })
    .png()
    .toBuffer();
}

function renderTextLines({
  lines,
  x,
  y,
  fontSize,
  lineHeight,
  fill,
  weight = 700,
  family = "Segoe UI, Arial, sans-serif",
  letterSpacing = 0,
}) {
  return lines
    .map((line, index) => {
      const lineY = y + index * lineHeight;
      return `<text x="${x}" y="${lineY}" fill="${fill}" font-family="${family}" font-size="${fontSize}" font-weight="${weight}" letter-spacing="${letterSpacing}">${esc(line)}</text>`;
    })
    .join("");
}

function chipWidth(label) {
  return 26 + label.length * 13;
}

function renderChips(chips, accent) {
  let x = 82;
  const y = 860;

  return chips
    .map((chip) => {
      const width = chipWidth(chip);
      const group = `
        <g transform="translate(${x} ${y})">
          <rect width="${width}" height="54" rx="18" fill="rgba(108,100,239,0.16)" stroke="rgba(255,255,255,0.16)" />
          <text x="${width / 2}" y="35" fill="#FFFFFF" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="21" font-weight="700">${esc(chip)}</text>
          <rect x="10" y="10" width="8" height="34" rx="4" fill="${accent}" opacity="0.85" />
        </g>
      `;
      x += width + 14;
      return group;
    })
    .join("");
}

function renderSideCard(card) {
  if (!card) return "";

  const titleLines = wrapText(card.title, 20);
  const metaLines = card.lines.flatMap((line) => wrapText(line, 24));
  const titleSvg = renderTextLines({
    lines: titleLines,
    x: 662,
    y: 730,
    fontSize: 24,
    lineHeight: 30,
    fill: "#FFFFFF",
    weight: 800,
  });
  const metaSvg = renderTextLines({
    lines: metaLines,
    x: 662,
    y: 776,
    fontSize: 18,
    lineHeight: 25,
    fill: "#AAB0D9",
    weight: 600,
  });

  return `
    <g transform="translate(628 688)">
      <rect width="316" height="150" rx="28" fill="rgba(9,12,28,0.78)" stroke="rgba(255,255,255,0.14)" />
      <rect x="26" y="28" width="52" height="52" rx="18" fill="${card.accent}" opacity="0.16" stroke="${card.accent}" stroke-opacity="0.65" />
      <circle cx="52" cy="54" r="10" fill="${card.accent}" />
      <rect x="98" y="40" width="160" height="10" rx="5" fill="rgba(255,255,255,0.18)" />
      <rect x="98" y="60" width="112" height="8" rx="4" fill="rgba(255,255,255,0.08)" />
      <rect x="26" y="104" width="264" height="10" rx="5" fill="rgba(255,255,255,0.08)" />
      <rect x="26" y="122" width="210" height="10" rx="5" fill="rgba(255,255,255,0.06)" />
    </g>
    ${titleSvg}
    ${metaSvg}
  `;
}

function overlaySvg(slide) {
  const bodyLines = wrapText(slide.body, 33);
  const footerLines = wrapText(slide.footer, 38);
  const titleSvg = renderTextLines({
    lines: slide.titleLines,
    x: 84,
    y: 364,
    fontSize: 78,
    lineHeight: 86,
    fill: "#FFFFFF",
    weight: 900,
    letterSpacing: -1.4,
  });
  const bodySvg = renderTextLines({
    lines: bodyLines,
    x: 84,
    y: 590,
    fontSize: 28,
    lineHeight: 40,
    fill: "#AAB0D9",
    weight: 600,
  });
  const footerSvg = renderTextLines({
    lines: footerLines,
    x: 84,
    y: slide.cta ? 820 : 950,
    fontSize: 24,
    lineHeight: 30,
    fill: "#D8DDF8",
    weight: 700,
  });

  const ctaSvg = slide.cta
    ? `
      <g transform="translate(82 770)">
        <rect width="400" height="72" rx="24" fill="${slide.accent}" />
        <text x="200" y="46" fill="#0D1222" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="25" font-weight="900">${esc(slide.cta.toUpperCase())}</text>
      </g>
    `
    : "";

  return `
  <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shade-left" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#060913" stop-opacity="0.98" />
        <stop offset="55%" stop-color="#060913" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#060913" stop-opacity="0.15" />
      </linearGradient>
      <linearGradient id="panel-fill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0B1020" stop-opacity="0.88" />
        <stop offset="100%" stop-color="#0F1730" stop-opacity="0.66" />
      </linearGradient>
      <linearGradient id="top-band" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6C64EF" stop-opacity="0.50" />
        <stop offset="100%" stop-color="#6C64EF" stop-opacity="0" />
      </linearGradient>
    </defs>

    <rect width="1080" height="180" fill="url(#top-band)" />
    <rect width="1080" height="1080" fill="url(#shade-left)" />

    <g transform="translate(872 74)">
      <rect width="134" height="72" rx="24" fill="rgba(108,100,239,0.18)" stroke="rgba(255,255,255,0.14)" />
      <text x="67" y="46" fill="#FFFFFF" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="900">${esc(slide.number)}</text>
    </g>

    <g transform="translate(52 228)">
      <rect width="516" height="728" rx="34" fill="url(#panel-fill)" stroke="rgba(141,127,255,0.44)" />
    </g>

    <g transform="translate(82 268)">
      <rect width="${Math.max(176, slide.kicker.length * 14 + 48)}" height="50" rx="18" fill="rgba(108,100,239,0.22)" stroke="rgba(255,255,255,0.18)" />
      <text x="20" y="33" fill="#FFFFFF" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="800">${esc(slide.kicker)}</text>
    </g>

    ${titleSvg}

    <rect x="84" y="${372 + slide.titleLines.length * 86}" width="174" height="6" rx="3" fill="${slide.accent}" />

    ${bodySvg}
    ${ctaSvg}
    ${footerSvg}
    ${renderChips(slide.chips, slide.accent)}
    ${renderSideCard(slide.sideCard)}

    ${
      slide.showSwipeHint === false
        ? ""
        : `
    <g transform="translate(776 1000)">
      <rect width="258" height="48" rx="18" fill="rgba(9,12,28,0.78)" stroke="rgba(255,255,255,0.12)" />
      <circle cx="28" cy="24" r="5" fill="${slide.accent}" />
      <text x="48" y="31" fill="#FFFFFF" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="800" letter-spacing="0.8">ARRASTE PARA O LADO</text>
    </g>`
    }
  </svg>
  `;
}

async function buildSlide(slide, logoBuffer) {
  let background = await sharp(slide.bg)
    .resize(1080, 1080, { fit: "cover" })
    .modulate({ brightness: 0.92, saturation: 1.06 })
    .png()
    .toBuffer();

  if (slide.recolorBackground === "green-to-blue") {
    background = await recolorGreenToBlue(background, BLUE_ACCENT);
  }

  const overlay = Buffer.from(overlaySvg(slide));
  const logo = await sharp(logoBuffer).resize({ width: 248 }).png().toBuffer();

  const outputPath = path.join(carouselDir, slide.file);

  await sharp(background)
    .composite([
      { input: overlay, top: 0, left: 0 },
      { input: logo, top: 52, left: 58 },
    ])
    .png()
    .toFile(outputPath);

  return outputPath;
}

async function buildOverview(files) {
  const cardWidth = 360;
  const cardHeight = 360;
  const padding = 36;
  const columns = 3;
  const rows = Math.ceil(files.length / columns);
  const width = columns * cardWidth + (columns + 1) * padding;
  const height = rows * cardHeight + (rows + 1) * padding;

  const canvas = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#060913",
    },
  });

  const composites = await Promise.all(
    files.map(async (file, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const left = padding + col * (cardWidth + padding);
      const top = padding + row * (cardHeight + padding);
      const thumb = await sharp(file).resize(cardWidth, cardHeight).png().toBuffer();
      return { input: thumb, left, top };
    }),
  );

  await canvas
    .composite(composites)
    .png()
    .toFile(path.join(carouselDir, "overview-grid.png"));
}

async function main() {
  await fs.mkdir(carouselDir, { recursive: true });
  const logoBuffer = await fs.readFile(logoPath);
  const outputs = [];

  for (const slide of slides) {
    outputs.push(await buildSlide(slide, logoBuffer));
  }

  await buildOverview(outputs);

  for (const file of outputs) {
    console.log(file);
  }
  console.log(path.join(carouselDir, "overview-grid.png"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
