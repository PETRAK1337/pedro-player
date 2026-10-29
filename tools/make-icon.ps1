# Draws host\pedro.ico: black tile with a white ring and play glyph, hollow offset shadow.
#   powershell -File tools\make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ink = [Drawing.Color]::FromArgb(255, 13, 13, 13)
$paper = [Drawing.Color]::FromArgb(255, 255, 255, 255)

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    $p
}

function New-IconBitmap([int]$s) {
    $bmp = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([Drawing.Color]::Transparent)
    $k = $s / 256.0
    $shadow = [Math]::Max(1.0, 20 * $k)
    $stroke = [Math]::Max(1.25, 15 * $k)
    $margin = [Math]::Max(0.5, 6 * $k)
    $side = $s - 2 * $margin - $shadow
    $radius = 58 * $k
    $inkBrush = New-Object Drawing.SolidBrush $ink

    # hollow offset "shadow": white with an ink outline, so it reads on light and dark taskbars
    $half = $stroke / 2
    $shade = New-RoundRect ($margin + $shadow + $half) ($margin + $shadow + $half) ($side - $stroke) ($side - $stroke) ([Math]::Max(1, $radius - $half))
    $g.FillPath((New-Object Drawing.SolidBrush $paper), $shade)
    $g.DrawPath((New-Object Drawing.Pen $ink, $stroke), $shade)
    $body = New-RoundRect ($margin + $half) ($margin + $half) ($side - $stroke) ($side - $stroke) ([Math]::Max(1, $radius - $half))
    $g.FillPath($inkBrush, $body)
    $g.DrawPath((New-Object Drawing.Pen $ink, $stroke), $body)
    if ($s -ge 32) {
        # stamped look: thin white ring inside the black tile
        $in = $stroke * 1.9
        $ring = New-RoundRect ($margin + $in) ($margin + $in) ($side - 2 * $in) ($side - 2 * $in) ([Math]::Max(1, $radius - $in))
        $g.DrawPath((New-Object Drawing.Pen $paper, ([single]([Math]::Max(1, 7 * $k)))), $ring)
    }

    $cx = $margin + $side / 2 + 9 * $k
    $cy = $margin + $side / 2
    $t = 56 * $k
    $tri = New-Object Drawing.Drawing2D.GraphicsPath
    $tri.AddPolygon([Drawing.PointF[]]@(
        (New-Object Drawing.PointF ([single]($cx - $t * 0.78)), ([single]($cy - $t))),
        (New-Object Drawing.PointF ([single]($cx + $t * 0.92)), ([single]$cy)),
        (New-Object Drawing.PointF ([single]($cx - $t * 0.78)), ([single]($cy + $t)))))
    $paperBrush = New-Object Drawing.SolidBrush $paper
    $g.FillPath($paperBrush, $tri)
    $join = New-Object Drawing.Pen $paper, ([single]([Math]::Max(1, 18 * $k)))
    $join.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($join, $tri)
    $g.Dispose()
    $bmp
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = @()
foreach ($s in $sizes) {
    $ms = New-Object IO.MemoryStream
    (New-IconBitmap $s).Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $images += , $ms.ToArray()
}

$out = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = [byte]($sizes[$i] % 256)
    $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
    $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
$dest = Join-Path $PSScriptRoot '..\host\pedro.ico'
[IO.File]::WriteAllBytes($dest, $out.ToArray())
if ($args.Count -gt 0) { (New-IconBitmap 256).Save($args[0], [Drawing.Imaging.ImageFormat]::Png) }
Write-Host "Wrote $dest"
