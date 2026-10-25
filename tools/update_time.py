"""
Update the project modification timestamp in `最近改动时间.txt`.
Preserves all file headers, comments, and structure, updating only the timestamp line.
"""

from datetime import datetime, timedelta, timezone
import os
import re
import sys


def get_target_file_path() -> str:
  # Look in repo root first (parent of tools/), then current working directory
  tools_dir = os.path.dirname(os.path.abspath(__file__))
  repo_root = os.path.dirname(tools_dir)
  candidate = os.path.join(repo_root, "最近改动时间.txt")
  if os.path.isfile(candidate):
    return candidate
  # Fallback to current working directory
  candidate_cwd = os.path.abspath("最近改动时间.txt")
  if os.path.isfile(candidate_cwd):
    return candidate_cwd
  return candidate


def update_timestamp(file_path: str, quiet: bool = False) -> str:
  # Beijing time (Asia/Shanghai, UTC+8)
  beijing_tz = timezone(timedelta(hours=8))
  now_dt = datetime.now(beijing_tz)
  now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")

  pattern = re.compile(r"\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?")

  if os.path.isfile(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
      content = f.read()

    # Determine newline style
    newline = "\r\n" if "\r\n" in content else "\n"

    if pattern.search(content):
      new_content = pattern.sub(now_str, content, count=1)
    else:
      stripped = content.rstrip("\r\n")
      new_content = (
          stripped + newline + now_str + newline if stripped else now_str + newline
      )

    with open(file_path, "w", encoding="utf-8", newline="") as f:
      f.write(new_content)
  else:
    # If the file does not exist, create it with standard header
    default_content = (
        "最近一次项目修改完成时间（北京时间 / Asia/Shanghai）\r\n"
        f"{now_str}\r\n"
    )
    with open(file_path, "w", encoding="utf-8", newline="") as f:
      f.write(default_content)

  if not quiet:
    print("=" * 56)
    print("  [OK] 成功更新「最近改动时间.txt」")
    print(f"  最新修改时间: {now_str} (北京时间 / Asia/Shanghai)")
    print("=" * 56)

  return now_str


if __name__ == "__main__":
  if sys.platform == "win32":
    try:
      # Ensure utf-8 output without failing on consoles
      if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
      pass

  quiet_mode = any(arg in sys.argv for arg in ("--quiet", "-q", "/q"))
  target = get_target_file_path()

  try:
    update_timestamp(target, quiet=quiet_mode)
  except Exception as e:
    print(f"[ERROR] 更新修改时间失败: {e}", file=sys.stderr)
    sys.exit(1)
