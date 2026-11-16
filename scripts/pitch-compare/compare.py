#!/usr/bin/env python3
"""Objective comparison of the Pitch Shifter engines with Rubber Band R3 reference renders (voice).

    python3 scripts/pitch-compare/compare.py <dir with *_original.m4a and the R3 renders> [--work /tmp/pitch-compare]

For each passage <name>_voz_original.m4a the reference renders <name>_voz_menos1st_RubberBand_R3[_formantes].m4a
(and calma_voz_menos1.5st_RubberBand_R3_formantes.m4a) are compared with our renders (scripts/pitch-compare/
render.ts) at the same shift. Metrics (mono, 48 kHz, voiced 10 ms frames):
  * pitch: median f0 ratio (YIN, de Cheveigné & Kawahara 2002) output/input in cents minus the requested shift;
  * formants: LPC spectral-envelope distance (order 18 on a 16 kHz copy, dB RMS over 200-5000 Hz, level-matched)
    to the INPUT's envelope (formants preserved = small; shifted formants move it);
  * artefacts: log-spectral distance (dB) to the R3 render with the same formant setting, after aligning by
    cross-correlation (±50 ms);
  * true peak (dBTP, 4× oversampled) of every render.
Needs ffmpeg, numpy, scipy and the repository's node_modules (tsx).
"""
import json, os, subprocess, sys
import numpy as np
from scipy.signal import butter, correlate, resample_poly, sosfiltfilt, stft
from scipy.linalg import solve_toeplitz

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def yin(x, fmin=60.0, fmax=500.0, hop=480, win=1920, thr=0.15):
    tmin, tmax = int(SR / fmax), int(SR / fmin)
    f0 = []
    for s in range(0, len(x) - win - tmax, hop):
        a = x[s:s + win + tmax]
        if np.sqrt(np.mean(a[:win] ** 2)) < 1e-3:
            f0.append(np.nan); continue
        sq = np.concatenate([[0], np.cumsum(a ** 2)])
        e0 = sq[win]
        et = sq[win:win + tmax + 1] - sq[:tmax + 1]
        d = e0 + et - 2 * np.correlate(a, a[:win], 'valid')[:tmax + 1]
        cmnd = d.copy(); cmnd[0] = 1
        cs = np.cumsum(d[1:]); cmnd[1:] = d[1:] * np.arange(1, tmax + 1) / np.maximum(cs, 1e-20)
        cand = np.where(cmnd[tmin:] < thr)[0]
        if len(cand) == 0:
            f0.append(np.nan); continue
        t = cand[0] + tmin
        while t + 1 <= tmax and cmnd[t + 1] < cmnd[t]: t += 1
        if 1 <= t < tmax:
            a0, b0, c0 = cmnd[t - 1], cmnd[t], cmnd[t + 1]
            den = a0 - 2 * b0 + c0
            t = t + (0.5 * (a0 - c0) / den if den != 0 else 0)
        f0.append(SR / t)
    return np.array(f0)


def lpc_env(frame, order=18, nfft=1024):
    w = frame * np.hanning(len(frame))
    r = np.correlate(w, w, 'full')[len(w) - 1:len(w) + order]
    if r[0] <= 0: return None
    r[0] *= 1 + 1e-9
    a = solve_toeplitz(r[:order], -r[1:order + 1])
    A = np.fft.rfft(np.concatenate([[1], a]), nfft)
    return -20 * np.log10(np.abs(A) + 1e-12)


def envelopes(x):
    y = resample_poly(x, 1, 3)  # 16 kHz
    hop, win = 160, 480
    out = []
    for s in range(0, len(y) - win, hop):
        f = y[s:s + win]
        if np.sqrt(np.mean(f ** 2)) < 3e-3: out.append(None); continue
        out.append(lpc_env(f))
    return out


def env_distance(ea, eb, voiced):
    freqs = np.fft.rfftfreq(1024, 1 / 16000)
    band = (freqs >= 200) & (freqs <= 5000)
    d = []
    for i in range(min(len(ea), len(eb), len(voiced))):
        if not voiced[i] or ea[i] is None or eb[i] is None: continue
        a, b = ea[i][band], eb[i][band]
        diff = (a - a.mean()) - (b - b.mean())
        d.append(np.sqrt(np.mean(diff ** 2)))
    return float(np.median(d)) if d else float('nan')


def align(ref, y, maxlag=24000):
    """Lag (samples) of y behind ref from their amplitude envelopes (pitch-independent), within ±0.5 s."""
    sos = butter(2, 40, fs=SR, output='sos')
    n = min(len(ref), len(y))
    ea = sosfiltfilt(sos, np.abs(ref[:n])); eb = sosfiltfilt(sos, np.abs(y[:n]))
    ea -= ea.mean(); eb -= eb.mean()
    c = correlate(eb, ea, mode='full', method='fft')
    mid = n - 1
    return int(np.argmax(c[mid - maxlag:mid + maxlag + 1])) - maxlag


def lsd(a, b, lo=60.0, hi=8000.0):
    """Log-spectral distance (dB) over lo-hi Hz (the AAC references are band-limited), global level matched."""
    n = min(len(a), len(b))
    f, _, A = stft(a[:n], SR, nperseg=2048, noverlap=1536)
    _, _, B = stft(b[:n], SR, nperseg=2048, noverlap=1536)
    band = (f >= lo) & (f <= hi)
    la = 10 * np.log10(np.abs(A[band]) ** 2 + 1e-10)
    lb = 10 * np.log10(np.abs(B[band]) ** 2 + 1e-10)
    frames = la.max(axis=0) > la.max() - 50
    la, lb = la[:, frames], lb[:, frames]
    lb = lb + (la.mean() - lb.mean())
    return float(np.mean(np.sqrt(np.mean((la - lb) ** 2, axis=0))))


def true_peak(x):
    return float(20 * np.log10(np.max(np.abs(resample_poly(x, 4, 1))) + 1e-12))


def main():
    src = sys.argv[1]
    work = sys.argv[sys.argv.index('--work') + 1] if '--work' in sys.argv else '/tmp/pitch-compare'
    os.makedirs(work, exist_ok=True)
    cases = []
    for name in ['calma', 'eses', 'grito']:
        cases.append((name, -1.0, f'{name}_voz_menos1st_RubberBand_R3.m4a', f'{name}_voz_menos1st_RubberBand_R3_formantes.m4a'))
    cases.append(('calma', -1.5, None, 'calma_voz_menos1.5st_RubberBand_R3_formantes.m4a'))
    engines = [('legacy', 'best'), ('signalsmith', 'best'), ('signalsmith', 'fast'), ('rubberband-r3', 'best'), ('rubberband-r3', 'fast')]
    rows = []
    for name, st, ref_plain, ref_form in cases:
        x = decode(os.path.join(src, f'{name}_voz_original.m4a'))
        inp = os.path.join(work, f'{name}.f32'); x.astype(np.float32).tofile(inp)
        outdir = os.path.join(work, f'{name}_{st}'); os.makedirs(outdir, exist_ok=True)
        cfgs = [f'{e}:{q}:{st}:{f}' for e, q in engines for f in ([0] if e == 'legacy' else [0, 1])]
        res = subprocess.run([os.path.join(ROOT, 'node_modules/.bin/tsx'), os.path.join(HERE, 'render.ts'), inp, outdir, str(SR), *cfgs],
                             check=True, capture_output=True, text=True, cwd=ROOT)
        cpu = {j['config']: j for j in map(json.loads, res.stdout.strip().splitlines())}
        f0x = yin(x); ex = envelopes(x)
        refs = {}
        for tag, path in (('R3', ref_plain), ('R3+formants', ref_form)):
            if path: refs[tag] = decode(os.path.join(src, path))
        editor = os.path.join(src, f'{name}_voz_menos1st_editor_PitchShifter.m4a')
        if st == -1.0 and os.path.exists(editor): refs['editor export (legacy)'] = decode(editor)
        outs = {f'{c}': np.fromfile(os.path.join(outdir, c.replace(':', '_') + '.f32'), dtype=np.float32).astype(np.float64) for c in cfgs}
        lags = {}
        for tag, y in list(refs.items()):
            lag = align(x, y)  # references vs input (amplitude envelopes)
            lags[tag] = lag
            y = np.concatenate([y[lag:], np.zeros(max(lag, 0))]) if lag >= 0 else np.concatenate([np.zeros(-lag), y[:lag]])
            refs[tag] = y
            outs[f'reference {tag}'] = y
        print(json.dumps({'passage': name, 'shift': st, 'referenceLagsSamples': lags}), flush=True)
        for label, y in outs.items():
            f0y = yin(y); n = min(len(f0x), len(f0y))
            ok = ~np.isnan(f0x[:n]) & ~np.isnan(f0y[:n])
            cents = 1200 * np.log2(f0y[:n][ok] / f0x[:n][ok]) - 100 * st
            voiced = np.zeros(len(ex), bool)
            vi = np.where(ok)[0]
            voiced[np.minimum(vi, len(ex) - 1)] = True
            ey = envelopes(y)
            form = label.endswith(':1') or label.endswith('formants')
            ref = refs.get('R3+formants' if form else 'R3')
            if label.startswith('reference'): ref = None
            row = {'passage': name, 'shift': st, 'render': label,
                   'pitchErrCentsMedian': round(float(np.median(cents)), 2) if len(cents) else None,
                   'pitchErrCentsIQR': round(float(np.subtract(*np.percentile(cents, [75, 25]))), 2) if len(cents) else None,
                   'envDistToInputDb': round(env_distance(ex, ey, voiced), 2),
                   'lsdToR3Db': round(lsd(ref, y), 2) if ref is not None else None,
                   'lsdToR3FormantsDb': round(lsd(refs['R3+formants'], y), 2) if 'R3+formants' in refs and label != 'reference R3+formants' else None,
                   'truePeakDbtp': round(true_peak(y), 2),
                   'realtimeFactor': round(cpu[label]['realtimeFactor'], 1) if label in cpu else None}
            rows.append(row)
            print(json.dumps(row), flush=True)
    print('input true peak dBTP:', {n: round(true_peak(decode(os.path.join(src, f'{n}_voz_original.m4a'))), 2) for n in ['calma', 'eses', 'grito']})


if __name__ == '__main__':
    main()
