#!/usr/bin/env python3
"""Generate a 1024x1024 macOS-style app icon for Termrack."""
import os
from PIL import Image, ImageDraw, ImageFont

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# macOS icons sit on a rounded square with a little padding.
pad = 86
box = [pad, pad, S - pad, S - pad]
radius = 200

# Vertical gradient background (dark blue-black -> slightly lighter).
top = (24, 26, 38)
bot = (13, 13, 15)
grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
h = box[3] - box[1]
for i in range(h):
    t = i / h
    r = int(top[0] * (1 - t) + bot[0] * t)
    g = int(top[1] * (1 - t) + bot[1] * t)
    b = int(top[2] * (1 - t) + bot[2] * t)
    gd.line([(box[0], box[1] + i), (box[2], box[1] + i)], fill=(r, g, b, 255))

# Rounded-rect mask.
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

# Subtle top highlight stroke.
d.rounded_rectangle(box, radius=radius, outline=(70, 80, 110, 110), width=4)

# A terminal title bar with three traffic lights.
bar_h = 120
bar = [box[0], box[1], box[2], box[1] + bar_h]
barmask = Image.new("L", (S, S), 0)
ImageDraw.Draw(barmask).rounded_rectangle(box, radius=radius, fill=255)
overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
od.rectangle([box[0], box[1] + bar_h - 40, box[2], box[1] + bar_h], fill=(255, 255, 255, 8))
img = Image.alpha_composite(img, overlay)
d = ImageDraw.Draw(img)

cy = box[1] + bar_h // 2
for i, col in enumerate([(255, 95, 87), (245, 196, 81), (62, 207, 107)]):
    cx = box[0] + 80 + i * 70
    d.ellipse([cx - 24, cy - 24, cx + 24, cy + 24], fill=col)

# The ">_" prompt, the heart of the icon, in the accent blue.
accent = (79, 140, 255)
# chevron ">"
ox, oy = box[0] + 150, box[1] + 360
lw = 46
d.line([(ox, oy), (ox + 150, oy + 120)], fill=accent, width=lw, joint="curve")
d.line([(ox, oy + 240), (ox + 150, oy + 120)], fill=accent, width=lw, joint="curve")
# underscore cursor "_"
uy = oy + 240
d.rounded_rectangle([ox + 220, uy - 30, ox + 470, uy + 16], radius=22, fill=accent)

out = os.path.join(os.path.dirname(__file__), "icon_1024.png")
img.save(out)
print("wrote", out)
