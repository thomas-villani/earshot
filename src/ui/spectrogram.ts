// Scrolling waterfall of the mic input: time left-to-right, frequency bottom-to-top (0 to 24 kHz).
const BANDS: [number, number, string][] = [
  [1875, 6375, 'audible'],
  [15000, 19500, 'ultrasound'],
];

export class Spectrogram {
  private ctx: CanvasRenderingContext2D;
  private bins = new Uint8Array(0);
  private raf = 0;
  private analyser?: AnalyserNode;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  start(analyser: AnalyserNode): void {
    this.analyser = analyser;
    this.bins = new Uint8Array(analyser.frequencyBinCount);
    cancelAnimationFrame(this.raf);
    const tick = () => {
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.analyser = undefined;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(): void {
    if (!this.analyser) return;
    const { width: w, height: hgt } = this.canvas;
    const step = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.analyser.getByteFrequencyData(this.bins);
    // scroll left, then paint the newest column on the right
    this.ctx.drawImage(this.canvas, step, 0, w - step, hgt, 0, 0, w - step, hgt);
    const nyquist = this.analyser.context.sampleRate / 2;
    const col = this.ctx.createImageData(step, hgt);
    for (let y = 0; y < hgt; y++) {
      const bin = Math.min(this.bins.length - 1, Math.floor(((hgt - 1 - y) / hgt) * this.bins.length));
      const [r, g, b] = heat(this.bins[bin] / 255);
      for (let x = 0; x < step; x++) {
        const i = (y * step + x) * 4;
        col.data[i] = r;
        col.data[i + 1] = g;
        col.data[i + 2] = b;
        col.data[i + 3] = 255;
      }
    }
    this.ctx.putImageData(col, w - step, 0);
    // faint guides marking where each protocol family lives
    this.ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const [lo, hi] of BANDS) {
      for (const f of [lo, hi]) this.ctx.fillRect(w - step, Math.round(hgt * (1 - f / nyquist)), step, 1);
    }
  }
}

/** Black → purple → orange → yellow-white. */
function heat(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v));
  const r = Math.round(255 * Math.min(1, t * 1.8));
  const g = Math.round(255 * Math.max(0, Math.min(1, (t - 0.4) * 1.7)));
  const b = Math.round(255 * (t < 0.35 ? t * 2 : Math.max(0, 0.7 - (t - 0.35) * 2) + Math.max(0, (t - 0.85) * 5)));
  return [r, g, Math.min(255, b)];
}
