// Bell fifth: selected audition variation 6 at its original pitch.
// A sine fundamental plus a quiet second harmonic preserves the bell texture.
// Use six times the audition's gain: closer to Herdr's signal level, with headroom.
const volumeScale = 6;
const notes = [
  { frequency: 392, delay: 0, duration: 0.25, volume: 0.08 },
  { frequency: 587.33, delay: 0.18, duration: 0.38, volume: 0.07 },
];

export function playNotificationSound(context: AudioContext): void {
  const start = context.currentTime;
  const bell = context.createPeriodicWave(
    new Float32Array([0, 0, 0]),
    new Float32Array([0, 1, 0.2]),
    { disableNormalization: true },
  );
  for (const { frequency, delay, duration, volume } of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const curve = new Float32Array(256);
    for (let index = 0; index < curve.length; index++) {
      const time = duration * index / (curve.length - 1);
      const attack = Math.min(1, time / 0.008);
      const release = Math.min(1, (duration - time) / 0.04);
      curve[index] = volume * volumeScale * attack * Math.exp(-6 * time / duration) * release;
    }
    oscillator.frequency.value = frequency;
    oscillator.setPeriodicWave(bell);
    gain.gain.setValueCurveAtTime(curve, start + delay, duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start + delay);
    oscillator.stop(start + delay + duration);
  }
}
