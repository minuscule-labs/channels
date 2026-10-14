#!/usr/bin/env node
// Dependency-free notification auditions. Usage: node scripts/preview-notification-sounds.mjs [1-10]
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const note = (frequency, delay, duration, volume = 0.08, extra = {}) =>
  ({ frequency, delay, duration, volume, ...extra });

export const samples = [
  { name: "Current chime", description: "The app's existing rising two-note sound (reference).", notes: [
    note(523.25, 0, 0.14, 0.08, { envelope: "flat" }),
    note(659.25, 0.12, 0.2, 0.065, { envelope: "flat" }),
  ] },
  { name: "Soft hello", description: "A gentler, rounded rising pair with a smooth fade.", notes: [
    note(523.25, 0, 0.22), note(659.25, 0.16, 0.32, 0.07),
  ] },
  { name: "Glass bell", description: "One clear bell with a light shimmer.", notes: [
    note(1046.5, 0, 0.65, 0.075, { envelope: "pluck" }),
    note(2093, 0, 0.4, 0.018, { envelope: "pluck" }),
    note(3139.5, 0, 0.22, 0.008, { envelope: "pluck" }),
  ] },
  { name: "Wooden tap", description: "A short, low, unobtrusive knock.", notes: [
    note(330, 0, 0.16, 0.12, { envelope: "pluck" }),
    note(660, 0, 0.09, 0.025, { envelope: "pluck" }),
  ] },
  { name: "Warm fifth", description: "A mellow, lower-pitched two-note confirmation.", notes: [
    note(392, 0, 0.25), note(587.33, 0.18, 0.38, 0.07),
  ] },
  { name: "Bubble", description: "A playful little upward droplet.", notes: [
    note(440, 0, 0.18, 0.1, { endFrequency: 880, envelope: "pluck" }),
  ] },
  { name: "Muted blip", description: "A compact triangle-wave ping with a little texture.", notes: [
    note(740, 0, 0.19, 0.1, { waveform: "triangle" }),
  ] },
  { name: "Falling pair", description: "Two soft descending notes, less attention-grabbing.", notes: [
    note(783.99, 0, 0.2, 0.075), note(523.25, 0.15, 0.3, 0.075),
  ] },
  { name: "Tiny arpeggio", description: "A cheerful three-note rise.", notes: [
    note(523.25, 0, 0.2, 0.07), note(659.25, 0.1, 0.22, 0.07), note(783.99, 0.2, 0.32, 0.07),
  ] },
  { name: "Airy sparkle", description: "A delicate high pair with a longer bell-like tail.", notes: [
    note(1318.51, 0, 0.4, 0.06, { envelope: "pluck" }),
    note(1567.98, 0.13, 0.6, 0.06, { envelope: "pluck" }),
  ] },
];

// Keep the favourite itself untouched; variation mode has its own numbering.
const warmFifth = samples[4];
export const warmFifthVariations = [
  { ...warmFifth, name: "Warm fifth base", description: "Unchanged original sample 5, for comparison." },
  { name: "Softer fifth", description: "Same pitches and timing, 30 percent quieter.", notes:
    warmFifth.notes.map((n) => ({ ...n, volume: n.volume * 0.7 })),
  },
  { name: "Quick fifth", description: "Same pitches and volume, with shorter notes and a quicker rise.", notes:
    warmFifth.notes.map((n) => ({ ...n, delay: n.delay * 0.7, duration: n.duration * 0.7 })),
  },
  { name: "Lower fifth", description: "Same timing and shape, pitched three semitones lower for more warmth.", notes:
    warmFifth.notes.map((n) => ({ ...n, frequency: n.frequency * 2 ** (-3 / 12) })),
  },
  { name: "Spacious fifth", description: "Same notes, with more breathing room before the second tone.", notes:
    warmFifth.notes.map((n) => ({ ...n, delay: n.delay === 0 ? 0 : 0.3 })),
  },
  { name: "Bell fifth", description: "Same pitches and timing, with a plucked bell-like decay and subtle harmonics.", notes:
    warmFifth.notes.flatMap((n) => [
      { ...n, envelope: "pluck" },
      { ...n, frequency: n.frequency * 2, volume: n.volume * 0.2, envelope: "pluck" },
    ]),
  },
];

warmFifthVariations.push({
  name: "Quick bell fifth",
  description: "Variation 3's quick timing combined with variation 6's bell texture.",
  notes: warmFifthVariations[5].notes.map((n) => ({
    ...n, delay: n.delay * 0.7, duration: n.duration * 0.7,
  })),
});

export function renderWav(sample, volume = 1) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("Volume must be between 0 and 1.");
  const sampleRate = 44100;
  const duration = Math.max(...sample.notes.map((n) => n.delay + n.duration)) + 0.1;
  const frames = Math.ceil(duration * sampleRate);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // Mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);

  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    let value = 0;
    for (const n of sample.notes) {
      const t = time - n.delay;
      if (t < 0 || t >= n.duration) continue;
      // Integrate a linear frequency sweep so there are no phase jumps.
      const cycles = n.frequency * t + ((n.endFrequency ?? n.frequency) - n.frequency) * t * t / (2 * n.duration);
      const phase = 2 * Math.PI * cycles;
      const wave = n.waveform === "triangle" ? 2 / Math.PI * Math.asin(Math.sin(phase)) : Math.sin(phase);
      const attack = Math.min(1, t / 0.008);
      const release = Math.min(1, (n.duration - t) / 0.04);
      const envelope = n.envelope === "flat" ? 1
        : n.envelope === "pluck" ? attack * Math.exp(-6 * t / n.duration) * release
        : attack * (1 - t / n.duration) ** 1.5 * release;
      value += wave * n.volume * envelope;
    }
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * volume)) * 32767), 44 + frame * 2);
  }
  return wav;
}

async function play(path, announce) {
  await new Promise((resolve, reject) => {
    const child = spawn(announce ? "say" : "afplay", [path], { stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    process.once("SIGINT", interrupt);
    const cleanup = () => process.removeListener("SIGINT", interrupt);
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal === "SIGINT") { process.exitCode = 130; reject(new Error("Playback stopped.")); }
      else if (code === 0) resolve();
      else reject(new Error(`Audio player exited with ${signal ?? code}`));
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(`Notification sound auditions\n\nUsage: node scripts/preview-notification-sounds.mjs [number] [--variations] [--no-play] [--quiet] [--announce]\n\nNo number: play all samples, with a two-second gap.\n1-10: replay an original sample.\n--variations: audition Warm fifth base (1), five variations (2-6), and quick bell hybrid (7).\n--no-play: generate WAV files without playing (any platform).\n--quiet: halve the sample volume.\n--announce: speak each sample number and name before playing (macOS).\n--list: list the samples without generating files.\n\nStart with a comfortable system volume. Ctrl+C stops playback.\nThe app's notification sound is not changed.`);
    return;
  }
  const variations = args.includes("--variations");
  const catalog = variations ? warmFifthVariations : samples;
  const numbers = args.filter((arg) => /^\d+$/.test(arg));
  const unknown = args.filter((arg) => !/^\d+$/.test(arg) && !["--no-play", "--quiet", "--list", "--announce", "--variations"].includes(arg));
  if (unknown.length || numbers.length > 1 || (numbers.length && (+numbers[0] < 1 || +numbers[0] > catalog.length))) {
    throw new Error(`Use a sample number from 1 to ${catalog.length}; see --help for options.`);
  }
  if (args.includes("--list")) {
    catalog.forEach((sample, index) => console.log(`${index + 1}. ${sample.name} — ${sample.description}`));
    return;
  }
  const noPlay = args.includes("--no-play");
  if (!noPlay && process.platform !== "darwin") throw new Error("Playback uses macOS afplay. Use --no-play to export WAV files on other platforms.");
  const selected = numbers.length ? [+numbers[0] - 1] : catalog.map((_, index) => index);
  const directory = await mkdtemp(join(tmpdir(), "minu-notification-sounds-"));
  console.log(`WAV files: ${directory}\nStart at a comfortable system volume. The app is unchanged.\n`);
  for (const index of selected) {
    const sample = catalog[index];
    const path = join(directory, `${String(index + 1).padStart(2, "0")}-${sample.name.toLowerCase().replaceAll(" ", "-")}.wav`);
    await writeFile(path, renderWav(sample, args.includes("--quiet") ? 0.5 : 1));
    console.log(`${index + 1}/${catalog.length} · ${sample.name}\n  ${sample.description}`);
    if (!noPlay) {
      if (args.includes("--announce")) {
        await play(`Sample ${index + 1}. ${sample.name}.`, true);
        await sleep(500);
      }
      await play(path);
      if (index !== selected.at(-1)) await sleep(2000);
    }
  }
  console.log(`\nPick a number to replay: pnpm sound:preview ${variations ? "--variations " : ""}<number>\nTell me your favourite number and what you'd like tweaked.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode ||= 1; });
}
