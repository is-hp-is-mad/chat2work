# unmount-vm.ps1 - Unmount official Claude Cowork rootfs.vhdx from WSL2
$ErrorActionPreference = "SilentlyContinue"

Write-Host "==> Unmounting chroot mountpoints in WSL..." -ForegroundColor Cyan
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$wslScript = (wsl wslpath -a -u "$scriptDir\unmount-vm.sh").Trim()
wsl -u root $wslScript

$vhdxPath = "$env:APPDATA\Claude\vm_bundles\claudevm.bundle\rootfs.vhdx"
Write-Host "==> Detaching VHD from WSL..." -ForegroundColor Cyan
wsl --unmount $vhdxPath

Write-Host "[Success] Unmounted successfully." -ForegroundColor Green
