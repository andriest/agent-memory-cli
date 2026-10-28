import path from 'node:path';
import { readText, writeIfChanged } from './fsutil.mjs';

// Per-project settings live in `.agent-memory.json` at the repository root. Every key is
// optional; missing keys fall back to DEFAULT_CONFIG.

export const CONFIG_FILE = '.agent-memory.json';
export const DEFAULT_DIR = 'docs/memory';
export const AGENTS = ['claude', 'antigravity'];
export const SECTIONS = ['handoff', 'status', 'project', 'decisions', 'learnings', 'files'];

export const DEFAULT_CONFIG = {
  dir: DEFAULT_DIR,
  agents: [...AGENTS],
  context: {
    maxChars: 8000,
    recent: 5,
    sections: [...SECTIONS],
    files: [],
    // Inject the other agent's instruction file at session start (CLAUDE.md for Antigravity,
    // GEMINI.md for Claude Code), so project instructions reach every agent.
    agentInstructions: true,
  },
  handoff: {
    keep: 10,
    gitChanges: true,
  },
  session: {
    onStop: 'remind',
    remindIntervalMinutes: 20,
    onEnd: 'status',
  },
  tests: {
    command: '',
  },
  sensitive: {
    patterns: [],
    allow: [],
    excludePaths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', 'secrets/**', 'credentials*'],
  },
  claude: {
    // Set "autoMemoryEnabled": false in .claude/settings.json so docs/memory is the only memory.
    disableAutoMemory: true,
    // Import Claude Code auto memory on the first `install`: "auto" (per branch when
    // `branches` is configured, otherwise everything), "all", "branch" or "off".
    importOnInstall: 'auto',
  },
  // Other names a branch goes by in notes, e.g. { "brand/aurora": ["Aurora Shop"] }.
  // Used by `import claude --branch` to tell which memories belong to which branch.
  branches: {},
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isRegex(s) {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

const CHECKS = {
  string: [(v) => typeof v === 'string', 'a string'],
  boolean: [(v) => typeof v === 'boolean', 'true or false'],
  posint: [(v) => Number.isInteger(v) && v > 0, 'a positive integer'],
  nonneg: [(v) => typeof v === 'number' && v >= 0, 'a number ≥ 0'],
  'string[]': [(v) => Array.isArray(v) && v.every((x) => typeof x === 'string'), 'an array of strings'],
  'regex[]': [(v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && isRegex(x)), 'an array of valid regular expressions'],
};

const enumOf = (values) => [(v) => values.includes(v), `one of: ${values.join(', ')}`];
const enumList = (values) => [
  (v) => Array.isArray(v) && v.every((x) => values.includes(x)),
  `an array containing only: ${values.join(', ')}`,
];

const SCHEMA = {
  dir: CHECKS.string,
  agents: enumList(AGENTS),
  'context.maxChars': CHECKS.posint,
  'context.recent': CHECKS.posint,
  'context.sections': enumList(SECTIONS),
  'context.files': CHECKS['string[]'],
  'context.agentInstructions': CHECKS.boolean,
  'claude.disableAutoMemory': CHECKS.boolean,
  'claude.importOnInstall': enumOf(['auto', 'all', 'branch', 'off']),
  'claude.importedAt': CHECKS.string,
  'handoff.keep': CHECKS.posint,
  'handoff.gitChanges': CHECKS.boolean,
  'session.onStop': enumOf(['remind', 'off']),
  'session.remindIntervalMinutes': CHECKS.nonneg,
  'session.onEnd': enumOf(['status', 'off']),
  'tests.command': CHECKS.string,
  'sensitive.patterns': CHECKS['regex[]'],
  'sensitive.allow': CHECKS['string[]'],
  'sensitive.excludePaths': CHECKS['string[]'],
  branches: [
    (v) => isObject(v) && Object.values(v).every((a) => CHECKS['string[]'][0](a)),
    'an object mapping branch names to arrays of aliases',
  ],
};

const GROUPS = new Set(Object.keys(SCHEMA).filter((k) => k.includes('.')).map((k) => k.split('.')[0]));

export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!isObject(raw)) return { errors: [`${CONFIG_FILE} must contain a JSON object`], warnings };
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') continue;
    if (GROUPS.has(key)) {
      if (!isObject(value)) {
        errors.push(`"${key}" must be an object`);
        continue;
      }
      for (const [sub, subValue] of Object.entries(value)) {
        const check = SCHEMA[`${key}.${sub}`];
        if (!check) warnings.push(`unknown key "${key}.${sub}" is ignored`);
        else if (!check[0](subValue)) errors.push(`"${key}.${sub}" must be ${check[1]}`);
      }
    } else if (SCHEMA[key]) {
      if (!SCHEMA[key][0](value)) errors.push(`"${key}" must be ${SCHEMA[key][1]}`);
    } else {
      warnings.push(`unknown key "${key}" is ignored`);
    }
  }
  return { errors, warnings };
}

function merge(base, override) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  const text = readText(file, null);
  if (text === null) return { file, exists: false, raw: {}, config: structuredClone(DEFAULT_CONFIG), errors: [], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { file, exists: true, raw: {}, config: structuredClone(DEFAULT_CONFIG), errors: [`invalid JSON: ${err.message}`], warnings: [] };
  }
  const { errors, warnings } = validateConfig(raw);
  return { file, exists: true, raw, config: merge(DEFAULT_CONFIG, errors.length ? {} : raw), errors, warnings };
}

// Create the config file with every default spelled out (so it documents itself), or update
// only the keys that were passed explicitly on the command line.
export function writeConfig(loaded, updates) {
  const next = loaded.exists ? { ...loaded.raw } : structuredClone(DEFAULT_CONFIG);
  for (const [k, v] of Object.entries(updates)) if (v !== undefined) next[k] = v;
  return writeIfChanged(loaded.file, `${JSON.stringify(next, null, 2)}\n`);
}
