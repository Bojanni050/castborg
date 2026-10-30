const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** De kleur komt uit de API-configuratie; valideer hem voordat hij in CSS belandt. */
export function safeColor(input: string | null | undefined): string {
  return input && HEX_COLOR.test(input) ? input.toLowerCase() : "#2563eb";
}

/**
 * Maakt een kleur donkerder (negative amount) of lichter (positieve amount) voor hover-states.
 * amount ligt tussen -1 en 1.
 */
export function shade(hex: string, amount: number): string {
  const base = safeColor(hex);
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(base.slice(offset, offset + 2), 16));
  const target = amount < 0 ? 0 : 255;
  const ratio = Math.min(1, Math.abs(amount));

  const mixed = rgb.map((channel) => {
    const value = Math.round(channel + (target - channel) * ratio);
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  });

  return `#${mixed.join("")}`;
}

export function buildStyles(primaryColor: string, position: string): string {
  const primary = safeColor(primaryColor);
  const dark = shade(primary, -0.15);
  const side = position === "bottom-left" ? "left" : "right";

  return `
:host { all: initial; }
.al-root { position: fixed; z-index: 2147483000; ${side}: 20px; bottom: 20px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 14px; line-height: 1.45; color: #0f172a; text-align: left;
  --al-primary: ${primary}; --al-primary-dark: ${dark}; }
.al-root *, .al-root *::before, .al-root *::after { box-sizing: border-box; }

.al-launcher { width: 56px; height: 56px; border: 0; border-radius: 50%; cursor: pointer;
  display: grid; place-items: center; color: #fff; background: var(--al-primary);
  box-shadow: 0 10px 25px rgba(15,23,42,.25); transition: background .15s ease, transform .15s ease; }
.al-launcher:hover { background: var(--al-primary-dark); transform: translateY(-1px); }
.al-launcher:active { transform: translateY(0); }
.al-launcher:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }

.al-panel { width: 380px; max-width: calc(100vw - 40px); height: 560px; max-height: calc(100vh - 40px);
  display: flex; flex-direction: column; overflow: hidden; background: #fff;
  border: 1px solid rgba(15,23,42,.08); border-radius: 16px;
  box-shadow: 0 20px 50px rgba(15,23,42,.25); animation: al-in .16s ease-out; }
@keyframes al-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }

.al-head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px;
  background: var(--al-primary); color: #fff; }
.al-head-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.al-title { font-weight: 600; font-size: 14px; }
.al-subtitle { font-size: 11px; opacity: .85; }
.al-close { flex: 0 0 auto; width: 28px; height: 28px; border: 0; border-radius: 8px; cursor: pointer;
  background: rgba(255,255,255,.15); color: #fff; font-size: 18px; line-height: 1;
  display: grid; place-items: center; }
.al-close:hover { background: rgba(255,255,255,.28); }
.al-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

.al-log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px;
  background: #fff; scrollbar-width: thin; }
.al-msg { max-width: 85%; padding: 9px 12px; border-radius: 14px; white-space: pre-wrap;
  overflow-wrap: anywhere; }
.al-msg-user { align-self: flex-end; background: var(--al-primary); color: #fff;
  border-bottom-right-radius: 4px; }
.al-msg-assistant { align-self: flex-start; background: #f1f5f9; color: #0f172a;
  border-bottom-left-radius: 4px; }
.al-dots { display: inline-flex; gap: 4px; align-items: center; height: 18px; }
.al-dots span { width: 6px; height: 6px; border-radius: 50%; background: #94a3b8;
  animation: al-blink 1.2s infinite ease-in-out; }
.al-dots span:nth-child(2) { animation-delay: .15s; }
.al-dots span:nth-child(3) { animation-delay: .3s; }
@keyframes al-blink { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }

.al-notice { margin: 0; padding: 8px 14px; font-size: 12px; color: #9a3412;
  background: #fff7ed; border-top: 1px solid #fed7aa; }

/* Leadformulier: één kaart tussen de berichten en het invoerveld. */
.al-lead { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
  border-top: 1px solid #e2e8f0; background: #f8fafc; }
/* Honeypot: buiten beeld, maar niet met display:none — sommige bots slaan verborgen velden over. */
.al-hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.al-lead-title { font-size: 13px; font-weight: 600; color: #0f172a; }
.al-lead-hint { font-size: 12px; line-height: 1.45; color: #64748b; }
.al-lead input, .al-lead textarea { width: 100%; padding: 8px 10px; font: inherit; font-size: 13px;
  color: inherit; background: #fff; border: 1px solid #e2e8f0; border-radius: 9px; }
.al-lead textarea { resize: none; }
.al-lead input:focus, .al-lead textarea:focus { outline: none; border-color: var(--al-primary);
  box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.al-lead-row { display: flex; gap: 8px; }
.al-lead-row > * { flex: 1; min-width: 0; }
.al-lead .al-invalid { border-color: #dc2626; }
.al-lead-error { margin: 0; font-size: 12px; color: #b91c1c; }
.al-lead-actions { display: flex; align-items: center; gap: 10px; }
.al-lead-submit { padding: 8px 14px; border: 0; border-radius: 9px; cursor: pointer;
  font: inherit; font-size: 13px; font-weight: 600; color: #fff; background: var(--al-primary); }
.al-lead-submit:hover:not(:disabled) { background: var(--al-primary-dark); }
.al-lead-submit:disabled { opacity: .6; cursor: default; }
.al-lead-skip { padding: 8px 4px; border: 0; background: none; cursor: pointer;
  font: inherit; font-size: 12px; color: #64748b; }
.al-lead-skip:hover { color: #0f172a; }
.al-lead-invite { margin: 0; padding: 6px 14px; font-size: 12px; color: #64748b;
  border-top: 1px solid #e2e8f0; }
.al-lead-link { padding: 0; border: 0; background: none; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--al-primary); text-decoration: underline; }

.al-composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px;
  border-top: 1px solid #e2e8f0; background: #fff; }
.al-input { flex: 1; min-height: 38px; max-height: 120px; resize: none; padding: 9px 11px;
  border: 1px solid #e2e8f0; border-radius: 10px; font: inherit; color: inherit;
  background: #fff; overflow-y: auto; }
.al-input:focus { outline: none; border-color: var(--al-primary);
  box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.al-send { flex: 0 0 auto; width: 38px; height: 38px; border: 0; border-radius: 50%; cursor: pointer;
  background: var(--al-primary); color: #fff; display: grid; place-items: center; }
.al-send:hover:not(:disabled) { background: var(--al-primary-dark); }
.al-send:disabled { opacity: .45; cursor: default; }
.al-send:focus-visible { outline: 2px solid var(--al-primary); outline-offset: 2px; }

@media (max-width: 480px) {
  .al-root { left: 12px; right: 12px; bottom: 12px; }
  .al-panel { width: auto; max-width: none; height: min(78vh, 620px); }
}

@media (prefers-reduced-motion: reduce) {
  .al-root *, .al-root *::before, .al-root *::after {
    animation: none !important; transition: none !important; }
}
`;
}
