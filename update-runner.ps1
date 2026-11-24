$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload64)) | ConvertFrom-Json
$result = @{ version = $job.installer.version; ok = $false }
try {
    $running = $null
    try { $running = [Diagnostics.Process]::GetProcessById([int]$job.pid) } catch [ArgumentException] {}
    if ($running -and !$running.WaitForExit(45000)) { throw 'Framecut did not close before the update.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($job.installer.path)
    try { $digest = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hash.Dispose() }
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
[IO.File]::WriteAllText($job.statusFile, ($result | ConvertTo-Json -Compress))
if (Test-Path -LiteralPath $job.executable -PathType Leaf) {
    Start-Process -FilePath $job.executable -ArgumentList ('--user-data-dir="' + $job.profile + '"')
}
