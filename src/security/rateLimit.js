export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10_000 }) {
  const entries = new Map();
  return (key) => {
    const time = now();
    for (const [entryKey, value] of entries) {
      if (value.resetAt <= time) entries.delete(entryKey);
    }
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= time) entry = { count: 0, resetAt: time + windowMs };
    entry.count += 1;
    entries.delete(key);
    if (entries.size >= maxKeys && !entries.has(key)) entries.delete(entries.keys().next().value);
    entries.set(key, entry);
    return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) };
  };
}
