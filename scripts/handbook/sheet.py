# python3 scripts/handbook/sheet.py docs/images/site /tmp/sheets — contact
# sheets of the finished pictures, six per page, for a quick look.
import sys, os, glob, math
from PIL import Image, ImageDraw, ImageFont
files = sorted(glob.glob(sys.argv[1] + '/*.png')); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
F = ImageFont.truetype('/usr/share/fonts/noto/NotoSans-Bold.ttf', 22)
per, cw, ch = 6, 640, 520
for k in range(0, len(files), per):
    batch = files[k:k + per]
    sheet = Image.new('RGB', (3 * cw, 2 * (ch + 40)), (225, 225, 225)); d = ImageDraw.Draw(sheet)
    for j, f in enumerate(batch):
        im = Image.open(f).convert('RGB'); im.thumbnail((cw - 20, ch - 10))
        x, y = (j % 3) * cw + 10, (j // 3) * (ch + 40) + 34
        sheet.paste(im, (x, y)); d.text((x, y - 30), f'{os.path.basename(f)} {Image.open(f).size[0]}x{Image.open(f).size[1]}', font=F, fill=(20, 20, 20))
    sheet.save(f'{out}/sheet-{k // per + 1}.png')
print('sheets', math.ceil(len(files) / per))
