import json
from pathlib import Path
import sys

job = Path(sys.argv[1])
model_home = Path(sys.argv[2])
sys.path[:0] = [str(model_home / 'deps'), str(model_home / 'int8')]

import numpy as np
import onnxruntime
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from pipeline import ProPainter


def limit_threads():
    options = session_options()
    options.intra_op_num_threads = 4
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
    return options


session_options = onnxruntime.SessionOptions
onnxruntime.SessionOptions = limit_threads
config = json.loads((job / 'mask.json').read_text(encoding='utf-8'))
box = config['box']
tracking = config.get('tracking', [])
sources = sorted((job / 'input').glob('*.png'))
destination = job / 'output'
destination.mkdir()
model = ProPainter(model_home / 'int8')


def mask_box(index, width, height):
    center_x, center_y = box['x'] + box['w']/2, box['y'] + box['h']/2
    if tracking:
        times, positions_x, positions_y = zip(*tracking)
        center_x = np.interp(index, times, positions_x)
        center_y = np.interp(index, times, positions_y)
    x = round((center_x - box['w']/2) * width)
    y = round((center_y - box['h']/2) * height)
    return (max(0, x), max(0, y), min(width, x + round(box['w']*width)),
            min(height, y + round(box['h']*height)))


def remove_batch(first, last, keep_from, keep_to, bounds):
    width, height = bounds
    masks = [mask_box(index, width, height) for index in range(first,last)]
    padding = round(min(bounds)*.075)
    crop = (max(0, min(x for x,_,_,_ in masks)-padding),
            max(0, min(y for _,y,_,_ in masks)-padding),
            min(width, max(x for _,_,x,_ in masks)+padding),
            min(height, max(y for _,_,_,y in masks)+padding))
    cw, ch = crop[2]-crop[0], crop[3]-crop[1]
    factor = 224 / max(cw,ch)
    iw, ih = [max(64, round(dim*factor/8)*8) for dim in (cw,ch)]
    small_sources, small_masks = [], []
    for path, mask in zip(sources[first:last], masks):
        with Image.open(path) as image:
            small_sources.append(image.convert('RGB').crop(crop).resize((iw,ih), Image.Resampling.LANCZOS))
        bitmap = Image.new('L',(cw,ch))
        ImageDraw.Draw(bitmap).rectangle(tuple(value - crop[i % 2] for i,value in enumerate(mask)),fill=255)
        small_masks.append(bitmap.resize((iw,ih),Image.Resampling.NEAREST))
    replacements = model(small_sources,small_masks)
    for index in range(keep_from,keep_to):
        offset = index-first
        affected = ndimage.binary_dilation(np.asarray(small_masks[offset]),iterations=4)
        matte = Image.fromarray(affected.astype(np.uint8)*255).resize((cw,ch),Image.Resampling.BILINEAR)
        matte = matte.filter(ImageFilter.GaussianBlur(max(1, cw / iw)))
        patch = Image.fromarray(replacements[offset]).resize((cw,ch),Image.Resampling.LANCZOS)
        with Image.open(sources[index]) as image:
            result = image.convert('RGB')
        result.paste(patch,crop[:2],matte)
        result.save(destination / f'{index+1:05}.png')


if len(sources) < 2:
    raise SystemExit('Object removal requires two or more frames.')
with Image.open(sources[0]) as image:
    bounds = image.size
for start in range(0,len(sources),10):
    end = min(start+10,len(sources))
    remove_batch(max(0,start-2),min(len(sources),end+2),start,end,bounds)
    print(f'{end} / {len(sources)} frames',flush=True)
