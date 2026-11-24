$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload64)) | ConvertFrom-Json
$result = @{ version = $job.installer.version; ok = $false }
try {
    Wait-Process -Id $job.pid -Timeout 45 -ErrorAction SilentlyContinue
    if (Get-Process -Id $job.pid -ErrorAction SilentlyContinue) { throw 'Framecut did not close before the update.' }
    $digest = (Get-FileHash -LiteralPath $job.installer.path -Algorithm SHA256).Hash
    if ($digest -ne $job.installer.digest) { throw 'The saved installer failed verification.' }
    $directory = Split-Path -LiteralPath $job.executable
    $log = Join-Path (Split-Path -LiteralPath $job.statusFile) 'update-install.log'
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOCLOSEAPPLICATIONS',
        ('/DIR="' + $directory + '"'), ('/LOG="' + $log + '"'))
    if (!(Get-ChildItem -LiteralPath $directory -Filter 'unins*.exe' -File)) {
        $arguments += '/framecut-portable=1'
    }
    $installer = Start-Process -FilePath $job.installer.path -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($installer.ExitCode -ne 0) { throw "Windows setup exited with code $($installer.ExitCode)." }
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
}
$result | ConvertTo-Json -Compress | Set-Content -LiteralPath $job.statusFile -Encoding UTF8
if (Test-Path -LiteralPath $job.executable -PathType Leaf) {
    Start-Process -FilePath $job.executable -ArgumentList ('--user-data-dir="' + $job.profile + '"')
}
