import assert from "node:assert/strict";
import { test } from "node:test";
import { main, renderWav, samples, warmFifthVariations } from "./preview-notification-sounds.mjs";

test("all original samples and variations produce quiet, valid mono PCM WAVs", () => {
  assert.equal(samples.length, 10);
  assert.equal(warmFifthVariations.length, 7);
  const outputs = new Set();
  for (const sample of [...samples, ...warmFifthVariations]) {
    const wav = renderWav(sample);
    outputs.add(wav.toString("base64"));
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.length > 44 + 44100 * 0.1 * 2);
    assert.ok(wav.length < 44 + 44100 * 2);
    let peak = 0;
    for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    assert.ok(peak > 0 && peak < 32767 * 0.2, `${sample.name}: peak ${peak}`);
    // Each file ends with silence, not a clipped tail.
    assert.equal(wav.readInt16LE(wav.length - 2), 0);
  }
  assert.equal(outputs.size, 16); // Ten originals + five variations + hybrid, with one repeated base.
});

test("Warm fifth base is unchanged and each variation differs", () => {
  const original = renderWav(samples[4]);
  assert.deepEqual(renderWav(warmFifthVariations[0]), original);
  for (const variation of warmFifthVariations.slice(1)) {
    assert.notDeepEqual(renderWav(variation), original);
  }
  assert.deepEqual(samples[4].notes, [
    { frequency: 392, delay: 0, duration: 0.25, volume: 0.08 },
    { frequency: 587.33, delay: 0.18, duration: 0.38, volume: 0.07 },
  ]);
});

test("quick bell combines quick timing with bell texture without changing either source", () => {
  const quick = warmFifthVariations[2];
  const bell = warmFifthVariations[5];
  const hybrid = warmFifthVariations[6];
  assert.equal(hybrid.notes.length, bell.notes.length);
  hybrid.notes.forEach((n, index) => {
    assert.deepEqual(n, { ...bell.notes[index], delay: bell.notes[index].delay * 0.7, duration: bell.notes[index].duration * 0.7 });
    assert.equal(n.delay, quick.notes[Math.floor(index / 2)].delay);
    assert.equal(n.duration, quick.notes[Math.floor(index / 2)].duration);
  });
  assert.equal(bell.notes[0].duration, 0.25);
  assert.equal(quick.notes[0].envelope, undefined);
});

test("reference sample preserves the existing first oscillator", () => {
  const wav = renderWav(samples[0]);
  const frame = 1000; // Before the second note begins.
  assert.equal(wav.readInt16LE(44 + frame * 2), Math.round(Math.sin(2 * Math.PI * 523.25 * frame / 44100) * 0.08 * 32767));
});

test("volume control supports silence and rejects invalid values", () => {
  assert.ok(renderWav(samples[0], 0).subarray(44).every((byte) => byte === 0));
  for (const value of [-1, 2, NaN, Infinity]) assert.throws(() => renderWav(samples[0], value), /Volume/);
});

test("CLI rejects invalid selections before exporting or playing", async () => {
  for (const args of [["0"], ["11"], ["1", "2"], ["--bogus"], ["1.5"], ["--variations", "8"]]) {
    await assert.rejects(main(args), /sample number/);
  }
});
