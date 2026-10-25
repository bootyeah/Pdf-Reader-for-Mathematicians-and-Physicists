# -*- coding: utf-8 -*-
"""纯标准库实现的 QR 码生成器（byte 模式，纠错等级 M）。

为什么要自己写：目标机器上不一定有 `qrcode`/`segno` 这类第三方库，而本工具
需要「手机扫码打开网页」这一开箱即用的能力，所以把它做成零依赖。
实现遵循 ISO/IEC 18004：RS 纠错、8 种掩码打分、格式/版本信息 BCH 编码。

自检（selftest.py 会调用）：decode_qr() 能把生成的矩阵重新解回原文，
并校验每个 RS 块的伴随式为 0，等价于「一个解码器能读出它」。
"""
from PIL import Image

# 每个版本的 RS 块表：{version: (ec_per_block, [(块数, 每块数据码字), ...])}
# 纠错等级 M，版本 1..20。表里的每一项都会在 _validate_tables() 里用
# 「数据模块数 == 总码字数 * 8」交叉校验，一旦写错会立刻报错，
# 不会生成扫不出来的二维码（selftest 还会做整矩阵回读校验）。
_EC_M = {
    1: (10, [(1, 16)]),
    2: (16, [(1, 28)]),
    3: (26, [(1, 44)]),
    4: (18, [(2, 32)]),
    5: (24, [(2, 43)]),
    6: (16, [(4, 27)]),
    7: (18, [(4, 31)]),
    8: (22, [(2, 38), (2, 39)]),
    9: (22, [(3, 36), (2, 37)]),
    10: (26, [(4, 43), (1, 44)]),
    11: (30, [(1, 50), (4, 51)]),
    12: (22, [(6, 36), (2, 37)]),
    13: (22, [(8, 37), (1, 38)]),
    14: (24, [(4, 40), (5, 41)]),
    15: (24, [(5, 41), (5, 42)]),
    16: (28, [(7, 45), (3, 46)]),
    17: (28, [(10, 46), (1, 47)]),
    18: (26, [(9, 43), (4, 44)]),
    19: (26, [(3, 44), (11, 45)]),
    20: (26, [(3, 41), (13, 42)]),
}

# 版本 -> 对齐图形中心坐标（ISO/IEC 18004 附录 E）
_ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
    18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
}

# 各版本的总码字数（ISO/IEC 18004 表 1）
_TOTAL_CODEWORDS = {
    1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292,
    10: 346, 11: 404, 12: 466, 13: 532, 14: 581, 15: 655, 16: 733, 17: 815,
    18: 901, 19: 991, 20: 1085,
}

# 各版本的剩余位（remainder bits）：数据区比码字数*8 多出的位数，填 0 即可
_REMAINDER_BITS = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0,
                   10: 0, 11: 0, 12: 0, 13: 0, 14: 3, 15: 3, 16: 3, 17: 3,
                   18: 3, 19: 3, 20: 3}


def data_modules(version):
    """数据区模块数 = 总码字数*8 + 剩余位，用真正的预留区实现来数。

    预留区 = 定位图形(+分隔符) + 定时图形 + 格式信息(+固定深色模块)
             + 对齐图形 + 版本信息（版本 >= 7）
    """
    size = version * 4 + 17
    res = _mark_reserved(_function_only_matrix(version), version)
    return sum(1 for row in res for x in row if not x)


def total_codewords(version):
    """该版本的总码字数（数据 + 纠错），与 ISO/IEC 18004 表 1 一致。"""
    return _TOTAL_CODEWORDS[version]


def _function_only_matrix(version):
    """只含功能图形的空矩阵，用于自检预留区统计。"""
    size = version * 4 + 17
    matrix = _blank_matrix(size)
    _draw_function_patterns(matrix, version)
    return matrix


def validate_tables():
    """自检：块表/对齐表写错就报错，而不是生成扫不出来的二维码。

    导入时不自动执行（便于单独调试），由 selftest.py 调用，
    也可手动 `python -c "import qr; qr.validate_tables()"`。
    """
    for v, (ec_per_block, groups) in _EC_M.items():
        data = sum(count * dlen for count, dlen in groups)
        if v < 10 and data > 255:
            raise AssertionError(f"版本 {v} 数据码字超过 255，字符计数需 16 位")
        blocks = sum(count for count, _ in groups)
        total = data + blocks * ec_per_block
        expected = _TOTAL_CODEWORDS[v]
        if total != expected:
            raise AssertionError(
                f"QR 块表有误：版本 {v} 数据 {data} + 纠错 "
                f"{blocks * ec_per_block} = {total}，应为 {expected}")
        # 交叉校验：预留区实现数出来的数据格必须 = 码字数*8 + 剩余位
        free = data_modules(v)
        want = expected * 8 + _REMAINDER_BITS[v]
        if free != want:
            raise AssertionError(
                f"版本 {v} 数据区 {free} != 期望 {want}"
                f"（码字 {expected * 8} + 剩余位 {_REMAINDER_BITS[v]}）")
    # 对齐图形表必须与版本自洽：{6} ∪ 表 严格递增，且首尾为 6 / size-7
    for v, centers in _ALIGN.items():
        if v == 1:
            if centers:
                raise AssertionError("版本 1 不应有对齐图形")
            continue
        size = v * 4 + 17
        allc = sorted(set([6] + list(centers)))
        if allc[0] != 6 or allc[-1] != size - 7:
            raise AssertionError(f"版本 {v} 对齐图形坐标不对：{allc}")
        if len(allc) >= 3:
            steps = [b - a for a, b in zip(allc, allc[1:])]
            if any(s <= 0 or s % 2 for s in steps):
                raise AssertionError(f"版本 {v} 对齐图形间距异常：{steps}")
    if set(_ALIGN) != set(_EC_M):
        raise AssertionError("_ALIGN 与 _EC_M 的版本集合不一致")
    # 格式信息写/读必须使用同一套坐标（否则解码器读不出来）
    for mask in range(8):
        m = _blank_matrix(21)
        _draw_function_patterns(m, 1)
        _draw_format(m, "M", mask)
        if read_format_bits(m, 21) != format_bits("M", mask):
            raise AssertionError(f"格式信息写入/读取不一致（mask={mask}）")
        if read_format_bits(m, 21) != format_bits("L", mask) and \
                read_format_bits(m, 21) == format_bits("M", (mask + 1) % 8):
            raise AssertionError("格式信息位序错位")
    return True


# 纠错等级在格式信息里的两位编码（注意不是数字顺序！低纠错等级反而排前）
_EC_LEVEL_BITS = {"L": 0b01, "M": 0b00, "Q": 0b11, "H": 0b10}

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _gmul(a, b):
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _rs_generator(n):
    g = [1]
    for i in range(n):
        g2 = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            g2[j] ^= c
            g2[j + 1] ^= _gmul(c, _EXP[i])
        g = g2
    return g


_GEN_CACHE = {}


def rs_generator(n):
    if n not in _GEN_CACHE:
        _GEN_CACHE[n] = _rs_generator(n)
    return _GEN_CACHE[n]


def rs_encode(data, ec_len):
    """计算 ec_len 个纠错码字。"""
    gen = rs_generator(ec_len)
    res = [0] * ec_len
    for b in data:
        factor = b ^ res[0]
        res = res[1:] + [0]
        if factor:
            lf = _LOG[factor]
            for i in range(ec_len):
                if gen[i + 1]:
                    res[i] ^= _EXP[lf + _LOG[gen[i + 1]]]
    return res


def _bch(data, poly, bits):
    """通用 BCH 余数计算（用于格式/版本信息）。"""
    d = data << bits
    g_len = poly.bit_length()
    while d.bit_length() >= g_len:
        d ^= poly << (d.bit_length() - g_len)
    return d


def format_bits(ec_level, mask):
    data = (_EC_LEVEL_BITS[ec_level] << 3) | mask
    rem = _bch(data, 0b10100110111, 10)
    return ((data << 10) | rem) ^ 0b101010000010010


def version_bits(version):
    rem = _bch(version, 0b1111100100101, 12)
    return (version << 12) | rem


# --------------------------------------------------------------------------
# 数据编码
# --------------------------------------------------------------------------

def _capacity_bytes(version):
    ec_per_block, groups = _EC_M[version]
    return sum(count * data for count, data in groups)


def max_payload_bytes(version):
    """该版本 byte 模式最多能放的字节数（已扣掉 mode + 字符计数指示符）。"""
    char_bits = 8 if version < 10 else 16
    return (_capacity_bytes(version) * 8 - 4 - char_bits) // 8


def choose_version(nbytes):
    for v in sorted(_EC_M):
        if nbytes <= max_payload_bytes(v):
            return v
    raise ValueError(
        "内容太长：当前支持的版本最多放 %d 字节"
        % max_payload_bytes(max(_EC_M)))


def encode_data(data, version):
    """把字节串编码成该版本的数据码字序列（含终止符与 0xEC/0x11 交替填充）。

    严格遵守 ISO/IEC 18004 7.4.9 / 7.4.10：
      1) mode(0100) + 字符计数 + 数据位
      2) 终止符：最多 4 个 0，且不超过剩余容量
      3) 补 0 到字节边界（已在边界则不补）
      4) 用 0xEC / 0x11 交替填满数据容量
    数据超出容量时抛 ValueError，绝不静默截断（否则会生成扫不出来的码）。
    """
    if isinstance(data, str):
        data = data.encode("utf-8")
    total = _capacity_bytes(version)
    cap_bits = total * 8
    char_bits = 8 if version < 10 else 16
    header_bits = 4 + char_bits
    if header_bits + len(data) * 8 > cap_bits:
        raise ValueError(
            "内容太长：版本 %d 只能放 %d 字节，收到 %d 字节"
            % (version, max_payload_bytes(version), len(data)))
    bits = []

    def put(value, n):
        for i in range(n - 1, -1, -1):
            bits.append((value >> i) & 1)

    put(0b0100, 4)              # byte 模式
    put(len(data), char_bits)
    for b in data:
        put(b, 8)
    term = min(4, cap_bits - len(bits))
    put(0, term)
    while len(bits) % 8:
        bits.append(0)
    codewords = [int("".join(str(b) for b in bits[i:i + 8]), 2)
                 for i in range(0, len(bits), 8)]
    if len(codewords) > total:
        raise ValueError("内部错误：数据码字超过容量")
    pad = (0xEC, 0x11)
    i = 0
    while len(codewords) < total:
        codewords.append(pad[i % 2])
        i += 1
    return codewords


def interleave(codewords, version):
    ec_per_block, groups = _EC_M[version]
    blocks = []
    idx = 0
    for count, data_len in groups:
        for _ in range(count):
            chunk = codewords[idx:idx + data_len]
            idx += data_len
            blocks.append((chunk, rs_encode(chunk, ec_per_block)))
    out = []
    max_data = max(len(b[0]) for b in blocks)
    for i in range(max_data):
        for data, _ec in blocks:
            if i < len(data):
                out.append(data[i])
    for i in range(ec_per_block):
        for _data, ec in blocks:
            out.append(ec[i])
    return out


# --------------------------------------------------------------------------
# 矩阵
# --------------------------------------------------------------------------

def _blank_matrix(size):
    return [[None] * size for _ in range(size)]


def _finder(matrix, row, col):
    """在 (row, col) 左上角画 7x7 定位图形 + 朝向码内的 L 形分隔符。

    分隔符贴在定位图形朝码中心的那两条边上（宽 1 格）：
      - 左上 (0,0)：右边 (col+7) + 下边 (row+7)
      - 右上 (0,size-7)：左边 (col-1) + 下边 (row+7)，即 row 6 那一行
      - 左下 (size-7,0)：右边 (col+7) + 上边 (row-1)，即 row size-8 那一行
    画错一条边就会多占/少占数据模块，导致整个二维码扫不出来。
    """
    size = len(matrix)
    for dr in range(7):
        for dc in range(7):
            edge = dr in (0, 6) or dc in (0, 6)
            core = 2 <= dr <= 4 and 2 <= dc <= 4
            matrix[row + dr][col + dc] = 1 if (edge or core) else 0
    # 下边：靠上的定位图形用 row+7；靠下的用 row-1（= size-8）
    sep_row = row + 7 if row < size // 2 else row - 1
    # 左边/右边：靠左的定位图形用 col+7；靠右的用 col-1
    sep_col = col + 7 if col < size // 2 else col - 1
    for i in range(8):
        r, c = sep_row, col + i
        if 0 <= r < size and 0 <= c < size:
            matrix[r][c] = 0
        r, c = row + i, sep_col
        if 0 <= r < size and 0 <= c < size:
            matrix[r][c] = 0


def _alignment(matrix, version):
    centers = _ALIGN[version]
    size = len(matrix)
    for r in centers:
        for c in centers:
            # 跳过与定位图形重叠的三个角
            if (r <= 8 and c <= 8) or (r <= 8 and c >= size - 9) or \
               (r >= size - 9 and c <= 8):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    edge = max(abs(dr), abs(dc))
                    matrix[r + dr][c + dc] = 1 if edge != 1 else 0


def _format_cells(size):
    """格式信息两份 + 固定深色模块（共 31 格），与 _draw_format 的摆放对应：

      左上纵向 (i, 8)：i = 0..5, 7                 -> 7 格（i=6 是定时图形）
      左上横向 (8, i)：i = 0..5, 7, 8              -> 8 格（i=6 是定时图形）
      右上横向 (8, size-1-i)：i = 0..7             -> 8 格
      左下纵向 (size-1-i, 8)：i = 0..7             -> 8 格
      固定深色模块 (size-8, 8) 已被左下纵向段覆盖，恒为 1
    """
    cells = [(i, 8) for i in range(6)] + [(7, 8)]
    cells += [(8, i) for i in range(6)] + [(8, 7), (8, 8)]
    cells += [(8, size - 1 - i) for i in range(8)]
    cells += [(size - 1 - i, 8) for i in range(8)]
    return cells


def _mark_reserved(matrix, version):
    """标记不可写数据的模块（功能图形 + 格式/版本信息）。

    功能图形直接从矩阵读（非 None 即已放置），格式/版本信息按标准坐标显式标记。
    这样统计出的可用数据模块数必须与 ISO 总码字数严格一致（validate_tables 校验）。
    """
    size = len(matrix)
    res = [[matrix[r][c] is not None for c in range(size)] for r in range(size)]
    for r, c in _format_cells(size):
        res[r][c] = True
    if version >= 7:                # 版本信息（两份 3x6 = 36 位）
        for r, c, _b in _version_cells(size):
            res[r][c] = True
    return res


def _mask_bit(mask, r, c):
    if mask == 0:
        return (r + c) % 2 == 0
    if mask == 1:
        return r % 2 == 0
    if mask == 2:
        return c % 3 == 0
    if mask == 3:
        return (r + c) % 3 == 0
    if mask == 4:
        return (r // 2 + c // 3) % 2 == 0
    if mask == 5:
        return (r * c) % 2 + (r * c) % 3 == 0
    if mask == 6:
        return ((r * c) % 2 + (r * c) % 3) % 2 == 0
    return ((r + c) % 2 + (r * c) % 3) % 2 == 0


def _place_data(matrix, res, codewords, mask):
    """之字形填充数据位（跳过功能图形区）。"""
    size = len(matrix)
    bits = []
    for cw in codewords:
        for i in range(7, -1, -1):
            bits.append((cw >> i) & 1)
    idx = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:      # 跳过垂直定时图形所在的整列
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for row in rows:
            for c in (col, col - 1):
                if res[row][c]:
                    continue
                bit = bits[idx] if idx < len(bits) else 0
                idx += 1
                matrix[row][c] = bit ^ (1 if _mask_bit(mask, row, c) else 0)
        col -= 2
        upward = not upward


def format_bit_positions(size):
    """副本 1 的 15 个格坐标，顺序对应 format_bits 的 bit14 -> bit0。

    与 _draw_format 的写法严格对应（自检时会校验两者一致）：
      横向：(8,0),(8,1),(8,2),(8,3),(8,4),(8,5),(8,7),(8,8)
      纵向：(7,8),(5,8),(4,8),(3,8),(2,8),(1,8),(0,8)
    """
    return ([(8, i) for i in range(6)] + [(8, 7), (8, 8)] +
            [(7, 8)] + [(5 - i, 8) for i in range(6)])


def read_format_bits(matrix, size):
    """从矩阵副本 1 读出 15 位格式串（返回整数，最高位对应 bit14）。"""
    val = 0
    for (r, c) in format_bit_positions(size):
        val = (val << 1) | (1 if matrix[r][c] else 0)
    return val


def _draw_format(matrix, ec_level, mask):
    """写入格式信息两份，逐格复刻 ISO/IEC 18004 的摆放（与 segno 完全一致）。

    格式串 15 位，bit0 是最低位。摆放规则（voffset/hoffset 用于跳过定时图形）：
      i = 0..7：
        vbit = 位 i        -> matrix[i + voffset][8]        （左上纵向）
        hbit = 位 (14 - i) -> matrix[8][i + hoffset]        （左上横向）
        vbit                -> matrix[8][size-1-i]          （右上横向）
        hbit                -> matrix[size-1-i][8]          （左下纵向）
      i == 6 时（定时图形格）纵向与横向各跳过一格。
    最后 (size-8, 8) 为固定深色模块 = 1。
    """
    size = len(matrix)
    fmt = format_bits(ec_level, mask)
    voffset = 0
    hoffset = 0
    for i in range(8):
        vbit = (fmt >> i) & 1
        hbit = (fmt >> (14 - i)) & 1
        if i == 6:
            voffset += 1
            hoffset = 1
        matrix[i + voffset][8] = vbit
        matrix[8][i + hoffset] = hbit
        matrix[8][size - 1 - i] = vbit
        matrix[size - 1 - i][8] = hbit
    matrix[size - 8][8] = 1            # 固定深色模块


def _version_cells(size):
    """版本信息（版本 >= 7）的 36 格坐标，返回 [(row, col, bit)]（bit0 为最低位）。

    依据 ISO/IEC 18004 Figure 27，并用 segno 的 v7/v8/v9/v10 逐格反推确认：
      左下块（rows size-11..size-9，cols 0..5）：
          第 n 格 = (size-11 + n % 3, n // 3)，放第 n 位（n = 0 是最高位）
      右上块（rows 0..5，cols size-11..size-9）：
          第 n 格 = (n // 3, size-11 + n % 3)，同样放第 n 位
    两块内容相同，只是摆放方向相对角点对称。
    """
    cells = []
    for kind in ("BL", "TR"):
        for i in range(18):                  # i = 块内第 i 格，对应 bit (17 - i)
            n = 17 - i
            if kind == "BL":
                r, c = size - 11 + n % 3, n // 3
            else:
                r, c = n // 3, size - 11 + n % 3
            cells.append((r, c, n))
    return cells

def _draw_version(matrix, version):
    if version < 7:
        return
    size = len(matrix)
    bits = version_bits(version)
    for r, c, bit in _version_cells(size):
        matrix[r][c] = (bits >> bit) & 1


def _penalty(matrix):
    """ISO/IEC 18004 掩码评价：N1=3 N2=3 N3=40 N4=10。"""
    size = len(matrix)
    score = 0
    # N1：行/列同色连续
    for lines in (matrix, [[matrix[r][c] for r in range(size)] for c in range(size)]):
        for line in lines:
            run = 1
            for i in range(1, size):
                if line[i] == line[i - 1]:
                    run += 1
                else:
                    if run >= 5:
                        score += 3 + (run - 5)
                    run = 1
            if run >= 5:
                score += 3 + (run - 5)
    # N2：2x2 同色块
    for r in range(size - 1):
        for c in range(size - 1):
            v = matrix[r][c]
            if v == matrix[r][c + 1] == matrix[r + 1][c] == matrix[r + 1][c + 1]:
                score += 3
    # N3：1:1:3:1:1 图形 + 4 空白
    pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
    pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
    for r in range(size):
        for c in range(size - 10):
            seg = [matrix[r][c + i] for i in range(11)]
            if seg == pat1 or seg == pat2:
                score += 40
            seg = [matrix[c + i][r] for i in range(11)]
            if seg == pat1 or seg == pat2:
                score += 40
    # N4：深色比例
    dark = sum(1 for row in matrix for v in row if v)
    percent = dark * 100.0 / (size * size)
    score += int(abs(percent - 50) / 5) * 10
    return score


def build_matrix(data, ec_level="M"):
    """生成 QR 矩阵（1 = 深色）。返回 (matrix, version)。"""
    if ec_level not in _EC_LEVEL_BITS:
        raise ValueError("不支持的纠错等级：" + str(ec_level))
    if isinstance(data, str):
        data = data.encode("utf-8")
    version = choose_version(len(data))
    codewords = interleave(encode_data(data, version), version)
    size = version * 4 + 17

    best = None
    for mask in range(8):
        matrix = _blank_matrix(size)
        _draw_function_patterns(matrix, version)
        res = _mark_reserved(matrix, version)
        _place_data(matrix, res, codewords, mask)
        _draw_format(matrix, ec_level, mask)
        _draw_version(matrix, version)
        score = _penalty(matrix)
        if best is None or score < best[0]:
            best = (score, matrix)
    return best[1], version


def _draw_function_patterns(matrix, version):
    """画定位/定时/对齐图形（必须在数据填入前画好，否则会被数据覆盖）。"""
    size = len(matrix)
    _finder(matrix, 0, 0)
    _finder(matrix, 0, size - 7)
    _finder(matrix, size - 7, 0)
    # 定时图形只在两条分隔符之间（含两端 8..size-9，共 size-16 格/条），
    # 画满整行会覆盖定位图形区域；size-9 必为偶数，天然以深色模块收尾。
    for i in range(8, size - 8):
        matrix[6][i] = 1 if i % 2 == 0 else 0
        matrix[i][6] = 1 if i % 2 == 0 else 0
    _alignment(matrix, version)


def to_image(data, ec_level="M", box=8, border=4):
    """生成二维码 PIL 图片（L 模式，黑 0 白 255）。"""
    matrix, version = build_matrix(data, ec_level)
    size = len(matrix)
    total = (size + border * 2) * box
    img = Image.new("L", (total, total), 255)
    px = img.load()
    for r in range(size):
        for c in range(size):
            if matrix[r][c]:
                x0 = (c + border) * box
                y0 = (r + border) * box
                for y in range(y0, y0 + box):
                    for x in range(x0, x0 + box):
                        px[x, y] = 0
    return img


