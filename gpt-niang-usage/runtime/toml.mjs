// Minimal, dependency-free reader for the flat key/value parts of a TOML file.
//
// The quota backend (like the rest of this project) ships without npm
// dependencies, and the only thing it needs from Codex's config.toml is the
// provider block: `base_url`, `experimental_bearer_token` and `env_key`.
// Nested tables, arrays and inline tables are deliberately ignored.

const SECTION = /^\s*\[\s*([^\]]+?)\s*\]\s*$/;
const KEY_VALUE = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/;

function stripComment(value) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === '#' && !quoted) return value.slice(0, index);
  }
  return value;
}

function unquote(value) {
  const trimmed = value.trim();
  const quoted = /^"([\s\S]*)"$/.exec(trimmed) ?? /^'([\s\S]*)'$/.exec(trimmed);
  if (!quoted) return trimmed;
  // TOML basic strings escape only a few sequences; config values here are
  // plain URLs, tokens and variable names.
  return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// Table names can be dotted and/or quoted per segment, e.g.
// [model_providers.deepseek] or [projects."/home/user/My Project"].
function normalizeSection(name) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (const character of name) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === '.' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map(part => unquote(part.trim())).join('.');
}

// Returns a Map of section name -> Map of key -> string value. Keys in the
// implicit root section are stored under an empty-string section name.
export function parseFlatToml(text) {
  const sections = new Map();
  let current = '';
  sections.set(current, new Map());
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const section = SECTION.exec(rawLine);
    if (section) {
      current = normalizeSection(section[1]);
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const pair = KEY_VALUE.exec(rawLine);
    if (!pair) continue;
    const value = stripComment(pair[2]).trim();
    if (value.length === 0) continue;
    sections.get(current).set(pair[1], unquote(value));
  }
  return sections;
}

export function readTomlValue(sections, section, key) {
  return sections.get(section)?.get(key) ?? null;
}
