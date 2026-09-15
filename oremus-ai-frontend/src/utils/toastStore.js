// Minimal dependency-free toast store. A module-level list of active toasts
// with a subscribe/emit pattern so any component (or non-React code) can raise
// a toast via `toast.error(...)` and the single mounted <Toaster/> renders them.

let toasts = [];
let listeners = [];
let idSeq = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export function subscribe(listener) {
  listeners.push(listener);
  listener(toasts);
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function addToast(message, type = 'info', duration = 4500) {
  const id = ++idSeq;
  toasts = [...toasts, { id, message, type }];
  emit();
  if (duration) setTimeout(() => dismissToast(id), duration);
  return id;
}

export const toast = {
  error:   (m, d) => addToast(m, 'error', d),
  success: (m, d) => addToast(m, 'success', d),
  info:    (m, d) => addToast(m, 'info', d),
};
