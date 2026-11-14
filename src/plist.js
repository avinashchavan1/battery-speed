// Minimal XML plist parser. Handles the subset that `ioreg -a` emits, so the
// app needs no dependencies. (`plutil -convert json` is not an option: the
// battery entry contains <data> values, which JSON conversion rejects.)

const TOKEN =
  /<(dict|array)\s*\/>|<(dict|array)>|<\/(dict|array)>|<(key|string|integer|real|data|date)>([\s\S]*?)<\/\4>|<(string|data)\s*\/>|<(true|false)\s*\/>/g;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);

function parseInteger(text) {
  const t = text.trim();
  // ioreg sometimes prints negative values as unsigned 64-bit. Go through
  // BigInt so those wrap back to the signed value without losing precision.
  if (t.length > 15) return Number(BigInt.asIntN(64, BigInt(t)));
  return Number(t);
}

export function parsePlist(xml) {
  const stack = [];
  let root;

  const emit = (value) => {
    const top = stack[stack.length - 1];
    if (!top) root = value;
    else if (Array.isArray(top.node)) top.node.push(value);
    else {
      top.node[top.key] = value;
      top.key = undefined;
    }
  };

  for (const m of xml.matchAll(TOKEN)) {
    const [, emptyContainer, open, close, tag, text, emptyScalar, bool] = m;
    if (emptyContainer) emit(emptyContainer === 'dict' ? {} : []);
    else if (open) stack.push({ node: open === 'dict' ? {} : [], key: undefined });
    else if (close) emit(stack.pop().node);
    else if (tag === 'key') stack[stack.length - 1].key = unescape(text);
    else if (tag === 'integer') emit(parseInteger(text));
    else if (tag === 'real') emit(Number(text));
    else if (tag) emit(tag === 'string' ? unescape(text) : text.trim());
    else if (emptyScalar) emit('');
    else if (bool) emit(bool === 'true');
  }
  return root;
}
