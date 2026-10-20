/** In-place iterative radix-2 complex FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Linear convolution via FFT. Output length is x.length + h.length - 1. */
export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  const outLen = x.length + h.length - 1;
  let n = 1;
  while (n < outLen) n <<= 1;
  const xr = new Float64Array(n), xi = new Float64Array(n);
  const hr = new Float64Array(n), hi = new Float64Array(n);
  xr.set(x);
  hr.set(h);
  fft(xr, xi);
  fft(hr, hi);
  for (let i = 0; i < n; i++) {
    const r = xr[i] * hr[i] - xi[i] * hi[i];
    xi[i] = xr[i] * hi[i] + xi[i] * hr[i];
    xr[i] = r;
  }
  fft(xr, xi, true);
  return Float32Array.from(xr.subarray(0, outLen));
}
