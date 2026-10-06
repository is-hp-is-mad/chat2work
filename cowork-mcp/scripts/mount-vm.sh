#!/bin/sh
set -e

DEV=$(findfs LABEL=cloudimg-rootfs 2>/dev/null || true)
if [ -z "$DEV" ]; then
    DEV=$(lsblk -rnpo NAME,LABEL | grep "cloudimg-rootfs" | awk '{print $1}' | head -n 1)
fi

if [ -z "$DEV" ]; then
    echo "[Error] Could not locate cloudimg-rootfs partition." >&2
    exit 1
fi

echo "Found official partition: $DEV"
mkdir -p /mnt/claude_rootfs
if ! mountpoint -q /mnt/claude_rootfs; then
    mount -o ro "$DEV" /mnt/claude_rootfs
    echo "Mounted $DEV to /mnt/claude_rootfs (read-only)"
else
    echo "/mnt/claude_rootfs is already mounted."
fi

WORKSPACE_PATH="${1:-/mnt/d/chat2work}"
mkdir -p /mnt/claude_rootfs/workspace
if ! mountpoint -q /mnt/claude_rootfs/workspace; then
    mount --bind "$WORKSPACE_PATH" /mnt/claude_rootfs/workspace
    echo "Bind-mounted $WORKSPACE_PATH to /mnt/claude_rootfs/workspace"
fi

echo "=== Official Claude Cowork Environment Ready ==="
chroot /mnt/claude_rootfs /usr/bin/python3 --version
chroot /mnt/claude_rootfs /usr/bin/node --version
chroot /mnt/claude_rootfs /usr/bin/pandoc --version | head -n 1
