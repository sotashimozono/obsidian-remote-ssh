import type { Page } from '@playwright/test';
import GIFEncoder from 'gif-encoder-2';
import { PNG } from 'pngjs';
import * as fs from 'node:fs';

/**
 * Captures Playwright page screenshots at a fixed interval and
 * stitches them into an animated GIF. Works with CDP connections
 * where Playwright's native `video` option is unavailable.
 */
export class ScreenRecorder {
  private frames: Buffer[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private width = 0;
  private height = 0;

  /**
   * Start recording. Takes a screenshot every `intervalMs` ms.
   * Default: 200ms (~5 fps).
   */
  async start(page: Page, intervalMs = 200): Promise<void> {
    // Take an initial screenshot to determine dimensions
    const first = await page.screenshot({ type: 'png' });
    const parsed = PNG.sync.read(first);
    this.width = parsed.width;
    this.height = parsed.height;
    this.frames.push(first);

    this.timer = setInterval(async () => {
      try {
        const buf = await page.screenshot({ type: 'png' });
        this.frames.push(buf);
      } catch {
        // Page may have closed — stop silently
        this.stopCapture();
      }
    }, intervalMs);
  }

  /** Stop capturing frames. */
  stopCapture(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Write the captured frames as an animated GIF. */
  async save(outputPath: string, delayMs = 200): Promise<void> {
    this.stopCapture();

    if (this.frames.length === 0) {
      throw new Error('ScreenRecorder: no frames captured');
    }

    const scaledW = Math.floor(this.width * 0.7);
    const scaledH = Math.floor(this.height * 0.7);
    const encoder = new GIFEncoder(scaledW, scaledH, 'neuquant');
    encoder.setDelay(delayMs);
    encoder.setRepeat(0); // loop forever
    encoder.setQuality(10);
    encoder.start();

    for (const pngBuf of this.frames) {
      const parsed = PNG.sync.read(pngBuf);
      const scaled = scaleDown(parsed, scaledW, scaledH);
      encoder.addFrame(scaled);
    }

    encoder.finish();
    const gifBuf = encoder.out.getData();
    fs.writeFileSync(outputPath, gifBuf);
  }

  get frameCount(): number {
    return this.frames.length;
  }
}

/**
 * Nearest-neighbor downscale of RGBA pixel data.
 * Returns a Buffer of raw RGBA pixels at the target size.
 */
function scaleDown(
  png: { width: number; height: number; data: Buffer },
  targetW: number,
  targetH: number,
): Buffer {
  const out = Buffer.alloc(targetW * targetH * 4);
  const xRatio = png.width / targetW;
  const yRatio = png.height / targetH;

  for (let y = 0; y < targetH; y++) {
    const srcY = Math.floor(y * yRatio);
    for (let x = 0; x < targetW; x++) {
      const srcX = Math.floor(x * xRatio);
      const srcIdx = (srcY * png.width + srcX) * 4;
      const dstIdx = (y * targetW + x) * 4;
      out[dstIdx] = png.data[srcIdx];
      out[dstIdx + 1] = png.data[srcIdx + 1];
      out[dstIdx + 2] = png.data[srcIdx + 2];
      out[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return out;
}
