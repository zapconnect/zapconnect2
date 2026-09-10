from pathlib import Path
from datetime import date

from reportlab.lib import colors
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "zapconnect_documentacao_do_sistema.pdf"
ASSETS = ROOT / "public" / "img"
CAROUSEL = ASSETS / "carousel-zapconnect" / "conheca-zapconnect-v5-ptbr-azul-bio"

PAGE_W, PAGE_H = A4
MARGIN = 42

# Tokens extraidos de public/css/design-tokens.css.
INK = HexColor("#0D1222")
INK_2 = HexColor("#161B30")
INK_3 = HexColor("#1A1F3A")
LINE = HexColor("#373E59")
WHITE = HexColor("#FFFFFF")
MUTED = HexColor("#AAB0D9")
DIM = HexColor("#7F88A8")
VIOLET = HexColor("#6C64EF")
VIOLET_2 = HexColor("#8B5CF6")
MINT = HexColor("#2EE6A6")
BLUE = HexColor("#52B6FF")
AMBER = HexColor("#F2C94C")
PINK = HexColor("#F472B6")
ORANGE = HexColor("#FB923C")
DANGER = HexColor("#E54848")


def ensure_fonts():
    fonts = Path("C:/Windows/Fonts")
    regular = fonts / "arial.ttf"
    bold = fonts / "arialbd.ttf"
    if regular.exists() and bold.exists():
        pdfmetrics.registerFont(TTFont("ZapSans", str(regular)))
        pdfmetrics.registerFont(TTFont("ZapSans-Bold", str(bold)))
        return "ZapSans", "ZapSans-Bold"
    return "Helvetica", "Helvetica-Bold"


REGULAR, BOLD = ensure_fonts()


def pstyle(size=10, leading=None, color=WHITE, font=REGULAR, align=TA_LEFT):
    return ParagraphStyle(
        name=f"s{size}_{font}_{align}",
        fontName=font,
        fontSize=size,
        leading=leading or size * 1.35,
        textColor=color,
        alignment=align,
        allowWidows=1,
        allowOrphans=1,
        splitLongWords=1,
    )


def para(c, text, x, y_top, width, style):
    story = Paragraph(text, style)
    _, h = story.wrap(width, 1000)
    story.drawOn(c, x, y_top - h)
    return h


def draw_round(c, x, y, w, h, fill, stroke=None, radius=14, stroke_width=1):
    c.setLineWidth(stroke_width)
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1 if stroke else 0)


def draw_bg(c, page_no, section="DOCUMENTACAO DO SISTEMA"):
    c.setFillColor(INK)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(Color(0.42, 0.39, 0.94, alpha=0.10))
    c.circle(PAGE_W - 22, PAGE_H - 10, 155, fill=1, stroke=0)
    c.setFillColor(Color(0.18, 0.90, 0.65, alpha=0.045))
    c.circle(12, 42, 118, fill=1, stroke=0)
    c.setFillColor(LINE)
    c.rect(MARGIN, 24, PAGE_W - MARGIN * 2, 0.6, fill=1, stroke=0)
    c.setFillColor(DIM)
    c.setFont(REGULAR, 7.5)
    c.drawString(MARGIN, 12, "ZAPCONNECT  |  Atendimento, automacao e IA no WhatsApp")
    c.drawRightString(PAGE_W - MARGIN, 12, f"{section}  |  {page_no:02d}")


def draw_logo(c, x, y_top, max_w=126, max_h=30, opacity=1):
    path = ASSETS / "logo3.png"
    if not path.exists():
        return
    img = ImageReader(str(path))
    iw, ih = img.getSize()
    scale = min(max_w / iw, max_h / ih)
    w, h = iw * scale, ih * scale
    c.saveState()
    if opacity < 1:
        c.setFillAlpha(opacity)
    c.drawImage(img, x, y_top - h, width=w, height=h, mask="auto")
    c.restoreState()


def heading(c, eyebrow, title, intro=None, y=770, width=500):
    c.setFillColor(VIOLET_2)
    c.setFont(BOLD, 8.5)
    c.drawString(MARGIN, y, eyebrow.upper())
    c.setFillColor(WHITE)
    h = para(c, title, MARGIN, y - 13, width, pstyle(23, 27, WHITE, BOLD))
    y2 = y - 19 - h
    if intro:
        h2 = para(c, intro, MARGIN, y2, width, pstyle(10.5, 15, MUTED))
        y2 -= h2 + 8
    return y2


def image_cover(c, path, x, y, w, h, radius=14, darken=False):
    if not path.exists():
        draw_round(c, x, y, w, h, INK_3, LINE, radius)
        c.setFillColor(MUTED)
        c.setFont(REGULAR, 9)
        c.drawCentredString(x + w / 2, y + h / 2, "Referencia visual indisponivel")
        return
    img = ImageReader(str(path))
    iw, ih = img.getSize()
    scale = max(w / iw, h / ih)
    sw, sh = iw * scale, ih * scale
    sx = x + (w - sw) / 2
    sy = y + (h - sh) / 2
    c.saveState()
    clip = c.beginPath()
    clip.roundRect(x, y, w, h, radius)
    c.clipPath(clip, stroke=0, fill=0)
    c.drawImage(img, sx, sy, width=sw, height=sh, mask="auto")
    if darken:
        c.setFillColor(Color(0.05, 0.07, 0.14, alpha=0.28))
        c.rect(x, y, w, h, fill=1, stroke=0)
    c.restoreState()
    c.setLineWidth(0.8)
    c.setStrokeColor(Color(0.55, 0.52, 0.96, alpha=0.55))
    c.roundRect(x, y, w, h, radius, fill=0, stroke=1)


def tag(c, x, y, label, color=VIOLET, text_color=WHITE):
    c.setFont(BOLD, 7)
    width = c.stringWidth(label, BOLD, 7) + 16
    draw_round(c, x, y, width, 18, Color(color.red, color.green, color.blue, alpha=0.18), color, 9, 0.6)
    c.setFillColor(text_color)
    c.drawCentredString(x + width / 2, y + 5.2, label)
    return width


def icon_badge(c, x, y, kind, color=VIOLET):
    """Simple vector icon badge; labels mirror the Font Awesome icons in the app."""
    c.setFillColor(Color(color.red, color.green, color.blue, alpha=0.16))
    c.circle(x + 18, y + 18, 18, fill=1, stroke=0)
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.8)
    if kind == "chat":
        c.roundRect(x + 9, y + 11, 18, 13, 3, fill=0, stroke=1)
        c.line(x + 14, y + 11, x + 12, y + 7)
        c.circle(x + 14, y + 17.5, 0.7, fill=1, stroke=0)
        c.circle(x + 18, y + 17.5, 0.7, fill=1, stroke=0)
        c.circle(x + 22, y + 17.5, 0.7, fill=1, stroke=0)
    elif kind == "robot":
        c.roundRect(x + 9, y + 11, 18, 15, 4, fill=0, stroke=1)
        c.line(x + 18, y + 26, x + 18, y + 30)
        c.circle(x + 18, y + 31, 1.6, fill=0, stroke=1)
        c.circle(x + 14, y + 19, 1.1, fill=1, stroke=0)
        c.circle(x + 22, y + 19, 1.1, fill=1, stroke=0)
        c.line(x + 14, y + 14.5, x + 22, y + 14.5)
    elif kind == "crm":
        c.circle(x + 18, y + 23, 4, fill=0, stroke=1)
        c.arc(x + 10, y + 8, x + 26, y + 22, 25, 130)
    elif kind == "chart":
        c.line(x + 10, y + 10, x + 10, y + 25)
        c.line(x + 10, y + 10, x + 27, y + 10)
        c.line(x + 12, y + 13, x + 17, y + 18)
        c.line(x + 17, y + 18, x + 21, y + 16)
        c.line(x + 21, y + 16, x + 26, y + 23)
    elif kind == "calendar":
        c.roundRect(x + 9, y + 10, 18, 17, 3, fill=0, stroke=1)
        c.line(x + 9, y + 22, x + 27, y + 22)
        c.line(x + 14, y + 25, x + 14, y + 29)
        c.line(x + 22, y + 25, x + 22, y + 29)
    elif kind == "flow":
        c.circle(x + 12, y + 23, 2.8, fill=0, stroke=1)
        c.circle(x + 24, y + 12, 2.8, fill=0, stroke=1)
        c.circle(x + 24, y + 25, 2.8, fill=0, stroke=1)
        c.line(x + 15, y + 22, x + 21, y + 24)
        c.line(x + 14, y + 20, x + 21, y + 13)
    elif kind == "money":
        c.circle(x + 18, y + 18, 10, fill=0, stroke=1)
        c.setFont(BOLD, 11)
        c.drawCentredString(x + 18, y + 14, "$")
    else:
        c.circle(x + 18, y + 18, 8, fill=0, stroke=1)


def feature_card(c, x, y, w, h, icon, title, copy, color):
    draw_round(c, x, y, w, h, INK_2, LINE, 14, 0.8)
    icon_badge(c, x + 14, y + h - 56, icon, color)
    para(c, title, x + 58, y + h - 23, w - 70, pstyle(11, 13, WHITE, BOLD))
    para(c, copy, x + 16, y + h - 68, w - 32, pstyle(8.4, 11, MUTED))


def callout(c, x, y, w, h, title, body, color=VIOLET):
    draw_round(c, x, y, w, h, Color(color.red, color.green, color.blue, alpha=0.10), Color(color.red, color.green, color.blue, alpha=0.45), 12, 0.8)
    c.setFillColor(color)
    c.rect(x + 13, y + h - 30, 3, 16, fill=1, stroke=0)
    para(c, title, x + 25, y + h - 14, w - 39, pstyle(10, 12, WHITE, BOLD))
    para(c, body, x + 16, y + h - 37, w - 32, pstyle(8.6, 11, MUTED))


def bullet_list(c, items, x, y_top, width, color=VIOLET, size=9):
    y = y_top
    for item in items:
        c.setFillColor(color)
        c.circle(x + 3.5, y - 6, 2.5, fill=1, stroke=0)
        h = para(c, item, x + 14, y, width - 14, pstyle(size, size * 1.42, MUTED))
        y -= max(h, size * 1.5) + 5
    return y


def draw_cover(c):
    c.setFillColor(INK)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(Color(0.42, 0.39, 0.94, alpha=0.20))
    c.circle(PAGE_W - 52, PAGE_H - 40, 230, fill=1, stroke=0)
    c.setFillColor(Color(0.18, 0.90, 0.65, alpha=0.06))
    c.circle(PAGE_W - 26, 74, 190, fill=1, stroke=0)
    c.setFillColor(Color(0.55, 0.36, 0.96, alpha=0.16))
    c.circle(38, 82, 145, fill=1, stroke=0)

    draw_logo(c, MARGIN, 795, 150, 31)
    tag(c, MARGIN, 716, "DOCUMENTO DE APRESENTACAO", VIOLET)
    para(c, "Sistema customizado para atendimento, vendas e automacao no WhatsApp", MARGIN, 681, 334, pstyle(28, 34, WHITE, BOLD))
    para(c, "Uma visao completa da plataforma ZapConnect: arquitetura funcional, modulos, padrao visual e referencias de identidade para operacao e evolucao do produto.", MARGIN, 558, 330, pstyle(11.4, 16, MUTED))

    c.setFillColor(MUTED)
    c.setFont(BOLD, 8)
    c.drawString(MARGIN, 474, "PLATAFORMA")
    c.setFillColor(WHITE)
    c.setFont(BOLD, 14)
    c.drawString(MARGIN, 452, "Atendimento - CRM - IA - Automacao - Cobrancas")
    c.setFillColor(DIM)
    c.setFont(REGULAR, 8.5)
    c.drawString(MARGIN, 430, "Versao de referencia: setembro de 2026")

    x, y, w, h = 388, 110, 170, 610
    image_cover(c, CAROUSEL / "slide-01-capa.png", x, y, w, h, 22)
    draw_round(c, x + 14, y + 16, 136, 45, Color(0.05, 0.07, 0.14, alpha=0.86), Color(0.55, 0.52, 0.96, alpha=0.55), 12, 0.6)
    c.setFillColor(WHITE)
    c.setFont(BOLD, 8.8)
    c.drawString(x + 27, y + 42, "GUIA DA PLATAFORMA")
    c.setFillColor(MUTED)
    c.setFont(REGULAR, 7.5)
    c.drawString(x + 27, y + 28, "Identidade, modulos e operacao")

    c.setFillColor(DIM)
    c.setFont(REGULAR, 7.5)
    c.drawString(MARGIN, 29, "ZapConnect - material de referencia interno")
    c.drawRightString(PAGE_W - MARGIN, 29, date.today().strftime("%d/%m/%Y"))
    c.showPage()


def draw_product_overview(c):
    draw_bg(c, 2, "VISAO GERAL")
    y = heading(c, "01 - Visao do produto", "Uma operacao conectada em um unico ambiente", "O ZapConnect centraliza a rotina comercial: as conversas chegam pelo WhatsApp, ganham contexto no CRM e podem evoluir para automacoes, agenda, cobranca e analise.")
    image_cover(c, CAROUSEL / "slide-01-capa.png", 346, 360, 206, 300)

    para(c, "O que o sistema resolve", MARGIN, 606, 250, pstyle(14, 17, WHITE, BOLD))
    y2 = bullet_list(c, [
        "Conecta e gerencia mais de uma sessao de WhatsApp pela mesma conta.",
        "Organiza conversas e dados de clientes sem trocar de ferramenta.",
        "Permite atendimento humano, respostas por IA e regras de transferencia.",
        "Mantem os fluxos de venda, campanhas, agenda e cobranca no mesmo ciclo operacional.",
    ], MARGIN, 580, 274, VIOLET, 9.2)

    callout(c, MARGIN, 318, 276, 86, "Principio de produto", "A interface e orientada a acao: cada modulo deixa claro o proximo passo do operador e o impacto no relacionamento com o contato.", MINT)

    cards = [
        (MARGIN, 154, 124, 132, "chat", "Conversar", "Chats, midias, status de entrega e modo humano.", MINT),
        (MARGIN + 134, 154, 124, 132, "robot", "Responder", "IA configuravel com contexto do atendimento.", VIOLET),
        (MARGIN + 268, 154, 124, 132, "flow", "Automatizar", "Disparo, agenda, drip e fluxos sem codigo.", PINK),
        (MARGIN + 402, 154, 124, 132, "money", "Converter", "CRM, cobrancas e acompanhamento de receita.", AMBER),
    ]
    for item in cards:
        feature_card(c, *item)
    c.showPage()


def draw_platform_map(c):
    draw_bg(c, 3, "MAPA DA PLATAFORMA")
    heading(c, "02 - Mapa da plataforma", "Modulos que acompanham a jornada do lead", "A navegacao agrupa a operacao em Principal, Envios e Configuracoes. Isso reduz mudancas de contexto e deixa a equipe perto dos recursos de uso diario.")

    modules = [
        ("chat", "Chats", "Conversas, midias, IA por conversa e atendimento humano.", MINT, "fa-solid fa-comments"),
        ("crm", "CRM Kanban", "Leads, estagios, etiquetas, notas e proximos passos.", BLUE, "fa-solid fa-address-book"),
        ("chart", "Analytics", "Leitura de temas, qualidade das respostas e oportunidades.", AMBER, "fa-solid fa-chart-line"),
        ("flow", "Disparo e Drip", "Campanhas em lote, listas, cadencia e acompanhamento.", PINK, "fa-solid fa-bullhorn / fa-solid fa-timeline"),
        ("calendar", "Agendamentos", "Reservas, lembretes e previsao da agenda.", ORANGE, "fa-solid fa-calendar-check"),
        ("money", "Cobrancas", "Cobrancas avulsas, recorrencias, status e WhatsApp.", AMBER, "fa-solid fa-file-invoice-dollar"),
        ("robot", "Qualificacao", "Perguntas, score e encaminhamento para o CRM.", MINT, "fa-solid fa-user-check"),
        ("flow", "Fluxos e Fallback", "Gatilhos, nos visuais, regras e transferencia ao humano.", VIOLET_2, "fa-solid fa-diagram-project / fa-solid fa-person-circle-question"),
    ]
    start_x, start_y = MARGIN, 574
    card_w, card_h, gap_x, gap_y = 248, 112, 18, 16
    for i, (icon, title, copy, color, ref) in enumerate(modules):
        col, row = i % 2, i // 2
        x = start_x + col * (card_w + gap_x)
        y = start_y - row * (card_h + gap_y)
        draw_round(c, x, y - card_h, card_w, card_h, INK_2, LINE, 14, 0.8)
        icon_badge(c, x + 16, y - 55, icon, color)
        para(c, title, x + 61, y - 17, card_w - 78, pstyle(11.5, 14, WHITE, BOLD))
        para(c, copy, x + 16, y - 55, card_w - 32, pstyle(8.2, 10.5, MUTED))
        c.setFillColor(DIM)
        c.setFont(REGULAR, 6.9)
        c.drawString(x + 16, y - card_h + 11, ref)
    callout(c, MARGIN, 85, PAGE_W - MARGIN * 2, 67, "Estrutura recomendada", "Use Chats para operar, CRM para orientar a proxima acao, Envios para ganhar escala e Configuracoes para definir as regras que mantem a experiencia consistente.", VIOLET)
    c.showPage()


def draw_ai(c):
    draw_bg(c, 4, "ATENDIMENTO E IA")
    heading(c, "03 - Atendimento e IA", "Resposta personalizada, com supervisao operacional", "O motor de IA usa GPT ou Gemini e combina mensagem recente, historico, instrucao do operador, contexto do cliente e base de conhecimento quando disponivel.")
    image_cover(c, CAROUSEL / "slide-02-ia-24h.png", 351, 335, 201, 306)

    c.setFillColor(WHITE)
    c.setFont(BOLD, 12.5)
    c.drawString(MARGIN, 617, "Ciclo de atendimento")
    stages = [
        ("01", "Mensagem", MINT),
        ("02", "Contexto", BLUE),
        ("03", "IA", VIOLET),
        ("04", "Operacao", AMBER),
    ]
    x0, y0 = MARGIN, 560
    for idx, (num, label, color) in enumerate(stages):
        x = x0 + idx * 72
        c.setFillColor(Color(color.red, color.green, color.blue, alpha=0.15))
        c.circle(x + 20, y0, 20, fill=1, stroke=0)
        c.setFillColor(color)
        c.setFont(BOLD, 8)
        c.drawCentredString(x + 20, y0 - 3, num)
        c.setFillColor(MUTED)
        c.setFont(BOLD, 7.3)
        c.drawCentredString(x + 20, y0 - 33, label)
        if idx < len(stages) - 1:
            c.setStrokeColor(LINE)
            c.setLineWidth(1.2)
            c.line(x + 43, y0, x + 67, y0)

    para(c, "Camadas de contexto", MARGIN, 485, 270, pstyle(12, 15, WHITE, BOLD))
    bullet_list(c, [
        "Prompt do operador: tom, regras e limite da resposta.",
        "Historico: continuidade da conversa sem repetir perguntas.",
        "CRM e base de conhecimento: dados relevantes para orientar a resposta.",
        "Idioma e horario: adequacao basica ao momento e ao cliente.",
    ], MARGIN, 460, 275, VIOLET, 8.9)

    callout(c, MARGIN, 240, 292, 87, "Falha da IA: comportamento atual", "Apos as tentativas configuradas, erros, timeout ou resposta vazia nao geram mensagem para o contato. O sistema registra metricas e cria uma nota interna para o operador no painel.", DANGER)
    callout(c, MARGIN, 138, 292, 76, "Transferencia controlada", "O fallback pode detectar pedido de humano, repeticao, frustracao ou baixa confianca. As regras sao ajustadas por sessao para preservar a experiencia do cliente.", MINT)
    c.showPage()


def draw_crm(c):
    draw_bg(c, 5, "CRM E INTELIGENCIA")
    heading(c, "04 - CRM, qualificacao e analytics", "Transforme conversa em acompanhamento comercial", "O CRM visual organiza o pipeline e recebe dados da conversa. A qualificacao prepara o lead antes do atendimento livre; o analytics ajuda a enxergar temas e pontos de melhoria.")
    image_cover(c, CAROUSEL / "slide-03-crm-kanban.png", 350, 348, 202, 292)

    c.setFillColor(WHITE)
    c.setFont(BOLD, 12.5)
    c.drawString(MARGIN, 612, "Pipeline que conecta atendimento e venda")
    pipeline = [("Novo", AMBER), ("Qualificando", ORANGE), ("Negociacao", VIOLET), ("Fechado", MINT)]
    x = MARGIN
    for label, color in pipeline:
        draw_round(c, x, 564, 61, 25, Color(color.red, color.green, color.blue, alpha=0.14), color, 12, 0.7)
        c.setFillColor(color)
        c.setFont(BOLD, 7)
        c.drawCentredString(x + 30.5, 573, label)
        x += 68
        if x < 310:
            c.setStrokeColor(LINE)
            c.line(x - 6, 576, x - 1, 576)

    blocks = [
        ("CRM", "Cadastro, telefone, cidade, tags, notas, valor potencial, follow-up e estagio. O contato chega ao operador com contexto pratico.", BLUE),
        ("Qualificacao", "Questionarios por fluxo, perguntas configuraveis, score e sinalizacao de prioridade antes da IA livre.", MINT),
        ("Analytics", "Temas recorrentes, perguntas sem resposta, sinais de melhoria para os prompts e leitura de uso da IA.", AMBER),
    ]
    y = 506
    for title, copy, color in blocks:
        draw_round(c, MARGIN, y - 76, 290, 65, INK_2, LINE, 12, 0.8)
        c.setFillColor(color)
        c.setFont(BOLD, 9.5)
        c.drawString(MARGIN + 16, y - 29, title)
        para(c, copy, MARGIN + 16, y - 39, 258, pstyle(8.2, 10.2, MUTED))
        y -= 82

    callout(c, MARGIN, 149, 290, 92, "Uso recomendado", "Atualize tags, valor potencial e proximo follow-up durante o atendimento. Isso melhora a decisao no CRM e tambem enriquece o contexto usado pela IA na proxima interacao.", VIOLET)
    c.showPage()


def draw_automation(c):
    draw_bg(c, 6, "AUTOMACAO E ENVIOS")
    heading(c, "05 - Automacao, disparos e agendamentos", "Escala com controle, cadencia e proximo passo claro", "Os modulos de Envios suportam campanhas em lote, mensagens programadas, campanhas drip e fluxos visuais. A operacao conserva validacoes, pre-visualizacoes e acompanhamento de status.")
    image_cover(c, CAROUSEL / "slide-04-disparo-agendamento.png", 352, 390, 200, 252)
    image_cover(c, CAROUSEL / "slide-05-fluxos-automacao.png", 352, 132, 200, 226)

    items = [
        ("Disparo", "Crie campanhas com lista validada, mensagem, confirmacao final e logs de envio. Bom para comunicados e acoes pontuais.", PINK, "chat"),
        ("Agendamentos", "Defina data, horario, contato e mensagem. A interface oferece calendario, status e pre-visualizacao no estilo WhatsApp.", ORANGE, "calendar"),
        ("Drip", "Orquestre sequencias de etapas e acompanhe leads inscritos, campanhas ativas e proxima acao de cada contato.", VIOLET, "flow"),
        ("Fluxos", "Monte automacoes por gatilho com nos para texto, espera, midia, condicao, CRM, webhook e transferencia humana.", MINT, "flow"),
    ]
    y = 610
    for title, copy, color, icon in items:
        draw_round(c, MARGIN, y - 78, 290, 67, INK_2, LINE, 12, 0.8)
        icon_badge(c, MARGIN + 13, y - 58, icon, color)
        para(c, title, MARGIN + 57, y - 25, 213, pstyle(10.3, 12.5, WHITE, BOLD))
        para(c, copy, MARGIN + 57, y - 40, 213, pstyle(7.7, 9.6, MUTED))
        y -= 82
    callout(c, MARGIN, 128, 290, 90, "Boa pratica de campanha", "Revise o publico, use uma mensagem contextual e confirme o lote antes do envio. Para sequencias longas, prefira Drip ou Fluxos e mantenha cada etapa simples e mensuravel.", AMBER)
    c.showPage()


def draw_billing(c):
    draw_bg(c, 7, "COBRANCAS E OPERACAO")
    heading(c, "06 - Cobrancas, pagamentos e rotina financeira", "Cobre, acompanhe e comunique no mesmo canal", "O modulo de cobrancas cobre registros avulsos e recorrentes, controle de vencimento, recebimento parcial, historico e comunicacao via WhatsApp quando a operacao escolher enviar.")
    image_cover(c, CAROUSEL / "slide-06-cobrancas.png", 351, 356, 201, 292)

    c.setFillColor(WHITE)
    c.setFont(BOLD, 12)
    c.drawString(MARGIN, 616, "Fluxo financeiro de ponta a ponta")
    flow = [("Criar", VIOLET), ("Previa", BLUE), ("Enviar", MINT), ("Acompanhar", AMBER), ("Receber", MINT)]
    x = MARGIN
    for i, (label, color) in enumerate(flow):
        draw_round(c, x, 562, 51, 25, Color(color.red, color.green, color.blue, alpha=0.15), color, 11, 0.7)
        c.setFillColor(color)
        c.setFont(BOLD, 7.3)
        c.drawCentredString(x + 25.5, 571, label)
        if i < len(flow) - 1:
            c.setStrokeColor(LINE)
            c.setLineWidth(1.1)
            c.line(x + 53, 574, x + 61, 574)
        x += 61

    sections = [
        ("Cobrancas", "Valor, descricao, vencimento, telefone e sessao do WhatsApp. O envio pode ser revisado pela pre-visualizacao antes da confirmacao.", ORANGE),
        ("Recorrencias", "Ciclos e proxima cobranca. Ao confirmar o pagamento, a proxima ocorrencia pode ser preparada automaticamente.", VIOLET),
        ("Controle", "Status de pendente, parcial, pago, vencido ou cancelado; historico de recebimentos e visao consolidada por cliente.", MINT),
        ("Integracoes", "Checkout e webhooks de pagamento podem alimentar o status, enquanto as notificacoes de cobranca seguem a configuracao da conta.", BLUE),
    ]
    y = 504
    for title, copy, color in sections:
        draw_round(c, MARGIN, y - 67, 292, 56, INK_2, LINE, 12, 0.8)
        c.setFillColor(color)
        c.setFont(BOLD, 9.7)
        c.drawString(MARGIN + 16, y - 27, title)
        para(c, copy, MARGIN + 16, y - 36, 258, pstyle(7.6, 9.2, MUTED))
        y -= 69
    callout(c, MARGIN, 132, 292, 92, "Ponto de controle", "A pre-visualizacao evita mensagens inesperadas. Mantenha os modelos de criacao, lembrete, atraso e confirmacao alinhados com o tom usado pelo atendimento.", AMBER)
    c.showPage()


def swatch(c, x, y, color, label, value):
    draw_round(c, x, y, 152, 44, INK_2, LINE, 10, 0.8)
    draw_round(c, x + 10, y + 10, 24, 24, color, None, 7)
    c.setFillColor(WHITE)
    c.setFont(BOLD, 8.3)
    c.drawString(x + 44, y + 24, label)
    c.setFillColor(DIM)
    c.setFont(REGULAR, 7.3)
    c.drawString(x + 44, y + 12, value)


def draw_brand(c):
    draw_bg(c, 8, "IDENTIDADE VISUAL")
    heading(c, "07 - Identidade visual", "Sistema visual ZapConnect: referencias para materiais e interfaces", "A linguagem visual combina fundo azul-marinho, superficies escuras, violeta como acao principal e cores de status para leitura operacional. Os ativos desta pagina sao os mesmos presentes no projeto.")

    draw_round(c, MARGIN, 529, 248, 134, INK_2, LINE, 16, 0.8)
    c.setFillColor(VIOLET_2)
    c.setFont(BOLD, 8.3)
    c.drawString(MARGIN + 18, 638, "LOGO HORIZONTAL - PRINCIPAL")
    draw_logo(c, MARGIN + 18, 615, 190, 38)
    c.setFillColor(MUTED)
    c.setFont(REGULAR, 7.7)
    c.drawString(MARGIN + 18, 554, "Arquivo: public/img/logo3.png")
    c.drawString(MARGIN + 18, 539, "Aplicacao: barra lateral, cabecalho e documentos.")

    draw_round(c, 306, 529, 246, 134, INK_2, LINE, 16, 0.8)
    c.setFillColor(VIOLET_2)
    c.setFont(BOLD, 8.3)
    c.drawString(324, 638, "MARCA E FAVICON")
    logo_square = ASSETS / "logo.png"
    favicon = ASSETS / "favinco.png"
    if logo_square.exists():
        c.drawImage(ImageReader(str(logo_square)), 326, 548, width=58, height=58, mask="auto")
    if favicon.exists():
        c.drawImage(ImageReader(str(favicon)), 407, 558, width=39, height=39, mask="auto")
    c.setFillColor(MUTED)
    c.setFont(REGULAR, 7.7)
    c.drawString(326, 535, "logo.png")
    c.drawString(407, 535, "favinco.png")

    para(c, "Paleta de referencia", MARGIN, 490, 220, pstyle(12.5, 15, WHITE, BOLD))
    swatches = [
        (INK, "Fundo", "#0D1222"), (INK_2, "Card", "#161B30"), (VIOLET, "Acao", "#6C64EF"),
        (MINT, "Sucesso", "#2EE6A6"), (AMBER, "Alerta", "#F2C94C"), (DANGER, "Erro", "#E54848"),
    ]
    for i, (color, label, value) in enumerate(swatches):
        col, row = i % 3, i // 3
        swatch(c, MARGIN + col * 171, 424 - row * 55, color, label, value)

    para(c, "Tipografia e icones", MARGIN, 293, 220, pstyle(12.5, 15, WHITE, BOLD))
    draw_round(c, MARGIN, 147, 510, 126, INK_2, LINE, 14, 0.8)
    para(c, "<b>Tipografia</b><br/>Inter - leitura de interface, titulos e informacoes operacionais.<br/><br/><b>Tipografia auxiliar</b><br/>Space Mono - dados tecnicos, codigos e indicadores curtos.", MARGIN + 18, 270, 225, pstyle(8.4, 11, MUTED))
    para(c, "<b>Biblioteca de icones</b><br/>Font Awesome 6.5.2, conforme a interface. Exemplos: <b>fa-comments</b> (Chats), <b>fa-robot</b> (IA), <b>fa-address-book</b> (CRM), <b>fa-calendar-check</b> (Agenda), <b>fa-bullhorn</b> (Disparo) e <b>fa-file-invoice-dollar</b> (Cobrancas).", MARGIN + 266, 270, 224, pstyle(8.4, 11, MUTED))
    tags = [("Chats", "chat", MINT), ("IA", "robot", VIOLET), ("CRM", "crm", BLUE), ("Agenda", "calendar", ORANGE), ("Fluxos", "flow", PINK), ("Cobrancas", "money", AMBER)]
    x, y = MARGIN + 18, 165
    for label, icon, color in tags:
        icon_badge(c, x, y, icon, color)
        c.setFillColor(MUTED)
        c.setFont(BOLD, 7.2)
        c.drawCentredString(x + 18, y - 9, label)
        x += 78
    c.showPage()


def draw_governance(c):
    draw_bg(c, 9, "OPERACAO E CONFIABILIDADE")
    heading(c, "08 - Operacao, seguranca e confiabilidade", "Uma plataforma preparada para rotinas reais", "A personalizacao nao esta apenas na tela: o sistema tem isolamento por usuario, sessoes independentes, registros de uso e recursos de controle para que o atendimento continue governavel conforme a operacao cresce.")

    rows = [
        ("Multi-sessoes", "Cada conta pode operar sessoes de WhatsApp e acompanhar estado, QR Code, conexao e reconexao no painel.", MINT, "chat"),
        ("Permissoes e conta", "Acesso autenticado, verificacao de e-mail, planos e limites de uso da IA e das sessoes.", BLUE, "crm"),
        ("Historico e metricas", "Historico de conversas, dados de CRM e metricas de IA ajudam a manter continuidade e medir a operacao.", VIOLET, "chart"),
        ("Tratamento de falhas", "Falhas de IA sao registradas no sistema. Nenhuma mensagem tecnica e enviada ao contato quando nao ha resposta valida.", DANGER, "robot"),
        ("Fallback para humano", "Regras por sessao podem pausar a IA e sinalizar que a conversa precisa de acompanhamento humano.", AMBER, "flow"),
    ]
    y = 620
    for title, copy, color, icon in rows:
        draw_round(c, MARGIN, y - 79, 510, 68, INK_2, LINE, 13, 0.8)
        icon_badge(c, MARGIN + 14, y - 60, icon, color)
        para(c, title, MARGIN + 61, y - 24, 420, pstyle(10.5, 13, WHITE, BOLD))
        para(c, copy, MARGIN + 61, y - 40, 420, pstyle(8.4, 10.3, MUTED))
        y -= 81
    callout(c, MARGIN, 139, 510, 80, "Diretriz operacional", "Comunique o cliente somente quando houver uma resposta util ou uma mensagem aprovada por uma regra de negocio. Alertas tecnicos, como falha da IA, pertencem ao painel e aos logs do sistema.", DANGER)
    c.showPage()


def draw_quick_start(c):
    draw_bg(c, 10, "PRIMEIROS PASSOS")
    heading(c, "09 - Primeiros passos", "Coloque a operacao para rodar em quatro etapas", "O onboarding do sistema segue uma sequencia direta: criar acesso, conectar o canal, definir o comportamento da IA e validar uma conversa real antes de escalar.")
    steps = [
        ("01", "Criar conta", "Defina os dados da conta e confirme o acesso. Revise plano, limites e configuracoes basicas.", VIOLET, "crm"),
        ("02", "Conectar WhatsApp", "Crie a sessao, escaneie o QR Code e confirme que o status esta online no painel.", MINT, "chat"),
        ("03", "Configurar IA", "Escreva instrucoes de tom, regras e limites. Selecione o provedor e prepare a base de conhecimento quando necessario.", BLUE, "robot"),
        ("04", "Testar no chat", "Envie uma mensagem de teste, acompanhe a resposta e confirme o comportamento antes de ativar campanhas ou automacoes.", AMBER, "calendar"),
    ]
    x0, y0 = MARGIN, 588
    for i, (num, title, copy, color, icon) in enumerate(steps):
        x = x0 + (i % 2) * 265
        y = y0 - (i // 2) * 190
        draw_round(c, x, y - 160, 246, 150, INK_2, LINE, 16, 0.8)
        c.setFillColor(Color(color.red, color.green, color.blue, alpha=0.14))
        c.circle(x + 32, y - 37, 19, fill=1, stroke=0)
        c.setFillColor(color)
        c.setFont(BOLD, 8)
        c.drawCentredString(x + 32, y - 40, num)
        icon_badge(c, x + 184, y - 56, icon, color)
        para(c, title, x + 18, y - 70, 195, pstyle(13, 16, WHITE, BOLD))
        para(c, copy, x + 18, y - 96, 205, pstyle(8.8, 11.4, MUTED))
    callout(c, MARGIN, 138, 510, 80, "Checklist antes de escalar", "Sessao conectada, prompt revisado, teste real concluido, CRM pronto para receber dados e regras de fallback ajustadas. Com essa base, campanhas e fluxos podem ser ativados com mais previsibilidade.", MINT)
    c.showPage()


def draw_end(c):
    c.setFillColor(INK)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(Color(0.42, 0.39, 0.94, alpha=0.20))
    c.circle(PAGE_W / 2, PAGE_H / 2 + 20, 250, fill=1, stroke=0)
    draw_logo(c, PAGE_W / 2 - 80, 632, 160, 35)
    tag(c, PAGE_W / 2 - 68, 560, "DOCUMENTACAO DE REFERENCIA", VIOLET)
    para(c, "A operacao inteira, mais proxima da conversa.", 85, 522, PAGE_W - 170, pstyle(25, 31, WHITE, BOLD, TA_CENTER))
    para(c, "ZapConnect centraliza atendimento, vendas, automacao e cobrancas para que sua equipe trabalhe com mais contexto, velocidade e controle.", 115, 427, PAGE_W - 230, pstyle(11, 16, MUTED, REGULAR, TA_CENTER))
    draw_round(c, 142, 276, PAGE_W - 284, 82, INK_2, Color(0.55, 0.52, 0.96, alpha=0.45), 16, 0.8)
    c.setFillColor(VIOLET_2)
    c.setFont(BOLD, 8.5)
    c.drawCentredString(PAGE_W / 2, 327, "ATIVOS REFERENCIADOS")
    c.setFillColor(MUTED)
    c.setFont(REGULAR, 8.4)
    c.drawCentredString(PAGE_W / 2, 306, "logo3.png - logo.png - favinco.png - carousel-zapconnect")
    c.drawCentredString(PAGE_W / 2, 289, "Cores e tipografia derivados de public/css/design-tokens.css")
    c.setFillColor(DIM)
    c.setFont(REGULAR, 7.5)
    c.drawCentredString(PAGE_W / 2, 84, "ZapConnect - Documento interno de produto e identidade visual")
    c.showPage()


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1, title="ZapConnect - Documentacao do Sistema")
    c.setTitle("ZapConnect - Documentacao do Sistema")
    c.setAuthor("ZapConnect")
    c.setSubject("Documentacao visual do sistema customizado")
    draw_cover(c)
    draw_product_overview(c)
    draw_platform_map(c)
    draw_ai(c)
    draw_crm(c)
    draw_automation(c)
    draw_billing(c)
    draw_brand(c)
    draw_governance(c)
    draw_quick_start(c)
    draw_end(c)
    c.save()
    print(OUT)


if __name__ == "__main__":
    main()
