// Browser side of the Gatehouse console: forms, live updates, tabs, filters and WebAuthn ceremonies.
(() => {
  const csrf = document.querySelector('meta[name="csrf"]').content;
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser;
  const $ = (id) => document.getElementById(id);

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const status = (id, text) => {
    const el = $(id) || $('job-status') || $('gate-status');
    if (el) el.textContent = text;
  };
  const passkeyError = (err) => (err && err.name === 'NotAllowedError' ? 'Cancelled, or the passkey prompt timed out.' : err.message);
  const goToRun = (r) => {
    if (r && r.runId) location.href = `/runs/${encodeURIComponent(r.runId)}`;
    else location.href = '/';
  };

  // ---- gate decisions ----------------------------------------------------------------------------
  for (const button of document.querySelectorAll('[data-decide]')) {
    button.addEventListener('click', async () => {
      const runId = button.dataset.run;
      const all = document.querySelectorAll('[data-decide]');
      all.forEach((b) => (b.disabled = true));
      status('gate-status', 'Confirm with your passkey…');
      try {
        const optionsJSON = await post(`/api/gates/${runId}/options`, { decision: button.dataset.decide });
        const response = await startAuthentication({ optionsJSON });
        status('gate-status', 'Recording your decision…');
        const r = await post(`/api/gates/${runId}/decide`, { response, reason: $('reason') ? $('reason').value : '' });
        status('gate-status', r.url ? `Posted: ${r.url}` : r.status === 'already-published' ? 'It was already posted.' : r.job ? 'Approved. The run continues…' : `${r.status}${r.reason ? `: ${r.reason}` : ''}`);
        setTimeout(() => location.reload(), 1200);
      } catch (err) {
        status('gate-status', `Not recorded: ${passkeyError(err)}`);
        all.forEach((b) => (b.disabled = false));
      }
    });
  }

  for (const button of document.querySelectorAll('[data-publish]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const r = await post(`/api/runs/${button.dataset.publish}/publish`, {});
        status('gate-status', r.url ? `Posted: ${r.url}` : `${r.status}${r.reason ? `: ${r.reason}` : ''}`);
        if (r.url) setTimeout(() => location.reload(), 1200);
      } catch (err) {
        status('gate-status', err.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  for (const button of document.querySelectorAll('[data-resume]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        goToRun(await post(`/api/runs/${button.dataset.resume}/resume`, {}));
      } catch (err) {
        status('job-status', err.message);
        button.disabled = false;
      }
    });
  }

  // ---- start jobs (Review on a PR, environment checks) ----------------------------------------------
  for (const button of document.querySelectorAll('[data-job]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const label = button.textContent;
      button.textContent = 'Starting…';
      try {
        const body = { repo: button.dataset.repo, pr: Number(button.dataset.pr), target: button.dataset.target };
        goToRun(await post(`/api/jobs/${button.dataset.job}`, body));
      } catch (err) {
        status('job-status', err.message);
        button.textContent = label;
        button.disabled = false;
      }
    });
  }

  // ---- forms ----------------------------------------------------------------------------------------
  const valueOf = (el) => {
    if (el.type === 'checkbox') return el.checked;
    if (el.dataset.kind === 'json') return JSON.parse(el.value);
    return el.value;
  };
  const changed = (el) => {
    if (el.type === 'checkbox') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') return el.value !== ([...el.options].find((o) => o.defaultSelected) || el.options[0]).value;
    return el.value !== el.defaultValue;
  };

  for (const form of document.querySelectorAll('form[data-form]')) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const kind = form.dataset.form;
      const data = Object.fromEntries(new FormData(form).entries());
      const submit = form.querySelector('button.primary') || form.querySelector('button');
      if (submit) submit.disabled = true;
      try {
        if (kind === 'ticket' || kind === 'legacy' || kind === 'branch-review') {
          status('job-status', 'Starting…');
          goToRun(await post(`/api/jobs/${kind}`, data));
        } else if (kind === 'repo') {
          status('job-status', 'Copying the repository (this can take a minute for large ones)…');
          const r = await post('/api/repos', data);
          status('job-status', `Added ${r.name}.`);
          setTimeout(() => location.reload(), 600);
        } else if (kind === 'answer' || kind === 'retry') {
          goToRun(await post(`/api/runs/${form.dataset.run}/${kind}`, data));
        } else if (kind === 'settings') {
          const patch = {};
          for (const el of form.querySelectorAll('input[name], textarea[name], select[name]')) {
            if (!changed(el)) continue;
            try {
              patch[el.name] = valueOf(el);
            } catch {
              throw new Error(`${el.name}: not valid (numbers and JSON must be well-formed)`);
            }
          }
          if (!Object.keys(patch).length) throw new Error('Nothing changed.');
          const optionsJSON = await post('/api/settings/options', { patch });
          status('settings-status', 'Confirm with your passkey…');
          const response = await startAuthentication({ optionsJSON });
          const r = await post('/api/settings/save', { patch, response });
          status('settings-status', `Saved. ${r.note || ''}`);
          setTimeout(() => location.reload(), 1500);
        } else if (kind === 'secret') {
          const optionsJSON = await post('/api/secrets/options', { name: data.name });
          status('settings-status', 'Confirm with your passkey…');
          const response = await startAuthentication({ optionsJSON });
          await post('/api/secrets/save', { name: data.name, value: data.value, response });
          form.reset();
          status('settings-status', `Saved ${data.name}.`);
          setTimeout(() => location.reload(), 900);
        }
      } catch (err) {
        status(kind === 'settings' || kind === 'secret' ? 'settings-status' : 'job-status', passkeyError(err));
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  // ---- tabs on the run page ---------------------------------------------------------------------------
  const tabs = document.querySelectorAll('[data-tab]');
  const openTab = (name) => {
    let found = false;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      found = found || on;
      t.setAttribute('aria-selected', String(on));
    }
    if (!found) return;
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    try {
      history.replaceState(null, '', `#tab-${name}`);
    } catch {
      // ignore
    }
  };
  for (const t of tabs) t.addEventListener('click', () => openTab(t.dataset.tab));
  for (const a of document.querySelectorAll('[data-open-tab]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openTab(a.dataset.openTab);
    });
  }
  if (tabs.length && location.hash.startsWith('#tab-')) openTab(location.hash.slice(5));

  // ---- findings filters ---------------------------------------------------------------------------------
  const applyFilters = () => {
    const on = new Set([...document.querySelectorAll('[data-filter]')].filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.filter));
    const dim = $('show-dim') ? $('show-dim').checked : false;
    for (const f of document.querySelectorAll('.finding')) {
      const posted = f.dataset.posted === 'true';
      f.hidden = posted ? !on.has(f.dataset.sev) : !dim;
    }
  };
  for (const chip of document.querySelectorAll('[data-filter]')) {
    chip.addEventListener('click', () => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
      applyFilters();
    });
  }
  if ($('show-dim')) $('show-dim').addEventListener('change', applyFilters);
  if (document.querySelector('.finding')) applyFilters();

  const showMc = $('show-mc');
  if (showMc) showMc.addEventListener('change', () => document.querySelector('table.trace').classList.toggle('hide-mc', !showMc.checked));

  // ---- live updates -----------------------------------------------------------------------------------------
  // Elements with data-live poll a JSON {key, html}: html replaces the content; a new key (the run
  // finished, a job started) reloads the page so everything else is current too.
  for (const el of document.querySelectorAll('[data-live]')) {
    let key = el.dataset.liveKey;
    const tick = async () => {
      try {
        const r = await (await fetch(el.dataset.live)).json();
        if (key === undefined) key = r.key;
        else if (r.key !== key) return location.reload();
        if (r.html && el.id === 'progress') el.innerHTML = r.html;
        else if (r.html && el.id === 'live') el.innerHTML = `<h2>In progress</h2>${r.html}`;
      } catch {
        // console restarting; try again
      }
    };
    setInterval(tick, 4000);
    tick();
  }

  // ---- passkey enrollment ------------------------------------------------------------------------------------
  const enroll = $('enroll');
  if (enroll) {
    enroll.addEventListener('click', async () => {
      const code = $('enroll-code').value.trim().toUpperCase();
      const name = $('enroll-name').value.trim() || 'approver';
      if (!code) return status('enroll-status', 'Enter the code printed by `gatehouse approver enroll`.');
      enroll.disabled = true;
      try {
        let optionsJSON;
        try {
          optionsJSON = await post('/api/enroll/options', { code, name });
        } catch (err) {
          if (!/needs-authorization/.test(err.message)) throw err;
          status('enroll-status', 'An existing passkey must confirm this. Confirm with it now…');
          const authOptions = await post('/api/enroll/authorize-options', { code });
          await post('/api/enroll/authorize', { code, response: await startAuthentication({ optionsJSON: authOptions }) });
          optionsJSON = await post('/api/enroll/options', { code, name });
        }
        status('enroll-status', 'Create the passkey on this device…');
        await post('/api/enroll/verify', { code, response: await startRegistration({ optionsJSON }) });
        status('enroll-status', 'Registered. You can now approve.');
        setTimeout(() => location.reload(), 1000);
      } catch (err) {
        const msg = /code is (unknown|expired|used)/.test(err.message) ? 'That code is not valid any more. Run `gatehouse approver enroll` again for a new one.' : passkeyError(err);
        status('enroll-status', `Not registered: ${msg}`);
        enroll.disabled = false;
      }
    });
  }
})();
