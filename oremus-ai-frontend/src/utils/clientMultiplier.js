// Deterministic per-client multiplier so KPIs visibly shift on client switch.
// Returns a stable value in roughly the 0.5x – 1.65x range based on a hash of the client id.
export function clientMultiplier(clientId) {
  if (!clientId) return 1;
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) | 0;
  const n = (Math.abs(h) % 100) / 100;
  return 0.5 + n * 1.15;
}
