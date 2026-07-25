# -*- coding: utf-8 -*-
"""Визуальная сверка графического вывода с эталонным изображением.

Рендерит выгруженные примитивы (JSON) в PNG, режет нужную область эталона, клеит side-by-side
и делает пиксельную классификацию по цвету-смыслу.

Использование:
  py -3 compare.py <dump.json> <etalon.png> <x0,y0,x1,y1|auto> <out.png> [заголовок]
                   [--exclude=Слой1,Слой2] [--legend=blue:контур,green:ось]

  <dump.json>   - примитивы проекта: {"width":W,"height":H,"primitives":[...]}
  <etalon.png>  - эталонное изображение
  <x0,y0,x1,y1> - прямоугольник области на эталоне в пикселях, либо auto
  <out.png>     - куда сохранить склейку (каталог должен быть в .gitignore)

Формат примитива (координаты уже экранные, без дополнительного флипа):
  {"t":"Line|Arc|Polygon|Rectangle|Ellipse|EllipseArc|Point|Text",
   "coordinates":[[x,y],...], "strokeColor":"blue|#0000ff|rgb(0,0,255)",
   "strokeWidth":1, "fillColor":..., "layer":"ИмяСлоя", "content":"текст"}
  Arc задаётся тремя точками [начало, середина, конец]. Отсутствие strokeColor = обводки нет.

Зависимости: Pillow.
"""
import sys, math, json, re
from PIL import Image, ImageDraw, ImageFont

COLORS = {"black": "#000", "white": "#fff", "red": "#ff0000", "blue": "#0000ff", "green": "#008000",
          "maroon": "#800000", "teal": "#008080", "gray": "#808080", "grey": "#808080",
          "lime": "#00ff00", "skyblue": "#87ceeb"}


def col(c, d="#000000"):
    """Цвет примитива -> hex. Принимает имя, #hex и rgb(r,g,b)."""
    if not c:
        return d
    c = str(c).strip()
    if c.startswith("#"):
        return c
    m = re.match(r'rgb\((\d+),\s*(\d+),\s*(\d+)\)', c)
    if m:
        return '#%02x%02x%02x' % (int(m[1]), int(m[2]), int(m[3]))
    return COLORS.get(c.lower(), d)


def arc_pts(p0, pm, p1, n=28):
    """Дуга по трём точкам -> ломаная. Центр и радиус из описанной окружности."""
    (x0, y0), (xm, ym), (x1, y1) = p0, pm, p1
    a = 2 * (x0 * (ym - y1) + xm * (y1 - y0) + x1 * (y0 - ym))
    if abs(a) < 1e-9:
        return [p0, pm, p1]                      # три точки на прямой
    ux = ((x0**2 + y0**2) * (ym - y1) + (xm**2 + ym**2) * (y1 - y0) + (x1**2 + y1**2) * (y0 - ym)) / a
    uy = ((x0**2 + y0**2) * (x1 - xm) + (xm**2 + ym**2) * (x0 - x1) + (x1**2 + y1**2) * (xm - x0)) / a
    r = math.hypot(x0 - ux, y0 - uy)
    a0 = math.atan2(y0 - uy, x0 - ux)
    am = math.atan2(ym - uy, xm - ux)
    a1 = math.atan2(y1 - uy, x1 - ux)

    def nrm(s, e):
        while e < s:
            e += 2 * math.pi
        return e

    e = nrm(a0, a1)
    m = nrm(a0, am)
    if not (a0 <= m <= e):                       # середина не внутри - идём в другую сторону
        a0, a1 = a1, a0
        e = nrm(a0, a1)
    return [(ux + r * math.cos(a0 + (e - a0) * i / n), uy + r * math.sin(a0 + (e - a0) * i / n))
            for i in range(n + 1)]


def render(js, exclude=()):
    """Примитивы -> изображение. Белая заливка без обводки трактуется как затирание."""
    W, H = int(round(js["width"])), int(round(js["height"]))
    img = Image.new("RGB", (W + 2, H + 2), "#ffffff")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 12)
    except Exception:
        font = ImageFont.load_default()
    for p in js["primitives"]:
        if p.get("layer") in exclude:
            continue
        t = p["t"]
        sc = col(p.get("strokeColor"))
        w = int(max(1, float(p.get("strokeWidth") or 1)))
        has_stroke = p.get("strokeColor") is not None
        if t == "Polygon":
            pts = [(c[0], c[1]) for c in p["coordinates"]]
            fc = p.get("fillColor")
            if fc and str(fc).lower() not in ("white", "#ffffff") and len(pts) >= 3:
                d.polygon(pts, fill=col(fc, sc))
                for h in p.get("holes", []):                  # отверстия: пробиваем фоном
                    hp = [(c[0], c[1]) for c in h]
                    if len(hp) >= 3:
                        d.polygon(hp, fill=(255, 255, 255))
                if has_stroke:
                    d.line(pts + [pts[0]], fill=sc, width=w)
            elif has_stroke:
                d.line(pts + [pts[0]] if len(pts) >= 3 else pts, fill=sc, width=w)
            elif len(pts) >= 3:
                d.polygon(pts, fill=(255, 255, 255))
        elif t == "Line":
            d.line([(c[0], c[1]) for c in p["coordinates"]], fill=sc, width=w)
        elif t == "Arc":
            c = p["coordinates"]
            d.line(arc_pts(tuple(c[0]), tuple(c[1]), tuple(c[2])), fill=sc, width=w)
        elif t == "Point":
            c = p["coordinates"][0]
            r = float(p.get("radius", 3) or 3)
            d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=col(p.get("fillColor"), sc))
        elif t == "Rectangle":
            c = p["coordinates"]
            box = [min(c[0][0], c[1][0]), min(c[0][1], c[1][1]),
                   max(c[0][0], c[1][0]), max(c[0][1], c[1][1])]
            fc = p.get("fillColor")
            if fc and str(fc).lower() not in ("white", "#ffffff"):
                d.rectangle(box, fill=col(fc, sc), outline=(sc if has_stroke else None))
            elif has_stroke:
                d.rectangle(box, outline=sc, width=w)
            else:
                d.rectangle(box, fill=(255, 255, 255))
        elif t == "Ellipse":
            c = p.get("center") or p["coordinates"]
            a = float(p["size"][0])
            b = float(p["size"][1])
            d.ellipse([c[0] - a, c[1] - b, c[0] + a, c[1] + b], outline=sc, width=w)
        elif t == "EllipseArc":
            c = p["center"]
            a = float(p["a"])
            b = float(p["b"])
            s = float(p.get("angleFirst", 0))
            e = float(p.get("angleSecond", 360))
            if e < s:
                s, e = e, s
            d.arc([c[0] - a, c[1] - b, c[0] + a, c[1] + b], s, e, fill=sc, width=w)
        elif t == "Text":
            c = p["coordinates"][0]
            d.text((c[0], c[1]), str(p.get("content", "")),
                   fill=col(p.get("fillColor"), "#800000"), font=font, anchor="mm")
    return img


def classify(r, g, b):
    """Грубая классификация пикселя по смысловому цвету."""
    if r > 180 and g < 90 and b < 90:
        return "red"
    if 110 < r < 190 and g < 70 and b < 70:
        return "maroon"
    if g > 110 and r < 110 and b < 110:
        return "green"
    if b > 150 and r < 110 and g < 110:
        return "blue"
    if r < 70 and g < 70 and b < 70:
        return "black"
    return None


def stats(im, name):
    im = im.convert("RGB")
    W, H = im.size
    px = im.load()
    acc = {}
    for y in range(H):
        for x in range(W):
            c = classify(*px[x, y])
            if c:
                acc[c] = acc.get(c, 0) + 1
    print(f"== {name} ({W}x{H}) ==")
    for c in ("blue", "green", "red", "maroon", "black"):
        print(f"  {c:7} n={acc.get(c, 0)}")
    return acc


def auto_box(im):
    """Фиксированные доли листа: главная фигура слева-сверху, вспомогательные виды справа и снизу.
    Устойчиво к форме фигуры; нестандартная компоновка - задавать бокс вручную."""
    W, H = im.size
    return (int(W * 0.015), int(H * 0.045), int(W * 0.76), int(H * 0.73))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 4:
        print(__doc__)
        return 2
    exclude, legend = set(), {}
    for a in sys.argv[1:]:
        if a.startswith("--exclude="):
            exclude = {s.strip() for s in a.split("=", 1)[1].split(",") if s.strip()}
        elif a.startswith("--legend="):
            for pair in a.split("=", 1)[1].split(","):
                if ":" in pair:
                    k, v = pair.split(":", 1)
                    legend[k.strip()] = v.strip()

    dump_json, etalon_png, box_s, out = args[0:4]
    title = args[4] if len(args) > 4 else ""
    if exclude:
        print("исключены слои:", ",".join(sorted(exclude)))

    with open(dump_json, encoding="utf-8") as f:
        ours = render(json.load(f), exclude)
    et_full = Image.open(etalon_png).convert("RGB")
    if box_s == "auto":
        box = auto_box(et_full)
        print("авто-бокс:", box)
    else:
        box = tuple(int(v) for v in box_s.split(","))
    et = et_full.crop(box)

    height = 700
    fit = lambda im: im.resize((int(im.size[0] * height / im.size[1]), height))
    et2, ours2 = fit(et), fit(ours)
    pad = 20
    cv = Image.new("RGB", (et2.size[0] + ours2.size[0] + pad * 3, height + 44), "#ffffff")
    d = ImageDraw.Draw(cv)
    cv.paste(et2, (pad, 34))
    cv.paste(ours2, (pad * 2 + et2.size[0], 34))
    d.text((pad, 10), "ЭТАЛОН" + ((" - " + title) if title else ""), fill="#000")
    d.text((pad * 2 + et2.size[0], 10), "НАШ РЕНДЕР", fill="#000")
    cv.save(out)
    print("сохранено", out, cv.size)

    ae, am = stats(et, "ЭТАЛОН"), stats(ours, "НАШ РЕНДЕР")
    print("== наличие признаков ==")
    for c in ("blue", "green", "red", "black"):
        e, m = ae.get(c, 0) >= 5, am.get(c, 0) >= 5
        label = legend.get(c, c)
        print(f"  {label:20} эталон={'да' if e else 'нет'} наш={'да' if m else 'нет'} "
              f"{'OK' if e == m else 'РАСХОЖДЕНИЕ'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
