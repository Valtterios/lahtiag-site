# python3 scripts/handbook/post.py scripts/handbook/jobs.json
# Crop, highlight, resize and compress screenshots into docs/images.
# A job: {src, rects (json from shoot.mjs, optional), clip: selector-rect|[x0,y0,x1,y1]|null,
#         pad, top (limit height in CSS px from the clip's top), hl: [{i: index into rects.hl | box:[x0,y0,x1,y1], n: label}],
#         width, out, format, photo}
import json, sys, os
from PIL import Image, ImageDraw, ImageFont
BLUE = (65, 105, 225); YELLOW = (255, 222, 89); WHITE = (255, 255, 255)
FONT = '/usr/share/fonts/noto/NotoSans-Bold.ttf'

def run(job):
    im = Image.open(job['src']).convert('RGB')
    scale = job.get('scale', 2 if job.get('rects') else 1)
    rects = json.load(open(job['rects'])) if job.get('rects') else None
    pad = job.get('pad', 12) * scale
    clip = job.get('clip')
    if clip == 'auto' and (not rects or not rects.get('clip')):
        print('  clip element missing, using the whole page', file=sys.stderr); clip = None
    if isinstance(clip, str) or clip is None and rects and rects.get('clip'):
        r = rects['clip']
        box = [r['x'] * scale - pad, r['y'] * scale - pad, (r['x'] + r['w']) * scale + pad, (r['y'] + r['h']) * scale + pad]
    elif isinstance(clip, list):
        box = [v * scale for v in clip]
    else:
        box = [0, 0, im.width, im.height]
    if job.get('skip'):
        box[1] += job['skip'] * scale
    if job.get('extend'):
        box[3] += job['extend'] * scale
    if job.get('top'):
        box[3] = min(box[3], box[1] + job['top'] * scale)
    if job.get('height'):
        box[3] = box[1] + job['height'] * scale
    box = [max(0, int(box[0])), max(0, int(box[1])), min(im.width, int(box[2])), min(im.height, int(box[3]))]
    im = im.crop(box)
    d = ImageDraw.Draw(im)
    for h in job.get('hl', []):
        if 'box' in h:
            x0, y0, x1, y1 = [v * scale for v in h['box']]
        else:
            r = rects['hl'][h['i']]
            if not r:
                print('  missing highlight', h, file=sys.stderr); continue
            g = h.get('grow', 6) * scale
            x0, y0, x1, y1 = r['x'] * scale - g, r['y'] * scale - g, (r['x'] + r['w']) * scale + g, (r['y'] + r['h']) * scale + g
        x0 -= box[0]; x1 -= box[0]; y0 -= box[1]; y1 -= box[1]
        d.rounded_rectangle((x0, y0, x1, y1), radius=8 * scale, outline=YELLOW, width=5 * scale)
        d.rounded_rectangle((x0 + 1.5 * scale, y0 + 1.5 * scale, x1 - 1.5 * scale, y1 - 1.5 * scale), radius=7 * scale, outline=BLUE, width=2 * scale)
        if h.get('n') is not None:
            rr = 13 * scale
            cx, cy = x0 - 2 * scale, y0 - 2 * scale
            d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=BLUE, outline=WHITE, width=int(1.5 * scale))
            f = ImageFont.truetype(FONT, int(15 * scale))
            d.text((cx, cy), str(h['n']), font=f, fill=WHITE, anchor='mm')
    width = job.get('width', 1200)
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out = job['out']
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fmt = job.get('format', 'png')
    if fmt == 'jpg':
        im.save(out, 'JPEG', quality=84, optimize=True, progressive=True)
    elif job.get('photo'):
        im.save(out, 'PNG', optimize=True)
    else:
        im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(out, 'PNG', optimize=True)
    print(f'{out} {im.width}x{im.height} {os.path.getsize(out)//1024} KB')

for job in json.load(open(sys.argv[1])):
    run(job)
