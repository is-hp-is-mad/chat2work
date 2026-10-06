# mount-vm.ps1 - Mount official Claude Cowork rootfs.vhdx into WSL2
$ErrorActionPreference = "SilentlyContinue"

$vhdxPath = "$env:APPDATA\Claude\vm_bundles\claudevm.bundle\rootfs.vhdx"
if (-not (Test-Path $vhdxPath)) {
    Write-Error "Official rootfs.vhdx not found at $vhdxPath"
    exit 1
}

Write-Host "==> Attaching $vhdxPath to WSL2 (bare VHD)..." -ForegroundColor Cyan
wsl --mount $vhdxPath --vhd --bare 2>$null

Write-Host "==> Locating and mounting Claude rootfs in WSL2..." -ForegroundColor Cyan
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$wslScript = (wsl wslpath -a -u "$scriptDir\mount-vm.sh").Trim()
$wslWork = (wsl wslpath -a -u "$scriptDir\..").Trim()
wsl -u root $wslScript $wslWork

Write-Host "`n[Success] Official Claude Cowork image is mounted and ready!" -ForegroundColor Green
Write-Host "Run commands inside the official environment via:"
Write-Host '  wsl -u root chroot /mnt/claude_rootfs /usr/bin/python3 -c "import docx, openpyxl, pptx; ..."' -ForegroundColor Yellow
