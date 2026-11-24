[CmdletBinding()]
param([string] $Compiler)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$dist = Join-Path $root 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a numeric release version in package.json.' }
New-Item -ItemType Directory -Force -Path $build,$dist | Out-Null

function Get-VerifiedFile([string] $Url, [string] $Path, [string] $Sha256) {
    if (!(Test-Path -LiteralPath $Path) -or (Get-FileHash -LiteralPath $Path).Hash -ne $Sha256) {
        curl.exe --fail --location --retry 3 --max-time 300 --output $Path $Url
        if ($LASTEXITCODE) { throw 'A release dependency could not be downloaded.' }
    }
    if ((Get-FileHash -LiteralPath $Path).Hash -ne $Sha256) { throw "Checksum mismatch for $Path." }
}

$electron = Join-Path $build 'electron-v45.4.1-win32-x64.zip'
$engine = Join-Path $build 'whisper-v1.8.6-win32-x64.zip'
$model = Join-Path $build 'ggml-base-q5_1.bin'
$resourceEditor = Join-Path $build 'rcedit-v2.0.0-x64.exe'
Get-VerifiedFile 'https://github.com/electron/electron/releases/download/v45.4.1/electron-v45.4.1-win32-x64.zip' $electron '2BA6223AFA9121F42831FEFE92C434334907540165294FC56697449D12E7CFE9'
Get-VerifiedFile 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip' $engine 'B07EA0B1B4115A38E1A7B07DEBF581F0B77D999925F8ACB8F39D322B0BA0A822'
Get-VerifiedFile 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb4/ggml-base-q5_1.bin' $model '422F1AE452ADE6F30A004D7E5C6A43195E4433BC370BF23FAC9CC591F01A8898'
Get-VerifiedFile 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' $resourceEditor '3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A'

$stage = Join-Path $build ('package-' + [Guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $electron -DestinationPath $stage
Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'Framecut.exe'
& $resourceEditor (Join-Path $stage 'Framecut.exe') --set-icon (Join-Path $root 'framecut.ico') --set-version-string ProductName Framecut --set-version-string FileDescription Framecut --set-version-string OriginalFilename Framecut.exe
if ($LASTEXITCODE) { throw 'The Framecut executable could not be branded.' }
$whisperExtract = Join-Path $build 'whisper'
Expand-Archive -LiteralPath $engine -DestinationPath $whisperExtract -Force
$app = Join-Path $stage 'resources\app'
$speech = Join-Path $app 'whisper'
New-Item -ItemType Directory -Force -Path $speech | Out-Null
$appFiles = @('activity.mjs','desktop.mjs','editor.js','fonts.mjs','framecut.ico','graphics.mjs','index.html','layout.mjs','led.mjs','loop.mjs',
    'motion.mjs','package.json','preload.cjs','projects.css','projects.mjs','remove_object.py','sequences.mjs','server.mjs','sound.mjs','style.css','text.mjs',
    'tracks.mjs','update-config.json','updater.mjs','updates-ui.mjs','workspace.css')
foreach($file in $appFiles) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $app }
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /platform:anycpu "/out:$app\UpdateHelper.exe" "/reference:$framework\System.Web.Extensions.dll" '/reference:System.IO.Compression.dll' '/reference:System.IO.Compression.FileSystem.dll' (Join-Path $PSScriptRoot 'UpdateHelper.cs')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
foreach($file in 'whisper-cli.exe','whisper.dll','ggml.dll','ggml-base.dll','ggml-cpu.dll') {
    Copy-Item -LiteralPath (Join-Path $whisperExtract "Release\$file") -Destination $speech
}
Copy-Item -LiteralPath $model -Destination $speech
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Whisper-LICENSE.txt') -Destination (Join-Path $speech 'LICENSE.txt')

$runtimeFiles = Get-ChildItem -LiteralPath $stage -File -Recurse | Where-Object {
    $_.FullName -ne (Join-Path $stage 'resources\default_app.asar') -and
    (!$_.FullName.StartsWith($app + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $_.FullName.StartsWith($speech + '\', [StringComparison]::OrdinalIgnoreCase))
}
$runtimeEntries = foreach($file in $runtimeFiles) {
    $relative = $file.FullName.Substring($stage.Length + 1)
    $folder = Split-Path $relative -Parent
    $digest = (Get-FileHash -LiteralPath $file.FullName).Hash
    'Source: "{0}"; DestDir: "{{app}}\{1}"; Flags: ignoreversion; Check: RuntimeChanged(''{2}'', ''{3}'')' -f $file.FullName,$folder,$relative,$digest
}
$runtimeEntries | Set-Content -LiteralPath (Join-Path $stage 'runtime-files.iss') -Encoding utf8NoBOM
if ($manifest.runtimeId -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Define the pinned runtime ID in package.json.' }
$patch = Join-Path $dist "Framecut-App-$($manifest.runtimeId).zip"
$appPatch = Get-ChildItem -LiteralPath $app -File | Select-Object -ExpandProperty FullName
Compress-Archive -LiteralPath $appPatch -DestinationPath $patch -Force

if(!$Compiler) {
    $Compiler = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
    if(!$Compiler) {
        $Compiler = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
            (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if(!$Compiler) { throw 'Install Inno Setup 6 or supply its ISCC.exe path with -Compiler.' }
& $Compiler /Q "/DAppVersion=$version" "/DStageRoot=$stage" "/DReleaseRoot=$dist" (Join-Path $PSScriptRoot 'Framecut.iss')
if($LASTEXITCODE) { exit $LASTEXITCODE }
Get-Item -LiteralPath (Join-Path $dist 'Framecut-Setup-x64.exe')
