"""看门狗：start.bat 必须保持纯 ASCII。

背景（这次真实踩到的坑）：
    cmd.exe 是用「当前控制台代码页」解码 .bat 文件内容的，而不是 UTF-8。
    中文 Windows 起始代码页是 936(GBK)，文件里的 UTF-8 中文会被双字节解码，
    当读取缓冲区的边界恰好落在一个汉字中间时，多出来的半截字节会和后面的文字
    拼成一个不存在的命令 token，于是启动器窗口先刷出一串乱码、再报：
        '??<乱码>' is not recognized as an internal or external command
    最坑的是：文件里那句 chcp 65001 只能改变「切换之后」的控制台输出代码页，
    并不能把已经/正在按 936 解码的正文救回来，所以报错照样出现。

    这类崩溃对「代码页 + 缓冲区边界」敏感，只在特定 Windows 上偶发、无法稳定复现，
    因此这里不做行为模拟，而是直接钉死不变量：批处理里出现非 ASCII 字节即失败。
    所有面向用户的中文提示都交给 server.py 打印（chcp 后其 stdout 为 UTF-8）。

用法：python tests/test_launcher_ascii.py   （返回码 0 = 通过）
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(ROOT, 'start.bat')


def check(path):
    problems = []
    with open(path, 'rb') as f:
        raw = f.read()

    if not raw:
        return [f'{os.path.basename(path)} 是空文件']

    # 1) BOM 会让 cmd 把首行当成 "<BOM>@echo off" 而报错
    if raw.startswith(b'\xef\xbb\xbf'):
        problems.append('文件带 UTF-8 BOM：cmd 会把 BOM 当成首行命令的一部分')

    # 2) 非 ASCII 字节 = 地雷本体
    for lineno, line in enumerate(raw.split(b'\r\n'), start=1):
        bad = [(i, b) for i, b in enumerate(line) if b > 0x7F]
        if bad:
            col, byte = bad[0]
            try:
                shown = line.decode('utf-8')
            except UnicodeDecodeError:
                shown = line.decode('gbk', errors='replace')
            problems.append(
                f'第 {lineno} 行含非 ASCII 字节 (偏移 {col}, 0x{byte:02X})：{shown.strip()[:60]}'
            )

    return problems


def main():
    if not os.path.isfile(LAUNCHER):
        print(f'[FAIL] 找不到启动器: {LAUNCHER}')
        return 1

    problems = check(LAUNCHER)
    with open(LAUNCHER, 'rb') as f:
        size = len(f.read())

    if problems:
        print(f'[FAIL] {os.path.basename(LAUNCHER)} 不是纯 ASCII（{size} bytes）:')
        for p in problems:
            print('   -', p)
        print('\n修复：把中文提示移到 server.py 里打印，批处理只留英文/ASCII。')
        return 1

    print(f'[PASS] {os.path.basename(LAUNCHER)} 为纯 ASCII（{size} bytes），'
          f'任何代码页下都不会出现 "not recognized" 乱码报错')
    return 0


if __name__ == '__main__':
    sys.exit(main())
