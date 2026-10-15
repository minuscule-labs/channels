import { expect, test } from "@playwright/test";

test("real Web Audio Bell fifth matches the original audition pitches with sixfold gain without clipping", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async (modulePath) => {
    const { playNotificationSound } = await import(modulePath);
    const sampleRate = 44100;
    const context = new OfflineAudioContext(1, sampleRate, sampleRate);
    playNotificationSound(context);
    const rendered = (await context.startRendering()).getChannelData(0);
    const notes = [
      { frequency: 392, delay: 0, duration: 0.25, volume: 0.08 },
      { frequency: 587.33, delay: 0.18, duration: 0.38, volume: 0.07 },
    ];
    let peakDifference = 0;
    let squaredDifference = 0;
    let peak = 0;
    for (let frame = 0; frame < rendered.length; frame++) {
      const time = frame / sampleRate;
      let preview = 0;
      for (const note of notes) {
        const t = time - note.delay;
        if (t < 0 || t >= note.duration) continue;
        const phase = 2 * Math.PI * note.frequency * t;
        const envelope = note.volume * 6 * Math.min(1, t / 0.008)
          * Math.exp(-6 * t / note.duration) * Math.min(1, (note.duration - t) / 0.04);
        preview += envelope * (Math.sin(phase) + 0.2 * Math.sin(2 * phase));
      }
      const difference = Math.abs(rendered[frame]! - preview);
      peakDifference = Math.max(peakDifference, difference);
      squaredDifference += difference ** 2;
      peak = Math.max(peak, Math.abs(rendered[frame]!));
    }
    return { peakDifference, rmsDifference: Math.sqrt(squaredDifference / rendered.length), peak };
  }, "/src/lib/notification-sound.ts");
  // Account for Web Audio's scheduling resolution and interpolation of the gain
  // curve. Compare waveform error at audition gain; absolute error scales with gain.
  // The louder waveform should remain well below full-scale clipping at 1.0.
  expect(result.peak).toBeGreaterThan(0.3);
  expect(result.peak).toBeLessThan(0.5);
  expect(result.peakDifference / 6).toBeLessThan(0.003);
  expect(result.rmsDifference / 6).toBeLessThan(0.0003);
});
