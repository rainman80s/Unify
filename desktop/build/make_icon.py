# Unify.js app icon: white ✳ on the app's purple gradient, in the macOS rounded-square grid.
# Regenerate: python3 desktop/build/make_icon.py desktop/build/icon.png   (needs Pillow: pip3 install pillow)import math, sys
from PIL import Image, ImageDraw, ImageFilter

SS = 4                      # supersample for smooth edges
N = 1024 * SS
out = sys.argv[1]

def lerp(a, b, t): return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
top, bottom = (0xa7, 0x99, 0xff), (0x5c, 0x4b, 0xd5)   # same gradient as the sidebar logo

# macOS Big Sur+ grid: 824px rounded square centred on 1024, corner radius ~185.
size, radius = 824 * SS, 185 * SS
x0 = y0 = (N - size) // 2

# Diagonal gradient (top-left light -> bottom-right deep), matching linear-gradient(135deg, ...)
# faster: build a 2-row gradient along the diagonal and rotate
g = Image.new('RGB', (512, 1))
for i in range(512): g.putpixel((i, 0), lerp(top, bottom, i / 511))
g = g.resize((size * 2, size * 2)).rotate(-45, resample=Image.BICUBIC)
c = g.size[0] // 2
grad = g.crop((c - size // 2, c - size // 2, c + size // 2, c + size // 2))

mask = Image.new('L', (size, size), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)

canvas = Image.new('RGBA', (N, N), (0, 0, 0, 0))
# soft drop shadow, like native icons
shadow = Image.new('L', (N, N), 0)
ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 12 * SS, x0 + size, y0 + size + 12 * SS), radius=radius, fill=90)
shadow = shadow.filter(ImageFilter.GaussianBlur(18 * SS))
canvas.paste((40, 30, 90, 255), (0, 0), shadow)
canvas.paste(grad, (x0, y0), mask)

# subtle top highlight for depth
hl = Image.new('L', (size, size), 0)
hd = ImageDraw.Draw(hl)
for i in range(size // 2):
    hd.line((0, i, size, i), fill=int(38 * (1 - i / (size / 2)) ** 2))
hl = Image.composite(hl, Image.new('L', (size, size), 0), mask)
canvas.paste((255, 255, 255, 255), (x0, y0), hl)

# ✳: eight rounded spokes
d = ImageDraw.Draw(canvas)
cx = cy = N / 2
L, w = 250 * SS, 74 * SS          # spoke length from centre, spoke width
for k in range(8):
    a = math.pi / 4 * k
    ex, ey = cx + L * math.cos(a), cy + L * math.sin(a)
    d.line((cx, cy, ex, ey), fill=(255, 255, 255, 255), width=int(w))
    r = w / 2
    d.ellipse((ex - r, ey - r, ex + r, ey + r), fill=(255, 255, 255, 255))
d.ellipse((cx - w * 0.75, cy - w * 0.75, cx + w * 0.75, cy + w * 0.75), fill=(255, 255, 255, 255))

canvas.resize((1024, 1024), Image.LANCZOS).save(out)
print('wrote', out)
