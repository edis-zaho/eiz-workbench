# Run only inside the disposable, offline Windows QA guest.
param([string]$Installer='C:\WB-QA\setup.exe',[switch]$Resume)
$ErrorActionPreference='Stop'
$qaRoot='C:\WB-QA'
$installRoot='C:\WorkbenchPublicQA'
$profileRoot=Join-Path $env:APPDATA 'EiZ Workbench'
$exe=Join-Path $installRoot 'EiZ Workbench.exe'
$db=Join-Path $profileRoot 'revenue.sqlite'
$result=[ordered]@{passed=$false;checks=@();liveProvidersUsed=$false}
function Record([string]$message) { $script:result.checks+= $message }
function Stop-TestApp {
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
}
function Start-TestApp {
    Start-Process -FilePath $exe -WindowStyle Hidden | Out-Null
    for($i=0;$i -lt 40;$i++) {
        if((Test-Path -LiteralPath $db) -and (Test-Path -LiteralPath (Join-Path $profileRoot 'backup-key.enc'))) {break}
        Start-Sleep -Milliseconds 500
    }
    if(!(Test-Path -LiteralPath $db)){throw 'Application did not create its local database.'}
    Start-Sleep -Seconds 3
    if(!(Get-Process | Where-Object { $_.Path -eq $exe })){throw 'Application exited after startup.'}
    Stop-TestApp
}
try {
    if(!$Resume) {
        if(Test-Path -LiteralPath $installRoot){throw 'QA installation directory must be absent before this test.'}
        if(Test-Path -LiteralPath $profileRoot){throw 'A fresh Windows profile is required for this test.'}
        $p=Start-Process -FilePath $Installer -ArgumentList @('/S',"/D=$installRoot") -WindowStyle Hidden -Wait -PassThru
        if($p.ExitCode -ne 0 -or !(Test-Path -LiteralPath $exe)){throw "Installation failed: $($p.ExitCode)"}
    }
    Record 'Silent installation into dedicated test directory'
    Start-TestApp
    Record 'Installed application starts and creates an independent local profile'
    $env:ELECTRON_RUN_AS_NODE='1'
    $probe=Start-Process -FilePath $exe -ArgumentList @((Join-Path $qaRoot 'inspect-profile.cjs'),"`"$db`"",(Join-Path $qaRoot 'database-result.json')) -WindowStyle Hidden -Wait -PassThru
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    if($probe.ExitCode -ne 0){throw 'Database inspection did not complete.'}
    $state=Get-Content -LiteralPath (Join-Path $qaRoot 'database-result.json') -Raw | ConvertFrom-Json
    if($state.clients -ne 0 -or $state.schema -ne 34){throw 'Fresh profile contains data or wrong schema.'}
    Record 'Fresh database: zero customers, schema 34'
    $before=(Get-FileHash -LiteralPath $db -Algorithm SHA256).Hash
    $p=Start-Process -FilePath $Installer -ArgumentList @('/S',"/D=$installRoot") -WindowStyle Hidden -Wait -PassThru
    if($p.ExitCode -ne 0){throw "Reinstallation failed: $($p.ExitCode)"}
    Stop-TestApp
    if((Get-FileHash -LiteralPath $db -Algorithm SHA256).Hash -ne $before){throw 'Reinstallation modified customer data.'}
    Record 'Same-version update/reinstallation preserves the database'
    Start-TestApp
    Record 'Application starts again after reinstallation'
    $before=(Get-FileHash -LiteralPath $db -Algorithm SHA256).Hash
    $uninstaller=Join-Path $installRoot 'Uninstall EiZ Workbench.exe'
    if(!(Test-Path -LiteralPath $uninstaller)){throw 'Uninstaller missing.'}
    Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait | Out-Null
    for($i=0;$i -lt 40 -and (Test-Path -LiteralPath $exe);$i++){Start-Sleep -Milliseconds 500}
    if(Test-Path -LiteralPath $exe){throw 'Uninstallation did not remove the executable.'}
    if(!(Test-Path -LiteralPath $db) -or (Get-FileHash -LiteralPath $db -Algorithm SHA256).Hash -ne $before){throw 'Uninstallation removed or changed customer data.'}
    Record 'Uninstallation removes program and preserves customer database'
    $result.passed=$true
} catch { $result.error=$_.Exception.Message }
finally {
    Stop-TestApp
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $qaRoot 'result.json') -Encoding UTF8
}
if(!$result.passed){exit 1}
