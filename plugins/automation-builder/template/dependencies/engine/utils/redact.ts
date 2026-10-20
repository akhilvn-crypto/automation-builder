// Secret masking shared by the pipeline engine. The Playwright-facing twin lives in the scaffolded framework
// (helpers/test-data.*) so generated tests never import engine code.

// Replace every occurrence of the given secret values (min length 3) with "***".
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}
