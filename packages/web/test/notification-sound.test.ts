import { describe, expect, test, vi } from "vitest";
import { playNotificationSound } from "../src/lib/notification-sound";

function audioContext() {
  const destination = {};
  const wave = {};
  const oscillators = Array.from({ length: 2 }, () => ({
    frequency: { value: 0 },
    setPeriodicWave: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: undefined as undefined | (() => void),
  }));
  const gains = Array.from({ length: 2 }, () => ({
    gain: { setValueCurveAtTime: vi.fn() },
    connect: vi.fn(() => destination),
    disconnect: vi.fn(),
  }));
  oscillators.forEach((oscillator, index) => oscillator.connect.mockReturnValue(gains[index]));
  const context = {
    currentTime: 10,
    destination,
    createPeriodicWave: vi.fn(() => wave),
    createOscillator: vi.fn().mockReturnValueOnce(oscillators[0]).mockReturnValueOnce(oscillators[1]),
    createGain: vi.fn().mockReturnValueOnce(gains[0]).mockReturnValueOnce(gains[1]),
  };
  return { context, wave, oscillators, gains };
}

describe("Bell fifth notification sound", () => {
  test("uses audition 6's original pitches with sixfold gain while preserving timing, envelope, and harmonics", () => {
    const { context, wave, oscillators, gains } = audioContext();
    playNotificationSound(context as unknown as AudioContext);
    expect(context.createPeriodicWave).toHaveBeenCalledWith(
      new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0.2]), { disableNormalization: true },
    );
    for (const [index, expected] of [
      { frequency: 392, delay: 0, duration: 0.25, volume: 0.08 },
      { frequency: 587.33, delay: 0.18, duration: 0.38, volume: 0.07 },
    ].entries()) {
      const oscillator = oscillators[index]!;
      const gain = gains[index]!;
      expect(oscillator.frequency.value).toBe(expected.frequency);
      expect(oscillator.setPeriodicWave).toHaveBeenCalledWith(wave);
      expect(oscillator.start).toHaveBeenCalledWith(10 + expected.delay);
      expect(oscillator.stop).toHaveBeenCalledWith(10 + expected.delay + expected.duration);
      const [curve, start, duration] = gain.gain.setValueCurveAtTime.mock.calls[0]! as [Float32Array, number, number];
      expect(start).toBe(10 + expected.delay);
      expect(duration).toBe(expected.duration);
      expect(curve[0]).toBe(0);
      expect(curve.at(-1)).toBe(0);
      curve.forEach((value, point) => {
        const time = duration * point / (curve.length - 1);
        // Same envelope as the WAV preview: short attack, exponential decay, smooth release.
        const reference = expected.volume * 6 * Math.min(1, time / 0.008)
          * Math.exp(-6 * time / duration) * Math.min(1, (duration - time) / 0.04);
        expect(value).toBeCloseTo(reference, 7);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(expected.volume * 6);
      });
      expect(oscillator.connect).toHaveBeenCalledWith(gain);
      expect(gain.connect).toHaveBeenCalledWith(context.destination);
    }
  });

  test("disconnects each note's audio nodes after it finishes", () => {
    const { context, oscillators, gains } = audioContext();
    playNotificationSound(context as unknown as AudioContext);
    oscillators.forEach((oscillator, index) => {
      expect(oscillator.disconnect).not.toHaveBeenCalled();
      oscillator.onended?.();
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
      expect(gains[index]!.disconnect).toHaveBeenCalledOnce();
    });
  });
});
