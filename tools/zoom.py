"""放大截图的局部，用于人工核对字符渲染细节。

用法: python tools/zoom.py <src.png> <dst.png> <x> <y> <w> <h> <scale>
"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
x, y, w, h, scale = (int(v) for v in sys.argv[3:8])
im = Image.open(src).convert('RGB')
crop = im.crop((x, y, x + w, y + h))
crop.resize((w * scale, h * scale), Image.NEAREST).save(dst)
print(f"saved {dst} ({w*scale}x{h*scale})")
