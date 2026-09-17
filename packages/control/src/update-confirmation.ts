import { createInterface } from "node:readline/promises";

interface TerminalInput extends NodeJS.ReadableStream { isTTY?: boolean }
interface TerminalOutput extends NodeJS.WritableStream { isTTY?: boolean }

export async function confirmConversationsUpdate(options: {
  assumeYes: boolean;
  json: boolean;
  input?: TerminalInput;
  output?: TerminalOutput;
}): Promise<boolean> {
  if (options.assumeYes) return true;
  if (options.json) {
    throw new Error("Installing an update with --json requires --yes");
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Updating requires confirmation; rerun with --yes");
  }
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(
      "MinuChannels will verify the release and safely coordinate any running background service.\n" +
      "Install this update? [y/N] ",
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
