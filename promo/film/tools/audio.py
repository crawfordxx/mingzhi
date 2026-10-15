"""发布片音频：代码作曲的 53 秒 8-bit 芯片曲（方波 / 三角波 / 噪声，120 BPM，镜头分界都落在拍点上）
+ 两条音效轨（自合成 8-bit 游戏音效、现代 UI 音效）。输出三条分轨 wav，混音与响度在 tools/mix.sh 里做。
全部确定性（固定种子），版权自有。

用法：python3 -I tools/audio.py   → build/audio/{bgm,sfx8,sfxui}.wav
"""
import subprocess
import wave
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parents[1]
OUT = HERE / 'build' / 'audio'
OUT.mkdir(parents=True, exist_ok=True)
SR = 48000
DUR = 53.0
N = int(SR * DUR)
BEAT = 0.5  # 120 BPM
FPS = 30
rng = np.random.default_rng(2026)


def fr(f):  # 帧号 → 秒
    return f / FPS


def note_hz(name):
    names = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
    n, o = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[n] + 12 * (o + 1) - 69) / 12)


def pulse(freq, dur, duty=0.25, vib=0.0):
    t = np.arange(int(SR * dur)) / SR
    ph = (freq * t + (vib * np.sin(2 * np.pi * 5.5 * t) * t)) % 1.0
    return np.where(ph < duty, 1.0, -1.0)


def tri(freq, dur):
    t = np.arange(int(SR * dur)) / SR
    ph = (freq * t) % 1.0
    return 4 * np.abs(ph - 0.5) - 1


def noise(dur, seed=0, period=1):
    r = np.random.default_rng(seed)
    n = int(SR * dur)
    x = r.choice([-1.0, 1.0], size=n // period + 1).repeat(period)[:n]
    return x


def env(n, a=0.004, d=0.08, s=0.6, r=0.05, hold=None):
    t = np.arange(n) / SR
    tot = n / SR
    hold = tot - r if hold is None else hold
    e = np.where(t < a, t / max(a, 1e-6), 1.0)
    e = np.where(t >= a, s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6)), e)
    e = np.where(t > hold, e * np.clip(1 - (t - hold) / max(r, 1e-6), 0, 1), e)
    return e


def put(buf, x, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(x))
    buf[i:j] += x[: j - i] * gain


def lp_fast(x, cutoff):
    """一阶低通的向量化近似：FFT 滤波（整轨用）"""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    H = 1 / np.sqrt(1 + (f / cutoff) ** 2)
    return np.fft.irfft(X * H, len(x))


# ───────────────────────── 作曲 ─────────────────────────
CH = {  # 和弦（根音 + 和弦音），C 大调
    'C': ['C', 'E', 'G'], 'Am': ['A', 'C', 'E'], 'F': ['F', 'A', 'C'], 'G': ['G', 'B', 'D'], 'Em': ['E', 'G', 'B'], 'Dm': ['D', 'F', 'A'],
}
# 每小节 2 秒（4 拍）。段落：intro 0–3 / A 3–16.5 / B 16.5–25 / 呼吸 25–27.5 / A' 27.5–39 / 高潮 39–44.5 / 结算 44.5–48 / 尾 48–53
def section(t):
    for name, a, b in [('intro', 0, 3), ('A', 3, 16.5), ('B', 16.5, 25), ('breath', 25, 27.5), ('A2', 27.5, 39), ('climax', 39, 44.5), ('result', 44.5, 48), ('end', 48, 53)]:
        if a <= t < b:
            return name
    return 'end'


PROG_A = ['C', 'Am', 'F', 'G']
PROG_B = ['F', 'G', 'Em', 'Am']
PROG_C = ['C', 'G', 'Am', 'F']
MEL_A = {'C': ['E5', 'G5', 'C6', 'G5', 'E5', 'D5', 'C5', None], 'Am': ['E5', 'A5', 'C6', 'A5', 'G5', 'E5', 'D5', None],
         'F': ['F5', 'A5', 'C6', 'A5', 'G5', 'F5', 'E5', None], 'G': ['D5', 'G5', 'B5', 'D6', 'C6', 'B5', 'G5', None]}
MEL_B = {'F': ['A5', 'C6', 'F6', 'C6', 'A5', 'C6', 'F6', None], 'G': ['B5', 'D6', 'G6', 'D6', 'B5', 'D6', 'G6', None],
         'Em': ['G5', 'B5', 'E6', 'B5', 'G5', 'B5', 'E6', None], 'Am': ['A5', 'C6', 'E6', 'C6', 'A5', 'G5', 'E5', None]}
MEL_C = {'C': ['C6', 'E6', 'G6', 'E6', 'C6', 'D6', 'E6', None], 'G': ['D6', 'G6', 'B6', 'G6', 'D6', 'B5', 'G5', None],
         'Am': ['C6', 'E6', 'A6', 'E6', 'C6', 'B5', 'A5', None], 'F': ['A5', 'C6', 'F6', 'C6', 'A5', 'G5', 'F5', None]}

lead = np.zeros(N); arp = np.zeros(N); bass = np.zeros(N); drums = np.zeros(N); pad = np.zeros(N)
nb = int(DUR / BEAT)
for bar in range(int(DUR / 2) + 1):
    t0 = bar * 2.0
    sec = section(t0 + 0.01)
    if sec in ('intro',):
        ch = 'C'
    elif sec in ('B',):
        ch = PROG_B[bar % 4]
    elif sec in ('climax', 'result'):
        ch = PROG_C[bar % 4]
    elif sec == 'end':
        ch = 'C'
    else:
        ch = PROG_A[bar % 4]
    root = CH[ch][0]
    # 低音：三角波八分音符（呼吸段只铺长音）
    for k in range(8):
        t = t0 + k * 0.25
        s = section(t + 0.01)
        if s in ('breath', 'end') and k % 4:
            continue
        o = '2' if k % 2 == 0 else '3'
        d = 0.24 if s not in ('breath', 'end') else 1.0
        if s == 'intro' and t < 1.5:
            continue
        x = tri(note_hz(root + o), d) * env(int(SR * d), d=0.12, s=0.7, r=0.03)
        put(bass, x, t, 0.55 if s != 'breath' else 0.35)
    # 琶音：12.5% 方波十六分音符
    tones = CH[ch]
    for k in range(16):
        t = t0 + k * 0.125
        s = section(t + 0.01)
        if s in ('breath',) or (s == 'end' and t > 49):
            continue
        nm = tones[k % 3] + ('5' if k % 6 < 3 else '4')
        x = pulse(note_hz(nm), 0.11, duty=0.125) * env(int(SR * 0.11), d=0.05, s=0.25, r=0.02)
        g = 0.10 if s in ('intro',) else 0.13
        put(arp, x, t, g)
    # 旋律
    mel = MEL_B if sec == 'B' else MEL_C if sec in ('climax',) else MEL_A
    if sec in ('A', 'B', 'A2', 'climax') and ch in mel:
        for k, nm in enumerate(mel[ch]):
            if nm is None:
                continue
            t = t0 + k * 0.25
            s = section(t + 0.01)
            if s not in ('A', 'B', 'A2', 'climax'):
                continue
            d = 0.22 if k < 7 else 0.45
            g = 0.16 if s != 'A2' else 0.11
            x = pulse(note_hz(nm), d, duty=0.25, vib=0.004) * env(int(SR * d), d=0.10, s=0.55, r=0.04)
            put(lead, x, t, g)
            if s == 'climax':  # 高潮加三度和声
                h = pulse(note_hz(nm) * 2 ** (-4 / 12), d, duty=0.5) * env(int(SR * d), d=0.10, s=0.5, r=0.04)
                put(lead, h, t, 0.06)
    # 呼吸段与片尾的长和弦垫底
    if sec in ('breath', 'end', 'intro'):
        for nm in tones:
            d = 2.0
            x = tri(note_hz(nm + '4'), d) * env(int(SR * d), a=0.2, d=1.0, s=0.8, r=0.4)
            put(pad, x, t0, 0.07)

# 鼓：噪声小鼓、方波下滑底鼓、短噪声镲
def kick():
    d = 0.16
    t = np.arange(int(SR * d)) / SR
    f = 140 * np.exp(-t * 28) + 45
    ph = np.cumsum(f) / SR
    return np.sign(np.sin(2 * np.pi * ph)) * np.exp(-t * 18)

def snare(seed):
    d = 0.14
    return noise(d, seed, period=2) * env(int(SR * d), a=0.001, d=0.04, s=0.0, r=0.01)

def hat(seed):
    d = 0.04
    return noise(d, seed, period=1) * env(int(SR * d), a=0.001, d=0.012, s=0.0, r=0.005)

for b in range(nb):
    t = b * BEAT
    s = section(t + 0.01)
    if s in ('intro', 'breath') or t >= 48.0:
        continue
    half = s == 'A2'
    if b % 4 in (0, 2) and not (half and b % 4 == 2):
        put(drums, kick(), t, 0.42)
    if b % 4 in (1, 3) and not (half and b % 4 == 1):
        put(drums, snare(b), t, 0.20)
    for e in (0, 0.25):
        put(drums, hat(b * 7 + int(e * 4)), t + e, 0.06 if s not in ('climax',) else 0.09)
    if s == 'climax' and b % 2:
        put(drums, hat(b * 13), t + 0.375, 0.06)

# 简单回声（只给旋律）：0.375s 延迟，反馈 0.3
echo = np.zeros(N)
d = int(0.375 * SR)
echo[d:] += lead[:-d] * 0.28
echo[2 * d:] += lead[:-2 * d] * 0.08
bgm = lead + echo + arp + bass + drums + pad
# 段落动态：呼吸段整体压低、进影院（39s）打开
tt = np.arange(N) / SR
g = np.ones(N)
g = np.where((tt >= 25) & (tt < 27.5), 0.55, g)
g = np.where((tt >= 27.5) & (tt < 39), 0.85, g)
g = np.where((tt >= 44.5) & (tt < 48), 0.8, g)
g *= np.clip(tt / 0.3, 0, 1)                      # 0.3s 淡入
g *= np.clip((53.0 - tt) / 1.5, 0, 1)             # 1.5s 淡出
bgm = lp_fast(bgm * g, 6500)


# ───────────────────────── 8-bit 音效（自合成） ─────────────────────────
def sweep(f0, f1, d, duty=0.5, curve=1.0, decay=6.0):
    t = np.arange(int(SR * d)) / SR
    f = f0 + (f1 - f0) * (t / d) ** curve
    ph = np.cumsum(f) / SR
    return np.where(ph % 1 < duty, 1.0, -1.0) * np.exp(-t * decay)

def arp_notes(names, step=0.06, d=0.12, duty=0.25):
    out = np.zeros(int(SR * (step * len(names) + d)))
    for i, nm in enumerate(names):
        x = pulse(note_hz(nm), d, duty) * env(int(SR * d), d=0.06, s=0.3, r=0.02)
        put(out, x, i * step)
    return out

S8 = {
    'bitcrush1': sweep(880, 660, 0.12, 0.5, decay=14), 'bitcrush2': sweep(660, 494, 0.12, 0.5, decay=14), 'bitcrush3': sweep(494, 392, 0.14, 0.5, decay=12),
    'thud': sweep(180, 60, 0.18, 0.5, decay=16) + noise(0.18, 3, 4) * np.exp(-np.arange(int(SR * 0.18)) / SR * 30) * 0.4,
    'jump': sweep(220, 700, 0.16, 0.25, curve=0.6, decay=5),
    'stomp': noise(0.16, 5, 3) * np.exp(-np.arange(int(SR * 0.16)) / SR * 22) + sweep(400, 90, 0.16, 0.5, decay=12) * 0.6,
    'bump': arp_notes(['C6', 'G6'], step=0.05, d=0.1),
    'arp_up': arp_notes(['C5', 'E5', 'G5', 'C6', 'E6'], step=0.045, d=0.14, duty=0.125),
    'flag': arp_notes(['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7'], step=0.07, d=0.2),
    'scan': sweep(1400, 500, 1.0, 0.125, decay=0.6) * 0.7,
    'glide': sweep(900, 300, 0.5, 0.25, decay=2.5),
    'rise': sweep(200, 900, 0.4, 0.5, curve=1.4, decay=1.5) * 0.7,
    'swell': sweep(110, 440, 1.4, 0.5, curve=2.0, decay=0.3) * 0.5,
}
fan = np.zeros(int(SR * 1.8))
for i, (nm, st, d) in enumerate([('G5', 0, .12), ('C6', .12, .12), ('E6', .24, .12), ('G6', .36, .3), ('E6', .7, .12), ('G6', .82, .9)]):
    put(fan, pulse(note_hz(nm), d, 0.25) * env(int(SR * d), d=0.2, s=0.7, r=0.05), st, 0.8)
    put(fan, pulse(note_hz(nm) / 2, d, 0.5) * env(int(SR * d), d=0.2, s=0.6, r=0.05), st, 0.35)
S8['fanfare'] = fan
PENTA = ['C6', 'D6', 'E6', 'G6', 'A6']
coins = [arp_notes([n1, n2], step=0.07, d=0.18) for n1, n2 in [('B5', 'E6'), ('C6', 'F6'), ('D6', 'G6'), ('E6', 'A6'), ('G6', 'C7')]]

sfx8 = np.zeros(N)
def c8(name, f, gain_db=-6):
    put(sfx8, S8[name], fr(f), 10 ** (gain_db / 20))

c8('bitcrush1', 12, -9); c8('bitcrush2', 27, -9); c8('bitcrush3', 42, -9)
c8('thud', 108, -4)
r = np.random.default_rng(7)
for f in range(200, 332, 15):  # 转录翻牌：每 4 块一声五声音阶
    put(sfx8, pulse(note_hz(PENTA[r.integers(0, 5)]), 0.05, 0.125) * env(int(SR * 0.05), d=0.02, s=0.2, r=0.01), fr(f), 10 ** (-17 / 20))
c8('jump', 344, -6); c8('stomp', 370, -3); c8('jump', 374, -12); c8('thud', 390, -10)
c8('stomp', 412, -3); c8('jump', 416, -12); c8('glide', 426, -11); c8('thud', 432, -10)
c8('jump', 484, -12)
c8('rise', 497, -10); c8('arp_up', 562, -9); c8('jump', 578, -6)
c8('thud', 645, -6); c8('bump', 658, -5); c8('bump', 686, -5); c8('jump', 652, -12); c8('jump', 680, -12)
c8('scan', 1000, -12)
c8('thud', 1080, -8); c8('rise', 1080, -12); c8('flag', 1090, -4); c8('jump', 1100, -13); c8('jump', 1121, -13)
c8('swell', 1182, -10)
c8('fanfare', 1245, -2)
for i, f in enumerate([1346, 1352, 1358, 1364, 1385]):
    put(sfx8, coins[i], fr(f), 10 ** (-8 / 20))


# ───────────────────────── 现代 UI 音效（素材库） ─────────────────────────
def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    return x / (np.max(np.abs(x)) + 1e-9)

HS = HERE / 'sfx' / 'huashu'; KN = HERE / 'sfx' / 'kenney'
LIB = {p.stem: load(p) for p in list(HS.glob('*.mp3')) + list(KN.glob('*.wav'))}
sfxui = np.zeros(N)
def cu(name, f, gain_db=-6, maxdur=None):
    x = LIB[name]
    if maxdur:
        n = int(maxdur * SR)
        x = x[:n] * np.clip((n - np.arange(min(n, len(x)))) / (0.02 * SR), 0, 1)
    put(sfxui, x, fr(f), 10 ** (gain_db / 20))

cu('transition_slide-in', 78, -12)
cu('tick_002', 108, -12)
for f in (206, 215, 224, 233): cu('tick_002', f, -16)
cu('click_002', 370, -8); cu('ui_click-soft', 376, -12); cu('toggle_002', 392, -8)
cu('ui_click-soft', 418, -12); cu('toggle_002', 444, -7); cu('container_card-snap', 448, -8)
cu('progress_loading-tick', 472, -12, 0.25); cu('progress_loading-tick', 478, -12, 0.25); cu('progress_complete-done', 484, -6)
cu('transition_whoosh-fast', 485, -8)
for f in (509, 522, 535): cu('scroll_002', f, -12)
cu('toggle_002', 548, -7)
cu('magic_transform', 596, -6)
cu('transition_slide-in', 612, -14); cu('transition_slide-in', 638, -14)
cu('transition_slide-in', 660, -14); cu('container_card-snap', 678, -8)
cu('transition_slide-in', 688, -14); cu('container_card-snap', 706, -8)
cu('magic_sparkle', 738, -14)
cu('glass_001', 752, -8)
cu('container_modal-open', 826, -14)
cu('ui_click', 863, -3)
# 打字：与画面逐字符同帧（预写脚本见 Act3.tsx）
typing = []
f = 876
for _ in '@00:14': typing.append(f); f += 3
f += 3
for _ in '这张卡太弱了了': typing.append(f); f += 3
for tf in typing: cu('keyboard_type', tf, -13, 0.09)
cu('keyboard_delete-key', f + 5 - 3 + 2, -10, 0.15)
cu('keyboard_enter', 932, -5)
cu('transition_whoosh-fast', 938, -14)
cu('container_stack-collapse', 962, -14)
cu('magic_ai-process', 975, -14, 0.8)
cu('progress_complete-done', 1030, -6)
cu('transition_slide-in', 1045, -12)
cu('feedback_notification-pop', 1084, -12)
cu('container_card-flip', 1094, -8)
cu('transition_dissolve', 1150, -12)
cu('impact_logo-reveal-v2', 1245, -8)
cu('transition_dissolve', 1318, -12)
cu('feedback_success-chime', 1400, -5)
cu('transition_whoosh-fast', 1422, -8)
cu('impact_logo-reveal-v2', 1444, -3)


def write(name, x):
    x = np.clip(x, -1, 1)
    with wave.open(str(OUT / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())

def norm(x, peak_db):
    return x / (np.max(np.abs(x)) + 1e-9) * 10 ** (peak_db / 20)

write('bgm', norm(bgm, -7))
write('sfx8', norm(sfx8, -1.5))
write('sfxui', norm(sfxui, -1.5))
print('ok', OUT)
