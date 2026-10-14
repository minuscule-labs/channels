// Passed directly to page.addInitScript; keep it self-contained.
export function installNotificationAudioMock(): void {
  const state = window as unknown as { __soundCount: number; __audioContextCount: number; __audioResumeCount: number };
  state.__soundCount = 0;
  state.__audioContextCount = 0;
  state.__audioResumeCount = 0;
  class TestAudioContext {
    currentTime = 0;
    destination = {};
    state = "suspended";
    constructor() { state.__audioContextCount += 1; }
    resume() {
      state.__audioResumeCount += 1;
      this.state = "running";
      return Promise.resolve();
    }
    createPeriodicWave() { return {}; }
    createGain() {
      return {
        gain: { setValueCurveAtTime: () => undefined },
        connect: () => this.destination,
        disconnect: () => undefined,
      };
    }
    createOscillator() {
      return {
        frequency: { value: 0 },
        setPeriodicWave: () => undefined,
        connect: () => ({ connect: () => this.destination }),
        disconnect: () => undefined,
        start: () => { if (this.state === "running") state.__soundCount += 1; },
        stop: () => undefined,
      };
    }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  Object.defineProperty(window, "AudioContext", { value: TestAudioContext, configurable: true });
}
