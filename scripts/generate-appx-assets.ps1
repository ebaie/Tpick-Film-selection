param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\build\appx"),
    [string]$BaseIcon = (Join-Path $PSScriptRoot "..\build\icon-store.png")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function New-RoundedPath {
    param([int]$X, [int]$Y, [int]$Width, [int]$Height, [int]$Radius)

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Set-HighQualityRendering {
    param([System.Drawing.Graphics]$Graphics)

    $Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
}

function New-BrandIcon {
    $size = 1024
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        Set-HighQualityRendering $graphics
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $backgroundPath = New-RoundedPath 8 8 1008 1008 218
        $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Rectangle]::new(0, 0, $size, $size),
            [System.Drawing.ColorTranslator]::FromHtml("#74A0FF"),
            [System.Drawing.ColorTranslator]::FromHtml("#4D73E6"),
            90.0
        )
        try {
            $graphics.FillPath($gradient, $backgroundPath)
        }
        finally {
            $gradient.Dispose()
            $backgroundPath.Dispose()
        }

        $white = [System.Drawing.Color]::White
        $framePath = New-RoundedPath 180 270 664 500 92
        $framePen = [System.Drawing.Pen]::new($white, 46)
        $framePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        try {
            $graphics.DrawPath($framePen, $framePath)
        }
        finally {
            $framePen.Dispose()
            $framePath.Dispose()
        }

        $graphics.FillEllipse([System.Drawing.SolidBrush]::new($white), 738, 338, 50, 70)

        $cameraBody = New-RoundedPath 324 508 376 248 76
        $whiteBrush = [System.Drawing.SolidBrush]::new($white)
        try {
            $graphics.FillEllipse($whiteBrush, 425, 452, 174, 150)
            $graphics.FillPath($whiteBrush, $cameraBody)
            $graphics.FillEllipse(
                [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#557CEB")),
                426,
                535,
                172,
                172
            )
        }
        finally {
            $whiteBrush.Dispose()
            $cameraBody.Dispose()
        }
    }
    finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function Export-SquareAsset {
    param(
        [System.Drawing.Image]$Image,
        [int]$Size,
        [string]$Name
    )

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        Set-HighQualityRendering $graphics
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $path = New-RoundedPath 0 0 $Size $Size ([Math]::Max(2, [int]($Size * 0.16)))
        try {
            $graphics.SetClip($path)
            $graphics.DrawImage($Image, 0, 0, $Size, $Size)
        }
        finally {
            $path.Dispose()
        }
        $bitmap.Save((Join-Path $OutputDirectory $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Export-WideAsset {
    param([System.Drawing.Image]$Image)

    $width = 620
    $height = 300
    $logoSize = 260
    $logoX = [int](($width - $logoSize) / 2)
    $logoY = [int](($height - $logoSize) / 2)
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        Set-HighQualityRendering $graphics
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#151A25"))
        $path = New-RoundedPath $logoX $logoY $logoSize $logoSize ([int]($logoSize * 0.16))
        try {
            $graphics.SetClip($path)
            $graphics.DrawImage($Image, $logoX, $logoY, $logoSize, $logoSize)
        }
        finally {
            $path.Dispose()
        }
        $bitmap.Save((Join-Path $OutputDirectory "Wide310x150Logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$sourceImage = New-BrandIcon
try {
    $sourceImage.Save($BaseIcon, [System.Drawing.Imaging.ImageFormat]::Png)
    Export-SquareAsset $sourceImage 50 "StoreLogo.png"
    Export-SquareAsset $sourceImage 44 "Square44x44Logo.png"
    Export-SquareAsset $sourceImage 300 "Square150x150Logo.png"
    Export-WideAsset $sourceImage
}
finally {
    $sourceImage.Dispose()
}
