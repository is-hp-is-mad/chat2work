#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_crx.py — 从 Chrome Web Store 下载「Claude in Chrome」官方扩展并解包。

用法:
    python3 tools/fetch_crx.py [目标目录]     # 默认 original/

扩展 ID: fcoeoabgfenejglbffodgkkbkcdhcgfn  (Anthropic 官方 "Claude" / "Claude in Chrome")
"""
import io
import os
import struct
import sys
import zipfile
import urllib.request

EXT_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
CRX_URL = (
    "https://clients2.google.com/service/update2/crx?response=redirect"
    "&os=win&arch=x64&nacl_arch=x86-64&prod=chromecrx&prodversion=130.0.0.0"
    "&lang=en-US&acceptformat=crx3"
    "&x=id%3D" + EXT_ID + "%26uc"
)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "original"
    os.makedirs(out_dir, exist_ok=True)
    print("downloading CRX ...")
    with urllib.request.urlopen(CRX_URL, timeout=120) as r:
        data = r.read()
    if data[:4] != b"Cr24":
        raise SystemExit("not a CRX file (magic mismatch)")
    _magic, ver, header_len = struct.unpack("<III", data[:12])
    if ver != 3:
        raise SystemExit("unexpected CRX version: %d" % ver)
    zip_bytes = data[12 + header_len:]
    print("unpacking %d bytes ..." % len(zip_bytes))
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        z.extractall(out_dir)
    # _metadata 为商店校验数据，解包加载用不到
    meta = os.path.join(out_dir, "_metadata")
    if os.path.isdir(meta):
        import shutil
        shutil.rmtree(meta)
    print("done ->", out_dir)


if __name__ == "__main__":
    main()
