// Accessible status/alert announcements plus a short-lived visible toast.
export function createNotifier({ statusEl, alertEl }) {
  let timer;
  return {
    status(message) {
      statusEl.textContent = '';
      requestAnimationFrame(() => { statusEl.textContent = message; });
    },
    alert(message) {
      alertEl.hidden = false;
      alertEl.textContent = message;
      clearTimeout(timer);
      timer = setTimeout(() => { alertEl.hidden = true; }, 7000);
    },
    clearAlert() {
      alertEl.hidden = true;
      alertEl.textContent = '';
    },
  };
}
