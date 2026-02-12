export async function searchDomains({ page = 1, pageSize = 50, criteria = {} } = {}) {
  const res = await fetch('/api/domains/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, pageSize, criteria }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Search failed');
  }
  return res.json();
}

export async function getCapabilities() {
  const res = await fetch('/api/capabilities');
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function checkDomain(domain) {
  const res = await fetch('/api/domains/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Check failed');
  }
  return res.json();
}

