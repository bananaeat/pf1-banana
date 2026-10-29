"""打包 pf1-banana：dist/pf1-banana-<版本>.zip（文件在 zip 根目录）+ dist/module.json，传到 GitHub Release。"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCLUDE = ["module.json", "README.md", "CHANGELOG.md", "LICENSE", "LICENSE-DATA", "NOTICE.md", "OGL.txt", "scripts", "styles", "vendor", "data"]


def main():
    version = json.loads((ROOT / "module.json").read_text("utf-8"))["version"]
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / f"pf1-banana-{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in INCLUDE:
            p = ROOT / name
            for f in [p] if p.is_file() else sorted(x for x in p.rglob("*") if x.is_file()):
                z.write(f, f.relative_to(ROOT).as_posix())
    (dist / "module.json").write_bytes((ROOT / "module.json").read_bytes())
    print(out, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
