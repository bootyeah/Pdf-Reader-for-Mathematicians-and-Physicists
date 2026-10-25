"""Generate a small CJK / math / native-link PDF for renderer compatibility checks."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

target = Path(__file__).parent / 'fixtures' / 'cjk.pdf'
target.parent.mkdir(exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
c = canvas.Canvas(str(target), pagesize=(595, 842))
for page in range(1, 4):
    c.bookmarkPage(f'page{page}')
    c.addOutlineEntry(f'Chapter {page}', f'page{page}', level=0)
    c.setFont('STSong-Light', 22)
    c.drawString(45, 770, '中文阅读测试：高等数学与物理')
    c.setFont('STSong-Light', 16)
    c.drawString(45, 725, '积分 ∫ x dx = x² / 2 + C')
    c.drawString(45, 690, '希腊字母：α β γ；标点：，。！？')
    c.drawString(45, 640, f'第 {page} 页：文字选择与链接定位')
    if page == 1:
        c.setFillColorRGB(.1, .3, .8)
        c.drawString(45, 590, '点击跳转到第二页')
        c.linkRect('', 'page2', (45, 584, 200, 609), relative=0, thickness=0)
    c.showPage()
c.save()
print(target)
