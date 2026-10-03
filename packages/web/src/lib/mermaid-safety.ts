import { parseEntities } from "parse-entities";

export const MAX_DIAGRAM_LENGTH = 50_000;

const sequenceId = String.raw`[\p{L}_][\p{L}\p{N}_-]*`;
// Only statements whose arguments are IDs, numbers or text labels are admitted.
// In particular, legacy properties/icons and rect's arbitrary SVG fill are not admitted.
const sequenceStatements = [
  new RegExp(`^(?:participant|actor)\\s+${sequenceId}(?:\\s+as\\s+.+)?$`, "iu"),
  new RegExp(`^${sequenceId}\\s*(?:<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\\)|-\\))\\s*[+-]?\\s*${sequenceId}\\s*:.*$`, "u"),
  new RegExp(`^(?:activate|deactivate|destroy)\\s+${sequenceId}$`, "iu"),
  new RegExp(`^create\\s+(?:participant|actor)\\s+${sequenceId}(?:\\s+as\\s+.+)?$`, "iu"),
  new RegExp(`^note\\s+(?:left\\s+of|right\\s+of|over)\\s+${sequenceId}(?:\\s*,\\s*${sequenceId})?\\s*:.*$`, "iu"),
  /^(?:loop|opt|alt|else|par|and|critical|option|break)(?:\s+.*)?$/i,
  /^(?:title|accTitle|accDescr)(?:\s+|:).*$/i,
  /^autonumber(?:\s+\d+(?:\s+\d+)?)?$/i,
  /^end$/i,
];

function assertSupportedStatements(source: string, normalized: string): void {
  // Use the actual source header, not entity-decoded labels, to determine Mermaid's grammar.
  const significant = source.replace(/^\s*%%[^\r\n]*(?:\r?\n|$)/gm, "").trim();
  if (/^(?:graph|flowchart)[ \t]+(?:TD|TB|BT|LR|RL)(?=[\s;]|$)/.test(significant)) {
    // These are flowchart's custom styling statements; metadata and HTML are rejected below.
    if (/\b(?:style|classDef|linkStyle)\s/i.test(normalized)) {
      throw new Error("This flowchart uses unsupported custom styling");
    }
    return;
  }
  const header = /^sequenceDiagram(?=[\s;]|$)/i.exec(significant);
  if (header) {
    // Entity semicolons belong to labels, not statement separators. Preserve them while
    // checking every actual statement, so a message/alias cannot conceal a properties statement.
    const statements = significant.slice(header[0].length)
      .replace(/(?:&(?:#(?:x[\da-f]+|\d+)|[a-z]+)|#(?:x[\da-f]+|\d+|[a-z]+));/gi, "entity")
      .split(/[\r\n;]/).map((statement) => statement.trim()).filter(Boolean);
    if (statements.every((statement) => sequenceStatements.some((pattern) => pattern.test(statement)))) return;
    throw new Error("This sequence diagram uses unsupported statements");
  }
  // Fail closed: new/other Mermaid grammars must be reviewed before becoming renderable.
  throw new Error("This diagram uses an unsupported type; only flowcharts and basic sequence diagrams render");
}

/**
 * Support only a bounded flowchart/sequence profile, not arbitrary Mermaid grammars.
 * SVG sanitization is too late to stop resource requests during DOM measurement.
 * Reject unsupported source before parsing/rendering; keep the original as source.
 */
export function assertSafeMermaid(source: string): void {
  if (source.length > MAX_DIAGRAM_LENGTH) throw new Error("Diagram is too large");

  // Mermaid supports its own #name;/#number; escapes as well as HTML entities in labels.
  const normalized = parseEntities(source.replace(
    /(?<!&)#(x[\da-f]+|\d+|[a-z]+);/gi,
    (_match, entity: string) => `&${/^(?:\d|x[\da-f])/i.test(entity) ? "#" : ""}${entity};`,
  ));
  if (
    // No message-controlled configuration, including fonts, themes and diagram-specific options.
    /%%\s*\{/.test(normalized) || /^\s*---(?:\s|$)/.test(normalized)
    // Extended node metadata includes image nodes, with YAML-escaped/quoted property names.
    || /@\s*\{/.test(normalized)
    // Labels are text-only; allow the common inert line-break tag, but no embedded HTML/SVG.
    || /<\s*\/?\s*[a-z!]/i.test(normalized.replace(/<br\s*\/?\s*>/gi, ""))
  ) {
    throw new Error("This diagram uses unsupported configuration, metadata, or HTML");
  }
  assertSupportedStatements(source, normalized);
}
