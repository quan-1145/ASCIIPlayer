"""测量截图里字符的排列周期，用来核对「画布内容」和「状态栏声明」是否一致。

用法: python tools/measure-pitch.py <img.png> <x0> <y0> <x1> <y1>
"""
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])

im = Image.open(path).convert('L')
strip = np.asarray(im.crop((x0, y0, x1, y1)), dtype=np.float64)
prof = strip.max(axis=0)
prof = prof - prof.mean()

ac = np.correlate(prof, prof, mode="full")[len(prof) - 1:]
ac = ac / ac[0]
lag = int(np.argmax(ac[3:60]) + 3)
span = x1 - x0
print(f"{path}")
print(f"  取样区 {span}x{y1-y0}px · 字符排列周期 ≈ {lag}px → 该区域约 {span/lag:.1f} 个字符位")
print(f"  自相关峰值 {ac[lag]:.3f}")
