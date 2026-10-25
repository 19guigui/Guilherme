#!/usr/bin/env python3
"""
Pipeline de camadas do personagem Jarvis (2.5D) — modelo de corpo inteiro.

Lê a imagem de referência oficial (reference/jarvis-reference.png, 1024x1536,
fundo branco) e produz em assets/ as camadas independentes usadas pelo
renderizador (src/jarvis-character.js), além de assets/rig.json com posições,
pivôs e polígonos de recorte.

Camadas geradas:
  shadow                sombra do chão (estática)
  head                  cabeça + pescoço (pescoço estendido por baixo do colarinho)
  browL, browR          sobrancelhas (testa reconstruída atrás delas)
  irisL, irisR          íris (esclera reconstruída atrás delas)
  lidL, lidR            pálpebras fechadas (pele reconstruída sobre o olho)
  jaw                   lábio inferior + queixo (interior da boca pintado atrás)
  torso                 paletó, camisa, gravata, calça e sapatos (reconstruído atrás dos braços)
  armRUpper, armRFore   braço direito do personagem (esquerda do observador): braço e antebraço+mão
  armLUpper, armLFore   braço esquerdo do personagem (direita do observador): braço e antebraço+mão
  watch                 relógio (pulso esquerdo do personagem; pulso reconstruído atrás)

Uso:  python3 tools/build_layers.py [--debug]
Requer: opencv-python-headless, numpy, Pillow
"""
import json, os, sys, time
import cv2, numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'reference', 'jarvis-reference.png')
OUT = os.path.join(ROOT, 'assets')
DEBUG = '--debug' in sys.argv
DBG_DIR = os.path.join(ROOT, 'tools', 'debug')
os.makedirs(OUT, exist_ok=True)
if DEBUG:
    os.makedirs(DBG_DIR, exist_ok=True)

img = cv2.imread(SRC)  # BGR
H, W = img.shape[:2]
assert (W, H) == (1024, 1536), 'a imagem de referência deve ter 1024x1536'

# ----------------------------------------------------------------- helpers
def P(*pts):
    return np.array(pts, np.int32)

def poly_mask(pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [P(*pts)], 255)
    return m

def disc_mask(c, r):
    m = np.zeros((H, W), np.uint8)
    cv2.circle(m, (int(c[0]), int(c[1])), int(r), 255, -1)
    return m

def kernel(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))

def dilate(m, r):
    return cv2.dilate(m, kernel(r)) if r > 0 else m.copy()

def erode(m, r):
    return cv2.erode(m, kernel(r)) if r > 0 else m.copy()

def feather(m, sigma):
    f = m.astype(np.float32) / 255.0
    if sigma > 0:
        f = cv2.GaussianBlur(f, (0, 0), sigma)
    return np.clip(f, 0, 1)

def bbox_of(mask, margin=2):
    ys, xs = np.where(mask > 0)
    x0, x1 = max(0, xs.min() - margin), min(W, xs.max() + margin + 1)
    y0, y1 = max(0, ys.min() - margin), min(H, ys.max() + margin + 1)
    return x0, y0, x1, y1

def inpaint(src, mask, radius=4, scale=1.0):
    """Preenche os pixels de `mask` usando apenas os pixels não mascarados.
    scale<1 faz o inpaint em resolução reduzida (regiões grandes)."""
    if scale >= 1.0:
        return cv2.inpaint(src, mask, radius, cv2.INPAINT_TELEA)
    small = cv2.resize(src, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    ms = cv2.resize(mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    ms = dilate(ms, 1)
    filled = cv2.inpaint(small, ms, radius, cv2.INPAINT_TELEA)
    up = cv2.resize(filled, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_CUBIC)
    out = src.copy()
    out[mask > 0] = up[mask > 0]
    return out

def inpaint_region(full, hidden, sources, radius=5, scale=0.5, margin=10):
    """Reconstrói `hidden` usando só pixels de `sources` (trabalha no bbox)."""
    x0, y0, x1, y1 = bbox_of(hidden, margin)
    crop = full[y0:y1, x0:x1].copy()
    m = cv2.bitwise_or(hidden, cv2.bitwise_not(sources))[y0:y1, x0:x1]
    crop = inpaint(crop, m, radius=radius, scale=scale)
    out = full.copy()
    hid = hidden[y0:y1, x0:x1] > 0
    out[y0:y1, x0:x1][hid] = crop[hid]
    return out

def export(name, rgb_bgr, alpha, bbox=None, quality=92, lossless=False):
    """Exporta a camada recortada (WebP com alpha) e devolve o descritor."""
    if bbox is None:
        bbox = bbox_of((alpha > 0.002).astype(np.uint8) * 255, 2)
    x0, y0, x1, y1 = bbox
    crop = rgb_bgr[y0:y1, x0:x1]
    a = (np.clip(alpha[y0:y1, x0:x1], 0, 1) * 255).astype(np.uint8)
    rgba = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(np.dstack([rgba, a]), 'RGBA')
    fn = f'{name}.webp'
    pil.save(os.path.join(OUT, fn), 'WEBP', quality=quality, lossless=lossless, method=6)
    if DEBUG:
        pil.save(os.path.join(DBG_DIR, f'{name}.png'))
    return {'file': fn, 'x': int(x0), 'y': int(y0), 'w': int(x1 - x0), 'h': int(y1 - y0)}

t0 = time.time()
def log(msg):
    print(f'[{time.time() - t0:5.1f}s] {msg}')

# ------------------------------------------------- 1. silhueta (fundo branco)
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 1]
nonwhite = ((gray < 236) | (sat > 18)).astype(np.uint8) * 255
nonwhite[1380:, :] = ((gray[1380:, :] < 200) | (sat[1380:, :] > 25)).astype(np.uint8) * 255  # ignora a sombra do chão
person = cv2.morphologyEx(nonwhite, cv2.MORPH_CLOSE, kernel(2))
# fecha buracos pequenos (punhos/camisa brancos cercados pelo personagem)
inv = cv2.bitwise_not(person)
n, lab, stats, cent = cv2.connectedComponentsWithStats(inv)
for i in range(1, n):
    hole = lab == i
    # buracos pequenos e não totalmente brancos são tecido claro (camisa/punho);
    # frestas de fundo puro (branco) entre manga e tronco ficam de fora
    frac_white, s_mean, cy = (gray[hole] >= 250).mean(), sat[hole].mean(), cent[i][1]
    # frestas entre manga/mão e tronco (abaixo do peito) são fundo; colarinho/camisa (acima) são tecido
    is_bg = (frac_white > 0.65 and s_mean < 1.5) or (cy > 500 and frac_white > 0.45 and s_mean < 4)
    if stats[i, cv2.CC_STAT_AREA] < 4000 and not is_bg:
        person[hole] = 255
n, lab, stats, _ = cv2.connectedComponentsWithStats(person)
big = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
person = np.where(lab == big, 255, 0).astype(np.uint8)
person = cv2.morphologyEx(person, cv2.MORPH_OPEN, kernel(1))
# punhos brancos encostados no fundo: garante que fazem parte da silhueta
for cuff in ([(256, 758), (304, 758), (306, 784), (254, 784)], [(676, 742), (734, 742), (736, 772), (676, 772)]):
    person = cv2.bitwise_or(person, cv2.bitwise_and(poly_mask(cuff), (gray < 253).astype(np.uint8) * 255))
log('silhueta ok')

# ------------------------------------------------- 2. regiões (coordenadas da imagem 1024x1536)
HEAD_POLY = [(370,0),(620,0),(620,236),(560,236),(535,262),(520,285),(505,300),(490,314),(472,300),(455,285),
             (440,268),(425,236),(370,236)]
HEAD_PIVOT = (490, 282)

EYE_L = {  # olho à esquerda do observador (direito do personagem)
    'upper': [(443,162),(448,158),(454,156),(460,155),(466,155),(471,157),(476,160),(479,163)],
    'lower': [(479,163),(474,166),(467,168),(459,168),(451,166),(446,164),(443,162)],
    'iris': (460, 162), 'r': 7,
}
EYE_R = {
    'upper': [(503,163),(506,158),(511,153),(517,150),(523,150),(529,152),(534,155),(538,159)],
    'lower': [(538,159),(534,163),(527,166),(518,166),(510,165),(505,164),(503,163)],
    'iris': (519, 158), 'r': 7,
}
BROW_L = [(430,151),(440,146),(455,143),(470,142),(485,143),(492,147),(490,152),(478,152),(462,151),(448,153),(436,156)]
BROW_R = [(494,150),(500,143),(510,139),(522,138),(534,141),(542,146),(542,152),(532,149),(520,146),(508,147),(498,152)]
BROW_PIV = {'browL': (462, 148), 'browR': (519, 145)}
MOUTH_SEAM = [(471,222),(478,221),(486,220),(494,220),(502,219),(510,218),(517,216),(522,215)]
MOUTH_DEPTH = 6
JAW_POLY = [(468,220)] + MOUTH_SEAM + [(526,214),(531,222),(531,236),(525,250),(508,258),(490,260),(472,258),
            (458,250),(453,236),(455,222)]
JAW_FADE = (240, 258)

# braço direito do personagem (esquerda do observador)
ARM_R_POLY = [(316,314),(352,338),(350,370),(342,420),(330,470),(316,520),(304,580),(302,650),(302,720),(303,780),
              (332,800),(338,850),(332,900),(316,936),(280,936),(244,905),(236,860),(240,800),(243,760),(240,700),
              (240,640),(246,580),(258,500),(280,420),(297,360)]
ARM_R = {'shoulder': (332, 346), 'elbow': (279, 592), 'elbowR': 26, 'dir': 1}
# braço esquerdo do personagem (direita do observador, com relógio)
ARM_L_POLY = [(664,322),(706,330),(732,376),(752,438),(762,500),(766,560),(762,620),(758,680),(752,740),(748,775),
              (736,800),(734,860),(722,930),(690,944),(655,940),(642,900),(638,850),(646,800),(660,770),(676,740),
              (678,680),(674,620),(672,560),(670,500),(666,440),(660,380),(658,340)]
ARM_L = {'shoulder': (686, 346), 'elbow': (713, 602), 'elbowR': 26, 'dir': -1}
WATCH_POLY = [(662,770),(680,761),(705,759),(725,761),(739,769),(743,790),(739,808),(725,815),(705,813),(690,810),
              (675,799),(662,790)]
TORSO_PIVOT = (490, 900)

def eye_opening(e):
    return poly_mask(e['upper'] + e['lower'][1:-1])

# ------------------------------------------------- 3. máscaras
head_region = poly_mask(HEAD_POLY)
head_bin = cv2.bitwise_and(person, head_region)
armR_bin = cv2.bitwise_and(person, poly_mask(ARM_R_POLY))
armL_bin = cv2.bitwise_and(person, poly_mask(ARM_L_POLY))
watch_bin = cv2.bitwise_and(person, poly_mask(WATCH_POLY))
body_bin = cv2.bitwise_and(person, cv2.bitwise_not(cv2.bitwise_or(head_region, cv2.bitwise_or(armR_bin, armL_bin))))
browL_bin, browR_bin = poly_mask(BROW_L), poly_mask(BROW_R)
jaw_bin = poly_mask(JAW_POLY)
eyeL_open, eyeR_open = eye_opening(EYE_L), eye_opening(EYE_R)

def split_arm(arm_bin, cfg):
    """Divide o braço no cotovelo com sobreposição circular (articulação sem fresta)."""
    ex, ey = cfg['elbow']
    disc = cv2.bitwise_and(disc_mask((ex, ey), cfg['elbowR']), arm_bin)
    yy = np.arange(H)[:, None]
    upper = cv2.bitwise_and(arm_bin, (yy < ey).astype(np.uint8) * 255 * np.ones((1, W), np.uint8))
    fore = cv2.bitwise_and(arm_bin, (yy >= ey).astype(np.uint8) * 255 * np.ones((1, W), np.uint8))
    return cv2.bitwise_or(upper, disc), cv2.bitwise_or(fore, disc)

armR_up, armR_fore = split_arm(armR_bin, ARM_R)
armL_up, armL_fore = split_arm(armL_bin, ARM_L)

if DEBUG:
    vis = img.copy()
    for m, col in [(head_bin,(0,255,0)),(body_bin,(255,0,0)),(armR_up,(0,0,255)),(armR_fore,(0,128,255)),
                   (armL_up,(0,255,255)),(armL_fore,(0,200,120)),(watch_bin,(255,0,255)),
                   (browL_bin,(255,255,0)),(browR_bin,(255,255,0)),(jaw_bin,(0,128,255)),
                   (eyeL_open,(255,128,0)),(eyeR_open,(255,128,0))]:
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(vis, cnts, -1, col, 1)
    for c in (ARM_R['shoulder'], ARM_R['elbow'], ARM_L['shoulder'], ARM_L['elbow'], HEAD_PIVOT):
        cv2.circle(vis, c, 4, (0, 0, 255), -1)
    cv2.imwrite(os.path.join(DBG_DIR, 'regions.png'), vis)
    cv2.imwrite(os.path.join(DBG_DIR, 'regions_face.png'), cv2.resize(vis[120:270,420:560], None, fx=6, fy=6, interpolation=cv2.INTER_NEAREST))
    cv2.imwrite(os.path.join(DBG_DIR, 'regions_arms.png'), cv2.resize(vis[300:950,220:780], None, fx=1.5, fy=1.5, interpolation=cv2.INTER_NEAREST))

rig = {'width': W, 'height': H, 'unit': 0.43, 'layers': {}, 'pivots': {}, 'geometry': {}}

# ------------------------------------------------- 4. sombra do chão (estática)
shadow_src = np.zeros((H, W), np.uint8)
shadow_src[1380:, :] = 255
shadow_src = cv2.bitwise_and(shadow_src, cv2.bitwise_not(dilate(person, 2)))
shadow_alpha = np.clip((252 - gray.astype(np.float32)) / 60.0, 0, 1) * (shadow_src > 0)
shadow_alpha = cv2.GaussianBlur(shadow_alpha, (0, 0), 2.0)
shadow_rgb = np.full_like(img, 40)
rig['layers']['shadow'] = export('shadow', shadow_rgb, shadow_alpha)
log('sombra ok')

# ------------------------------------------------- 5. cabeça + pescoço
head_ext = cv2.bitwise_or(head_bin, cv2.bitwise_and(dilate(head_bin, 14), body_bin))
hx0, hy0, hx1, hy1 = bbox_of(head_ext, 6)
head_crop = img[hy0:hy1, hx0:hx1].copy()
head_crop = inpaint(head_crop, cv2.bitwise_not(head_bin)[hy0:hy1, hx0:hx1], radius=5, scale=0.5)

def hc(m):
    return m[hy0:hy1, hx0:hx1]

# fonte "só pele" do rosto (sem olhos, cílios e sobrancelhas) para reconstruções
brow_hidden = dilate(cv2.bitwise_or(browL_bin, browR_bin), 3)
lash = np.zeros((H, W), np.uint8)
for e in (EYE_L, EYE_R):
    cv2.polylines(lash, [P(*e['upper'])], False, 255, 3)
skin_only_mask = cv2.bitwise_or(cv2.bitwise_or(brow_hidden, dilate(cv2.bitwise_or(eyeL_open, eyeR_open), 3)), lash)
fx0, fy0, fx1, fy1 = bbox_of(skin_only_mask, 30)
skin_fill = inpaint(img[fy0:fy1, fx0:fx1].copy(), skin_only_mask[fy0:fy1, fx0:fx1], radius=6)
skin_fill = cv2.GaussianBlur(skin_fill, (0, 0), 1.2)
face_skin = img.copy(); face_skin[fy0:fy1, fx0:fx1] = skin_fill

# testa atrás das sobrancelhas
soft = feather(hc(brow_hidden), 1.0)[..., None]
head_crop = (head_crop * (1 - soft) + face_skin[hy0:hy1, hx0:hx1] * soft).astype(np.uint8)

# esclera atrás das íris
for e, opening in [(EYE_L, eyeL_open), (EYE_R, eyeR_open)]:
    cx, cy = e['iris']; r = e['r']
    fill = cv2.bitwise_and(disc_mask((cx, cy), r + 1), opening)
    scl = cv2.bitwise_and(opening, cv2.bitwise_not(dilate(fill, 2)))
    samples = img[scl > 0].astype(np.float32)
    lum = samples.mean(axis=1)
    base = samples[lum > np.percentile(lum, 50)].mean(axis=0)
    ys, xs = np.where(fill > 0)
    col = opening[:, cx].nonzero()[0]; top, bot = col.min(), col.max()
    for y, x in zip(ys, xs):
        t = (y - top) / max(1, bot - top)
        shade = 0.74 + 0.26 * min(1.0, t * 2.5)
        head_crop[y - hy0, x - hx0] = np.clip(base * shade, 0, 255)
    edge = np.clip(feather(hc(dilate(fill, 1)), 0.8) - feather(hc(erode(fill, 1)), 0.8), 0, 1)[..., None]
    blur = cv2.GaussianBlur(head_crop, (0, 0), 0.8)
    head_crop = (head_crop * (1 - edge) + blur * edge).astype(np.uint8)

# interior da boca pintado atrás da mandíbula (visível quando a boca abre)
seam = np.array(MOUTH_SEAM, np.float32)
sx0, sx1 = seam[0, 0] + 3, seam[-1, 0] - 3
lens_top, lens_bot = [], []
for i in range(41):
    u = i / 40
    x = sx0 + (sx1 - sx0) * u
    y = float(np.interp(x, seam[:, 0], seam[:, 1]))
    d = MOUTH_DEPTH * (max(0.0, float(np.sin(np.pi * u))) ** 0.55)
    lens_top.append((x, y - 0.5)); lens_bot.append((x, y + d))
lens = np.array(lens_top + lens_bot[::-1], np.float32)
lens_m = np.zeros(head_crop.shape[:2], np.uint8)
cv2.fillPoly(lens_m, [np.round(lens - [hx0, hy0]).astype(np.int32)], 255)
mouth_layer = head_crop.copy().astype(np.float32)
ys, xs = np.where(lens_m > 0)
teeth = np.array([138, 158, 176], np.float32)
dark = np.array([30, 24, 58], np.float32)
for y, x in zip(ys, xs):
    X, Y = x + hx0, y + hy0
    dpt = Y - float(np.interp(X, seam[:, 0], seam[:, 1]))
    u = (X - sx0) / (sx1 - sx0)
    side = max(0.0, float(np.sin(np.pi * min(1, max(0, u)))))
    tooth_h = 0.8 + 1.4 * side
    if dpt < tooth_h:
        c = teeth * (0.75 + 0.25 * side)
    else:
        c = dark * (1 - min(0.45, (dpt - tooth_h) / 10))
    mouth_layer[y, x] = c
mouth_layer = cv2.GaussianBlur(mouth_layer, (0, 0), 0.6)
soft = feather(lens_m, 0.6)[..., None]
head_crop = np.clip(head_crop * (1 - soft) + mouth_layer * soft, 0, 255).astype(np.uint8)

head_full = img.copy(); head_full[hy0:hy1, hx0:hx1] = head_crop
rig['layers']['head'] = export('head', head_full, feather(head_ext, 0.8), (hx0, hy0, hx1, hy1))
rig['pivots']['head'] = HEAD_PIVOT
log('cabeça ok')

# ------------------------------------------------- 6. sobrancelhas, íris, pálpebras, mandíbula
for name, m in [('browL', browL_bin), ('browR', browR_bin)]:
    rig['layers'][name] = export(name, img, feather(dilate(m, 2), 1.3), lossless=True)
    rig['pivots'][name] = BROW_PIV[name]

for name, e, opening in [('irisL', EYE_L, eyeL_open), ('irisR', EYE_R, eyeR_open)]:
    m = cv2.bitwise_and(disc_mask(e['iris'], e['r']), opening)
    rig['layers'][name] = export(name, img, feather(m, 0.6), lossless=True)

for name, opening in [('lidL', eyeL_open), ('lidR', eyeR_open)]:
    rig['layers'][name] = export(name, face_skin, feather(dilate(opening, 3), 1.0), lossless=True)

ja = feather(jaw_bin, 1.0)
yy = np.arange(H)[:, None].astype(np.float32)
ja = ja * np.clip((JAW_FADE[1] - yy) / (JAW_FADE[1] - JAW_FADE[0]), 0, 1)
seam_full = np.interp(np.arange(W), seam[:, 0], seam[:, 1])
ja[np.arange(H)[:, None] < seam_full[None, :] - 0.5] = 0
rig['layers']['jaw'] = export('jaw', img, ja, lossless=True)
log('rosto ok')

# ------------------------------------------------- 7. tronco (reconstruído atrás dos braços)
# O tronco continua (opaco) por baixo da faixa interna dos braços: assim a borda
# esfumada do braço compõe sobre tecido reconstruído, e não sobre o fundo da página.
arms_bin = cv2.bitwise_or(armR_bin, armL_bin)
under_arms = cv2.bitwise_and(dilate(body_bin, 12), arms_bin)
torso_bin = cv2.bitwise_or(body_bin, under_arms)
hidden = cv2.bitwise_or(under_arms, cv2.bitwise_and(dilate(arms_bin, 8), body_bin))  # inclui a franja de pele/manga
torso_full = inpaint_region(img, hidden, body_bin, radius=5, scale=0.5)
bx0, by0, bx1, by1 = bbox_of(torso_bin, 4)
rig['layers']['torso'] = export('torso', torso_full, feather(torso_bin, 1.0), (bx0, by0, bx1, by1), quality=90)
rig['pivots']['torso'] = TORSO_PIVOT
rig['pivots']['feet'] = (490, 1440)
log('tronco ok')

# ------------------------------------------------- 8. braços, mãos e relógio
# antebraço esquerdo: pulso/punho reconstruídos atrás do relógio
armL_src = inpaint_region(img, dilate(watch_bin, 2), armL_fore, radius=5, scale=1.0)
for name, m, src in [('armRUpper', armR_up, img), ('armRFore', armR_fore, img),
                     ('armLUpper', armL_up, img), ('armLFore', armL_fore, armL_src)]:
    rig['layers'][name] = export(name, src, feather(m, 0.8), quality=90)
rig['layers']['watch'] = export('watch', img, feather(watch_bin, 0.7), lossless=True)
rig['pivots']['armR'] = ARM_R
rig['pivots']['armL'] = ARM_L
log('braços ok')

# ------------------------------------------------- 9. geometria para o renderizador
rig['geometry'] = {
    'eyeL': {'upper': EYE_L['upper'], 'lower': EYE_L['lower'], 'iris': EYE_L['iris'], 'r': EYE_L['r']},
    'eyeR': {'upper': EYE_R['upper'], 'lower': EYE_R['lower'], 'iris': EYE_R['iris'], 'r': EYE_R['r']},
    'mouthSeam': MOUTH_SEAM, 'mouthDepth': MOUTH_DEPTH,
}
rig['framings'] = {'full': [60, 0, 904, 1536], 'bust': [300, 20, 380, 380], 'face': [405, 95, 170, 170]}
rig['order'] = ['shadow', 'head', 'browL', 'browR', 'irisL', 'irisR', 'lidL', 'lidR', 'jaw', 'torso',
                'armRUpper', 'armRFore', 'armLUpper', 'armLFore', 'watch']
with open(os.path.join(OUT, 'rig.json'), 'w') as f:
    json.dump(rig, f, indent=1)
total = sum(os.path.getsize(os.path.join(OUT, l['file'])) for l in rig['layers'].values())
log(f'rig.json ok — {len(rig["layers"])} camadas, {total/1024:.0f} KB')
