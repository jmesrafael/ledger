// confirmsheet.js: the confirmation / reason sheet that replaces the browser's confirm() and prompt() on the manager's money screens. Markup and
// validation only; the app (js/app.js, askSheet) puts it on the page, moves focus into it, and resolves the promise. No accounting here.
// Shared by the app (window.ConfirmSheet) and the tests (require).
(function (root, factory) {
  const C = factory();
  if (typeof module === 'object' && module.exports) module.exports = C; else root.ConfirmSheet = C;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // opts: { title, text (plain, escaped here) | body (html written by the app, never by the server), fields: [{ name, label, type, required, minLength, min, value, hint, options }],
  //         confirmLabel, cancelLabel, danger, info }   info = a single OK button (nothing to decide)
  function html(opts, uid = 'cs') {
    const fields = opts.fields || [];
    const field = (f, i) => {
      const id = `${uid}-f${i}`, hint = f.hint ? `<div class="note" id="${id}-h">${esc(f.hint)}</div>` : '';
      const common = `id="${id}" name="${esc(f.name)}" ${f.required ? 'required aria-required="true"' : ''} aria-describedby="${id}-e${f.hint ? ' ' + id + '-h' : ''}"`;
      const input = f.type === 'select'
        ? `<select ${common}>${(f.options || []).map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(f.value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : f.type === 'textarea'
          ? `<textarea ${common} rows="3" ${f.minLength ? `minlength="${Number(f.minLength)}"` : ''}>${esc(f.value || '')}</textarea>`
          : `<input ${common} type="${f.type === 'number' ? 'number' : 'text'}" ${f.type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${f.min != null ? `min="${Number(f.min)}"` : ''} value="${esc(f.value == null ? '' : f.value)}">`;
      return `<label for="${id}">${esc(f.label)}</label>${input}${hint}<div class="note down" id="${id}-e" role="alert"></div>`;
    };
    const yes = opts.info ? 'OK' : opts.confirmLabel || 'Confirm';
    return `<div class="modal-bg csbg" data-cs="bg"><div class="sheet cssheet" role="${opts.danger ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="${uid}-t" ${opts.text || opts.body ? `aria-describedby="${uid}-b"` : ''}>
      <div class="sheet-head"><div class="sheet-nm" id="${uid}-t">${esc(opts.title)}</div></div>
      ${opts.text || opts.body ? `<div id="${uid}-b" class="csbody">${opts.body ? opts.body : String(opts.text).split('\n').map((p) => `<p class="note">${esc(p)}</p>`).join('')}</div>` : ''}
      <form class="csform" novalidate>${fields.map(field).join('')}
        <div class="btns">${opts.info ? '' : `<button type="button" class="ghost" data-cs="cancel">${esc(opts.cancelLabel || 'Cancel')}</button>`}
          <button type="submit" class="${opts.danger ? 'danger' : ''}" data-cs="ok">${esc(yes)}</button></div></form></div></div>`;
  }

  // values: { name: string }. Returns { ok, errors: { name: message }, values: { name: trimmed string } }
  function validate(fields, values) {
    const errors = {}, out = {};
    for (const f of fields || []) {
      const v = String(values[f.name] == null ? '' : values[f.name]).trim();
      out[f.name] = v;
      if (f.required && !v) errors[f.name] = 'This is needed.';
      else if (v && f.minLength && v.length < f.minLength) errors[f.name] = `Write at least ${f.minLength} characters (now ${v.length}).`;
      else if (v && f.type === 'number' && !Number.isFinite(Number(v))) errors[f.name] = 'Enter a number.';
      else if (v && f.type === 'number' && f.min != null && Number(v) < f.min) errors[f.name] = `Must be at least ${f.min}.`;
    }
    return { ok: Object.keys(errors).length === 0, errors, values: out };
  }
  return { html, validate, esc };
});
