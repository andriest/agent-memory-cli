// Memory is committed to git, so refuse anything that looks like a credential.
// Values that clearly reference an env var or placeholder are allowed.
const NOT_A_LITERAL = String.raw`(?!process\.env|os\.environ|env\(|\$|<|\{\{|\*+)`;

const BUILT_IN = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['API secret key (sk-…)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'credential assignment',
    new RegExp(
      String.raw`\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?${NOT_A_LITERAL}[^\s"'\`]{8,}`,
      'i',
    ),
  ],
  ['URL with embedded password', new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://[^\s:@/]+:${NOT_A_LITERAL}[^\s@/]+@`, 'i')],
];

// `sensitive` is the project config section: extra `patterns` (regex strings) to refuse and
// `allow` literals that are known false positives.
function rules({ patterns = [] } = {}) {
  return [...BUILT_IN, ...patterns.map((p, i) => [`custom pattern #${i + 1} (${p})`, new RegExp(p, 'i')])];
}

function withoutAllowed(text, { allow = [] } = {}) {
  return allow.reduce((t, literal) => (literal ? t.split(literal).join('') : t), text);
}

export function findSecrets(text, sensitive) {
  const scanned = withoutAllowed(text, sensitive);
  const hits = [];
  for (const [label, re] of rules(sensitive)) {
    const m = re.exec(scanned);
    if (m) hits.push({ label, sample: redact(m[0]) });
  }
  return hits;
}

// For captured tool output (test logs), which is recorded rather than refused.
export function redactSecrets(text, sensitive) {
  const allowed = sensitive?.allow?.filter(Boolean) ?? [];
  return rules(sensitive).reduce(
    (t, [, re]) => t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), (m) =>
      allowed.some((a) => m.includes(a)) ? m : '[REDACTED]',
    ),
    text,
  );
}

function redact(s) {
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}
