/**
 * Minimal replacements for @actions/core functions.
 *
 * The Action is intentionally dependency-free beyond the agent packages:
 * these are the two functions actually used (setFailed, setOutput, info),
 * implemented against the runner protocol so the bundle carries no
 * additional supply-chain surface.
 */

export function setFailed(message: string): void {
  issueCommand("error", {}, message);
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function setOutput(name: string, value: string): void {
  issueCommand("set-output", { name }, value);
}

function issueCommand(command: string, properties: Record<string, string>, message: string): void {
  const parts: string[] = [command];
  for (const [k, v] of Object.entries(properties)) {
    if (v) parts.push(`${k}=${escape(v)}`);
  }
  const cmd = `::${parts.join(" ")}::${escapeData(message)}`;
  process.stdout.write(`${cmd}\n`);
}

function escape(s: string): string {
  return s
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function escapeData(s: string): string {
  return s
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
