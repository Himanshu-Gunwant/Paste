/**
 * Lightweight content-local language detection (docs/ARCHITECTURE.md §4 A).
 * Heuristics only — shebangs, markers, keyword scoring. No ML, no outbound
 * fetch (SSRF rule, §13); result is stored as `detected_language` metadata
 * alongside the user-declared `language`.
 */
const SHEBANG_MAP: [RegExp, string][] = [
  [/^\s*#!\s*\/?(usr\/bin\/(?:env\s+)?)(ba)?sh\b/, 'bash'],
  [/^\s*#!.*python3?\b/, 'python'],
  [/^\s*#!.*node\b/, 'javascript'],
  [/^\s*#!.*ruby\b/, 'ruby'],
  [/^\s*#!.*php\b/, 'php'],
  [/^\s*#!.*perl\b/, 'perl'],
];

const MARKERS: [RegExp, string, number][] = [
  [/^\s*<\?php/, 'php', 5],
  [/<!doctype html|<html[\s>]/i, 'html', 5],
  [/^\s*<\?xml/, 'xml', 3],
  [/^\s*package main\b/m, 'go', 5],
  [/\bfunc\s+\w+\s*\(/m, 'go', 2],
  [/\bfn\s+\w+\s*\(|\blet\s+mut\b/m, 'rust', 3],
  [/\bpublic\s+(static\s+)?(void|class)\b/m, 'java', 4],
  [/\bSystem\.out\.print|\bimport\s+java\./m, 'java', 3],
  [/\bdef\s+\w+\s*\(|\bself\b|\bimport\s+\w+\s*$|\bfrom\s+\w+\s+import\b/m, 'python', 2],
  [/\bfunction\s+\w*\s*\(|\bconst\s+\w+\s*=|=>|console\.log/m, 'javascript', 2],
  [/\binterface\s+\w+\s*\{|:\s*(string|number|boolean)\b/m, 'typescript', 3],
  [/#include\s*[<"]|int\s+main\s*\(/m, 'cpp', 4],
  [/\bSELECT\b.+\bFROM\b|\bINSERT\s+INTO\b/i, 'sql', 4],
  [/^\s*[.#@][\w-]+\s*\{[^}]*:[^}]*;/m, 'css', 4],
];

export function detectLanguage(content: string): string | null {
  const head = content.slice(0, 4_000);

  for (const [pattern, language] of SHEBANG_MAP) {
    if (pattern.test(head)) return language;
  }

  let best: { language: string; score: number } | null = null;
  for (const [pattern, language, weight] of MARKERS) {
    if (!pattern.test(head)) continue;
    if (!best || weight > best.score) best = { language, score: weight };
  }
  if (best && best.score >= 2) return best.language;

  // JSON: balanced top-level object/array that actually parses.
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {
      // not JSON — fall through
    }
  }
  return null;
}
