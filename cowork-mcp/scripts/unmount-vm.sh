#!/bin/sh
umount -l /mnt/claude_rootfs/workspace 2>/dev/null || true
umount -l /mnt/claude_rootfs 2>/dev/null || true
echo "Unmounted /mnt/claude_rootfs successfully."
