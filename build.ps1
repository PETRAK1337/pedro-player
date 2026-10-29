# Pedro build script: fetches the WebView2 SDK (once) and compiles the host
# with the C# compiler that ships with Windows (.NET Framework 4.8).
#   powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$wv2Version = '1.0.4258.31'
$lib = Join-Path $root 'lib'
$dist = Join-Path $root 'dist'
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'   # Windows media controls (WinRT) metadata

if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }

$need = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
if (($need | Where-Object { -not (Test-Path (Join-Path $lib $_)) }).Count -gt 0) {
    Write-Host "Downloading WebView2 SDK $wv2Version from nuget.org..."
    New-Item -ItemType Directory -Force $lib | Out-Null
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("pedro-wv2-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $pkg = Join-Path $tmp 'wv2.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$wv2Version" -OutFile $pkg -UseBasicParsing
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($pkg, (Join-Path $tmp 'x'))
    Copy-Item (Join-Path $tmp 'x\lib\net462\Microsoft.Web.WebView2.Core.dll') $lib
    Copy-Item (Join-Path $tmp 'x\lib\net462\Microsoft.Web.WebView2.WinForms.dll') $lib
    Copy-Item (Join-Path $tmp 'x\runtimes\win-x64\native\WebView2Loader.dll') $lib
    Remove-Item -Recurse -Force $tmp
}

New-Item -ItemType Directory -Force $dist | Out-Null
Write-Host 'Compiling Pedro.exe...'
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
    /out:"$dist\Pedro.exe" `
    /win32icon:"$root\host\pedro.ico" `
    /win32manifest:"$root\host\app.manifest" `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Management.dll `
    /r:"$fw\System.Runtime.dll" /r:"$fw\System.Runtime.WindowsRuntime.dll" /r:"$fw\System.Runtime.InteropServices.WindowsRuntime.dll" `
    /r:"$winmd\Windows.Foundation.winmd" /r:"$winmd\Windows.Media.winmd" /r:"$winmd\Windows.Storage.winmd" `
    /r:"$lib\Microsoft.Web.WebView2.Core.dll" /r:"$lib\Microsoft.Web.WebView2.WinForms.dll" `
    "$root\host\Pedro.cs"
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }

foreach ($f in $need) { Copy-Item (Join-Path $lib $f) $dist -Force }
$distApp = Join-Path $dist 'app'
if (Test-Path $distApp) { Remove-Item -Recurse -Force $distApp }
Copy-Item -Recurse (Join-Path $root 'app') $distApp
# version stamp: WebView2 may keep an older app.js / style.css in its cache across updates
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$index = Join-Path $distApp 'index.html'
$html = [IO.File]::ReadAllText($index)
$html = $html.Replace('href="style.css"', "href=""style.css?v=$stamp""").Replace('src="app.js"', "src=""app.js?v=$stamp""")
[IO.File]::WriteAllText($index, $html, (New-Object Text.UTF8Encoding($false)))

$size = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1KB
Write-Host ("Done: dist\Pedro.exe  (whole folder {0:N0} KB)" -f $size)
