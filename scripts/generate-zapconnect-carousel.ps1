Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

function New-ColorFromHex {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hex,
        [int]$Alpha = 255
    )

    $cleanHex = $Hex.TrimStart("#")
    return [System.Drawing.Color]::FromArgb(
        $Alpha,
        [Convert]::ToInt32($cleanHex.Substring(0, 2), 16),
        [Convert]::ToInt32($cleanHex.Substring(2, 2), 16),
        [Convert]::ToInt32($cleanHex.Substring(4, 2), 16)
    )
}

function New-RoundedRectanglePath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-RoundedBlock {
    param(
        [System.Drawing.Graphics]$Graphics,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius,
        [System.Drawing.Color]$FillColor,
        [System.Drawing.Color]$BorderColor
    )

    $path = New-RoundedRectanglePath -X $X -Y $Y -Width $Width -Height $Height -Radius $Radius
    $fillBrush = New-Object System.Drawing.SolidBrush($FillColor)
    $borderPen = New-Object System.Drawing.Pen($BorderColor, 1.4)
    $Graphics.FillPath($fillBrush, $path)
    $Graphics.DrawPath($borderPen, $path)
    $fillBrush.Dispose()
    $borderPen.Dispose()
    $path.Dispose()
}

function Draw-CoverImage {
    param(
        [System.Drawing.Graphics]$Graphics,
        [System.Drawing.Image]$Image,
        [int]$Width,
        [int]$Height
    )

    $scale = [Math]::Max($Width / $Image.Width, $Height / $Image.Height)
    $drawWidth = [int][Math]::Ceiling($Image.Width * $scale)
    $drawHeight = [int][Math]::Ceiling($Image.Height * $scale)
    $offsetX = [int][Math]::Round(($Width - $drawWidth) / 2)
    $offsetY = [int][Math]::Round(($Height - $drawHeight) / 2)
    $Graphics.DrawImage($Image, $offsetX, $offsetY, $drawWidth, $drawHeight)
}

function Draw-TagRow {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string[]]$Tags,
        [float]$StartX,
        [float]$Y,
        [System.Drawing.Font]$Font,
        [System.Drawing.Color]$AccentColor,
        [System.Drawing.Color]$TextColor
    )

    $currentX = $StartX
    foreach ($tag in $Tags) {
        $size = $Graphics.MeasureString($tag, $Font)
        $paddingX = 18
        $paddingY = 9
        $tagWidth = [Math]::Ceiling($size.Width + ($paddingX * 2))
        $tagHeight = [Math]::Ceiling($size.Height + ($paddingY * 2))
        Draw-RoundedBlock `
            -Graphics $Graphics `
            -X $currentX `
            -Y $Y `
            -Width $tagWidth `
            -Height $tagHeight `
            -Radius 18 `
            -FillColor ([System.Drawing.Color]::FromArgb(34, $AccentColor.R, $AccentColor.G, $AccentColor.B)) `
            -BorderColor ([System.Drawing.Color]::FromArgb(110, $AccentColor.R, $AccentColor.G, $AccentColor.B))

        $brush = New-Object System.Drawing.SolidBrush($TextColor)
        $Graphics.DrawString($tag, $Font, $brush, $currentX + $paddingX, $Y + $paddingY - 1)
        $brush.Dispose()

        $currentX += $tagWidth + 12
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$carouselDir = Join-Path $repoRoot "public\img\carousel-zapconnect"
$baseDir = Join-Path $carouselDir "base"
$logoPath = Join-Path $repoRoot "public\img\logo3.png"

if (-not (Test-Path $baseDir)) {
    throw "Base directory not found: $baseDir"
}

if (-not (Test-Path $logoPath)) {
    throw "Logo not found: $logoPath"
}

$width = 1080
$height = 1350

$bg = New-ColorFromHex "#0D1222"
$textPrimary = New-ColorFromHex "#FFFFFF"
$textSecondary = New-ColorFromHex "#AAB0D9"
$accent = New-ColorFromHex "#6C64EF"
$accentSoft = New-ColorFromHex "#8B5CF6"
$panelFill = [System.Drawing.Color]::FromArgb(80, 7, 12, 26)
$panelBorder = [System.Drawing.Color]::FromArgb(95, 108, 100, 239)
$eyebrowFill = [System.Drawing.Color]::FromArgb(28, 108, 100, 239)
$eyebrowBorder = [System.Drawing.Color]::FromArgb(95, 139, 92, 246)
$shadow = [System.Drawing.Color]::FromArgb(165, 0, 0, 0)

$slides = @(
    [pscustomobject]@{
        Base = "bg-00-sobre.png"
        Output = "post-sobre-zapconnect.png"
        Eyebrow = "APRESENTACAO"
        Title = "Sobre o`nZapConnect"
        Body = "Uma plataforma para usar IA, automacao, CRM e multisessoes no WhatsApp."
        Tags = @("IA", "CRM", "WhatsApp")
        Number = ""
        TitleSize = 78
    },
    [pscustomobject]@{
        Base = "bg-01-cover.png"
        Output = "slide-01-capa.png"
        Eyebrow = "ZAPCONNECT"
        Title = "Seu WhatsApp`ncom IA"
        Body = "Automatize atendimento, vendas e operacao em um so painel."
        Tags = @("IA", "CRM", "Multisessoes")
        Number = "01"
        TitleSize = 80
    },
    [pscustomobject]@{
        Base = "bg-02-ia.png"
        Output = "slide-02-ia.png"
        Eyebrow = "ATENDIMENTO 24/7"
        Title = "IA responde`ncom contexto"
        Body = "Texto, audio e imagem com mais velocidade e menos esforco manual."
        Tags = @("Audio", "Imagem", "Humanizacao")
        Number = "02"
        TitleSize = 72
    },
    [pscustomobject]@{
        Base = "bg-03-multissessoes.png"
        Output = "slide-03-multissessoes.png"
        Eyebrow = "OPERACAO ESCALAVEL"
        Title = "Varios numeros`nno mesmo painel"
        Body = "Centralize sessoes, equipes e conversas sem perder controle."
        Tags = @("Multisessoes", "Dashboard", "Escala")
        Number = "03"
        TitleSize = 68
    },
    [pscustomobject]@{
        Base = "bg-04-crm.png"
        Output = "slide-04-crm-automacao.png"
        Eyebrow = "AUTOMACAO + CRM"
        Title = "Fluxos, disparos`ne gestao"
        Body = "Organize leads, acompanhe etapas e automatize tarefas repetitivas."
        Tags = @("CRM", "Fluxos", "Disparos")
        Number = "04"
        TitleSize = 70
    },
    [pscustomobject]@{
        Base = "bg-05-vendas.png"
        Output = "slide-05-resultados.png"
        Eyebrow = "RESULTADO"
        Title = "Mais vendas,`nmenos trabalho manual"
        Body = "Use o ZapConnect para atender melhor, ganhar tempo e crescer com previsibilidade."
        Tags = @("Produtividade", "Conversao", "Crescimento")
        Number = "05"
        TitleSize = 66
    }
)

$logo = [System.Drawing.Image]::FromFile($logoPath)

try {
    foreach ($slide in $slides) {
        $basePath = Join-Path $baseDir $slide.Base
        if (-not (Test-Path $basePath)) {
            throw "Missing base image: $basePath"
        }

        $background = [System.Drawing.Image]::FromFile($basePath)
        $canvas = New-Object System.Drawing.Bitmap($width, $height)
        $graphics = [System.Drawing.Graphics]::FromImage($canvas)

        try {
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            $graphics.Clear($bg)

            Draw-CoverImage -Graphics $graphics -Image $background -Width $width -Height $height

            $leftFade = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
                (New-Object System.Drawing.RectangleF(0, 0, $width, $height)),
                [System.Drawing.Color]::FromArgb(230, 5, 8, 18),
                [System.Drawing.Color]::FromArgb(0, 5, 8, 18),
                0
            )
            $graphics.FillRectangle($leftFade, 0, 0, $width, $height)
            $leftFade.Dispose()

            $topGlow = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
                (New-Object System.Drawing.RectangleF(0, 0, $width, 260)),
                [System.Drawing.Color]::FromArgb(70, 140, 92, 246),
                [System.Drawing.Color]::FromArgb(0, 140, 92, 246),
                90
            )
            $graphics.FillRectangle($topGlow, 0, 0, $width, 260)
            $topGlow.Dispose()

            Draw-RoundedBlock `
                -Graphics $graphics `
                -X 54 `
                -Y 268 `
                -Width 520 `
                -Height 760 `
                -Radius 34 `
                -FillColor $panelFill `
                -BorderColor $panelBorder

            $logoScale = 360 / $logo.Width
            $logoWidth = [int][Math]::Round($logo.Width * $logoScale)
            $logoHeight = [int][Math]::Round($logo.Height * $logoScale)
            $graphics.DrawImage($logo, 58, 58, $logoWidth, $logoHeight)

            Draw-RoundedBlock `
                -Graphics $graphics `
                -X 74 `
                -Y 314 `
                -Width 220 `
                -Height 48 `
                -Radius 20 `
                -FillColor $eyebrowFill `
                -BorderColor $eyebrowBorder

            $eyebrowFont = New-Object System.Drawing.Font("Bahnschrift", 18, [System.Drawing.FontStyle]::Bold)
            $eyebrowBrush = New-Object System.Drawing.SolidBrush($textPrimary)
            $graphics.DrawString($slide.Eyebrow, $eyebrowFont, $eyebrowBrush, 94, 325)
            $eyebrowBrush.Dispose()
            $eyebrowFont.Dispose()

            $titleFont = New-Object System.Drawing.Font("Bahnschrift", $slide.TitleSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            $titleBrush = New-Object System.Drawing.SolidBrush($textPrimary)
            $titleShadowBrush = New-Object System.Drawing.SolidBrush($shadow)
            $titleRect = New-Object System.Drawing.RectangleF(74, 392, 450, 310)
            $graphics.DrawString($slide.Title, $titleFont, $titleShadowBrush, (New-Object System.Drawing.RectangleF(78, 396, 450, 310)))
            $graphics.DrawString($slide.Title, $titleFont, $titleBrush, $titleRect)
            $titleBrush.Dispose()
            $titleShadowBrush.Dispose()
            $titleFont.Dispose()

            $accentPen = New-Object System.Drawing.Pen($accentSoft, 6)
            $graphics.DrawLine($accentPen, 76, 724, 250, 724)
            $accentPen.Dispose()

            $bodyFont = New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $bodyBrush = New-Object System.Drawing.SolidBrush($textSecondary)
            $bodyRect = New-Object System.Drawing.RectangleF(74, 752, 424, 168)
            $graphics.DrawString($slide.Body, $bodyFont, $bodyBrush, $bodyRect)
            $bodyBrush.Dispose()
            $bodyFont.Dispose()

            $tagFont = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            Draw-TagRow `
                -Graphics $graphics `
                -Tags $slide.Tags `
                -StartX 74 `
                -Y 946 `
                -Font $tagFont `
                -AccentColor $accent `
                -TextColor $textPrimary
            $tagFont.Dispose()

            if (-not [string]::IsNullOrWhiteSpace($slide.Number)) {
                Draw-RoundedBlock `
                    -Graphics $graphics `
                    -X 870 `
                    -Y 88 `
                    -Width 132 `
                    -Height 72 `
                    -Radius 24 `
                    -FillColor ([System.Drawing.Color]::FromArgb(42, 108, 100, 239)) `
                    -BorderColor ([System.Drawing.Color]::FromArgb(115, 108, 100, 239))

                $numberFont = New-Object System.Drawing.Font("Bahnschrift", 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
                $numberBrush = New-Object System.Drawing.SolidBrush($textPrimary)
                $graphics.DrawString($slide.Number, $numberFont, $numberBrush, 912, 105)
                $numberBrush.Dispose()
                $numberFont.Dispose()
            }

            $footerFont = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            $footerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
            $graphics.DrawString("ZapConnect", $footerFont, $footerBrush, 76, 1100)
            $footerBrush.Dispose()
            $footerFont.Dispose()

            $subFooterFont = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $subFooterBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 170, 176, 217))
            $graphics.DrawString("Seu WhatsApp com IA, automacao e escala.", $subFooterFont, $subFooterBrush, 76, 1132)
            $subFooterBrush.Dispose()
            $subFooterFont.Dispose()

            $outputPath = Join-Path $carouselDir $slide.Output
            $canvas.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
            Write-Host "Generated $outputPath"
        }
        finally {
            $graphics.Dispose()
            $canvas.Dispose()
            $background.Dispose()
        }
    }
}
finally {
    $logo.Dispose()
}
