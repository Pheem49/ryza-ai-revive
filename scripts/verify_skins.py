#!/usr/bin/env python3
"""复核官方那 6 款服装是否与官方记录一致（docs/official/masters_bundle.json）。

官方记录里每套皮肤都有 `asset`：
  · `archive.sha256` / `archive.bytes` —— 官方 zip 档案（`spine/crf_chr_002/<id>/rN.zip`）
  · `files[]`                          —— 档案里 4 个成员的名字与字节数

两种用法：
  python scripts/verify_skins.py
      只比对**已经落地**到 web/assets/spine/crf_chr_002/<id>/ 的文件字节数。
      本仓库不跟大二进制（.png/.skel 由 restore_media.py 还原），所以这是
      「还原得对不对」的检查：文件缺了、截断了、换错了都会报出来。

  python scripts/verify_skins.py path/to/r2.zip [more.zip ...]
      额外校验官方档案本身：zip 的 sha256 与逐成员字节数（对照上表）。
      档案从官方 Firebase Storage 拉（见 docs/official/REFERENCES.md §1.2），
      公开可读；不要把它提交进仓库、也不要打进安装包。

任一不一致 → 退出码 1。
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "docs" / "official" / "masters_bundle.json"
LANDED = ROOT / "web" / "assets" / "spine" / "crf_chr_002"


def load_skins() -> list[dict]:
    data = json.loads(BUNDLE.read_text(encoding="utf-8"))
    bundle = data.get("bundle") or {}
    skins = bundle.get("skins") or []
    if not skins:
        sys.exit(f"{BUNDLE} 里没有 skins —— 记录文件被动过？")
    return skins


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def landed_candidates(name: str) -> list[str]:
    """落地时可能的文件名（按优先级）。

    `*_gesture.json` 是特例：官方 1.1.1 的动作表带两套座视结构，本项目
    仍以 1.0.2 版为主用表，1.1.1 原文件存成同名的 `*_gesture.rev2.json`
    （见 docs/official/README.md §3）。所以两者任一个对上记录都算通过，
    但报告里会写清楚是哪一份对的。
    """
    if name.endswith("_gesture.json"):
        return [name, name[: -len(".json")] + ".rev2.json"]
    return [name]


def check_landed(skins: list[dict]) -> int:
    bad = 0
    checked = 0
    print("== 落地文件字节数（对照官方记录）")
    for skin in skins:
        sid = skin["id"]
        files = (skin.get("asset") or {}).get("files") or []
        for rec in files:
            name, want = rec["name"], int(rec["bytes"])
            present = []
            for cand in landed_candidates(name):
                path = LANDED / sid / cand
                if path.exists():
                    present.append((cand, path, path.stat().st_size))
            if not present:
                print(f"  MISS {sid}/{name}（没还原？跑 scripts/restore_media.py）")
                bad += 1
                continue
            checked += 1
            hit = next((x for x in present if x[2] == want), None)
            if hit is None:
                sizes = ", ".join(f"{c}={s}" for c, _p, s in present)
                print(f"  FAIL {sid}/{name}: 落地是 {sizes}，记录是 {want}")
                bad += 1
            elif hit[0] != name:
                print(f"  OK   {sid}/{hit[0]} == 记录（1.1.1 副本；主用表是同名的 1.0.2 文件）")
    print(f"  → 比对 {checked} 个文件，{bad} 个不一致")
    return bad


def check_archives(skins: list[dict], paths: list[str]) -> int:
    by_hash = {}
    by_name = {}
    for skin in skins:
        arch = (skin.get("asset") or {}).get("archive") or {}
        if arch.get("sha256"):
            by_hash[arch["sha256"]] = skin
        if arch.get("path"):
            by_name[Path(arch["path"]).name] = skin
        # r2.zip 被 0001_01 与 0001_99 共用：同 hash 要能对上任意一套
        if arch.get("sha256"):
            by_hash.setdefault(arch["sha256"], skin)

    bad = 0
    print("== 官方档案")
    for raw in paths:
        p = Path(raw)
        if not p.exists():
            print(f"  MISS {p}")
            bad += 1
            continue
        digest = sha256_file(p)
        skin = by_hash.get(digest) or by_name.get(p.name)
        if not skin:
            print(f"  FAIL {p.name}: sha256 {digest[:16]}… 不在官方记录的 6 档里")
            bad += 1
            continue
        rec = skin["asset"]["archive"]
        if digest != rec["sha256"]:
            print(f"  FAIL {p.name}: sha256 与记录不符（拿到的档案不是这一档）")
            bad += 1
            continue
        size = p.stat().st_size
        if size != int(rec["bytes"]):
            print(f"  FAIL {p.name}: {size} bytes, 记录是 {rec['bytes']}")
            bad += 1
            continue
        with zipfile.ZipFile(p) as zf:
            members = {Path(i.filename).name: i.file_size for i in zf.infolist()
                       if not i.is_dir()}
        want_members = {r["name"]: int(r["bytes"]) for r in skin["asset"]["files"]}
        file_bad = 0
        for name, want in want_members.items():
            got = members.get(name)
            if got is None:
                print(f"  FAIL {p.name}: 档案里没有 {name}")
                file_bad += 1
            elif got != want:
                print(f"  FAIL {p.name}: {name} {got} bytes, 记录是 {want}")
                file_bad += 1
        bad += file_bad
        if file_bad == 0:
            print(f"  OK   {p.name} → {skin['id']}（sha256 + {len(want_members)} 个成员字节数一致）")
    return bad


def main() -> int:
    skins = load_skins()
    bad = check_landed(skins)
    if len(sys.argv) > 1:
        bad += check_archives(skins, sys.argv[1:])
    print("\nSKINS: " + ("OK" if bad == 0 else f"{bad} 处不一致"))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())