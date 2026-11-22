#!/usr/bin/env python3
"""
make-app-icon: draw the VibeVerse favicon and home-screen icons at every size
index.html and the manifest reference.

The mark is the pixel V tile Jack picked on 2026-11-21: Arcade sky blue, a
chunky white pixel V, a navy drop shadow from 64 px up. Strokes are two cells
wide because one-cell diagonals fall apart at 16 px. Small sizes snap to whole
pixels; the maskable icon keeps the V inside the safe circle.

Usage: python3 scripts/make-app-icon.py [preview.png]
"""
from PIL import Image, ImageDraw
import sys
B=(21,133,245);W=(255,255,255);N=(11,21,38)
PV=["110000011","110000011","110000011","011000110","011000110","001101100","000111000","000010000"]
def icon(n, mode):
    ss=4 if n>=64 else 1
    S=n*ss
    im=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    if mode=="tile": d.rounded_rectangle([0,0,S-1,S-1],radius=round(S*0.22),fill=B)
    else: d.rectangle([0,0,S,S],fill=B)
    frac={"tile":0.62,"full":0.56,"mask":0.42}[mode]
    cell=max(1,int(n*frac/9))*ss if n<64 else S*frac/9
    w=cell*9; h=cell*8; ox=(S-w)/2; oy=(S-h)/2+cell*0.1
    def draw(dx,dy,col):
        for j,r in enumerate(PV):
            for i,c in enumerate(r):
                if c=="1": d.rectangle([ox+i*cell+dx,oy+j*cell+dy,ox+(i+1)*cell+dx-1,oy+(j+1)*cell+dy-1],fill=col)
    if n>=64: draw(cell*0.3,cell*0.3,N)
    draw(0,0,W)
    if ss>1: im=im.resize((n,n),Image.NEAREST if False else Image.LANCZOS)
    return im if mode=="tile" else im.convert("RGB")
out="public/"
icon(64,"tile").save(out+"favicon.png")
ico=[icon(s,"tile") for s in (16,32,48)]
ico[2].save(out+"favicon.ico",sizes=[(16,16),(32,32),(48,48)],append_images=ico[:2])
icon(192,"tile").save(out+"app-icon-192.png")
icon(512,"tile").save(out+"app-icon-512.png")
icon(1024,"full").save(out+"app-icon.png")
icon(512,"mask").save(out+"app-icon-maskable.png")
for name,s in [("apple-touch-icon",180),("apple-touch-icon-precomposed",180),("apple-touch-icon-152",152),("apple-touch-icon-167",167)]:
    icon(s,"full").save(out+name+".png")
# preview strip
strip=Image.new("RGB",(900,300),(238,244,255))
x=20
for s,m in [(16,"tile"),(32,"tile"),(48,"tile"),(64,"tile"),(180,"full"),(256,"mask")]:
    im=icon(s,m); strip.paste(im,(x,150-s//2),im if im.mode=="RGBA" else None); x+=s+30
if len(sys.argv) > 1: strip.save(sys.argv[1])
