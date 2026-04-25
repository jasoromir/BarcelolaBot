const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  return {
    ok: res.ok,
    status: res.status,
    data: res.headers.get('content-type')?.includes('json') ? await res.json() : null,
  };
};

let lastEventId = 0;
let pollHandle = null;

function showLogin() {
  $('#login-panel').classList.remove('hidden');
  $('#main-panel').classList.add('hidden');
}
function showMain() {
  $('#login-panel').classList.add('hidden');
  $('#main-panel').classList.remove('hidden');
  if (!pollHandle) pollHandle = setInterval(refreshAll, 5000);
  refreshAll();
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshEvents(), refreshJobRuns()]);
}

async function refreshStatus() {
  const r = await api('/admin/api/status');
  if (r.status === 401) {
    showLogin();
    return;
  }
  const s = r.data;
  $('#status-content').innerHTML = `
    <div><b>WhatsApp:</b> ${s.wa}${s.phone ? ' (' + s.phone + ')' : ''}</div>
    <div><b>Automations:</b> ${s.paused ? '⏸ Paused' : '▶ Running'}</div>
    <div><b>Broadcast mode:</b> ${s.broadcastMode}${s.broadcastMode === 'test' ? ' → ' + s.testGroupId : ''}</div>
    <div><b>Groups:</b> ${s.groupsCount} active • <b>Tours:</b> ${s.toursCount} • <b>Allowlist:</b> ${s.allowlistMode}</div>
  `;
  const qrCard = $('#qr-card');
  if (s.qrDataUrl) {
    qrCard.classList.remove('hidden');
    $('#qr-img').src = s.qrDataUrl;
  } else {
    qrCard.classList.add('hidden');
  }
  $('#config-summary').innerHTML = `${s.groupsCount} groups, ${s.toursCount} tours, allowlist=${s.allowlistMode}`;
}

async function refreshEvents() {
  const r = await api('/admin/api/events?since=' + lastEventId);
  if (!r.ok) return;
  const events = r.data.events ?? [];
  const pre = $('#event-log');
  for (const ev of events) {
    pre.textContent += `${ev.ts} [${ev.level}] ${ev.source}/${ev.event_type}: ${ev.message}\n`;
    if (ev.id > lastEventId) lastEventId = ev.id;
  }
  pre.scrollTop = pre.scrollHeight;
}

async function refreshJobRuns() {
  const r = await api('/admin/api/jobs/recent');
  if (!r.ok) return;
  const tbody = $('#job-runs tbody');
  tbody.innerHTML = (r.data.runs ?? [])
    .map(
      (j) => `
    <tr>
      <td>${j.job_name}${j.dry_run ? ' (dry)' : ''}</td>
      <td>${j.started_at}</td>
      <td>${j.status}</td>
      <td>${j.tours_count ?? ''}</td>
      <td>${j.groups_sent ?? ''}</td>
      <td>${j.groups_closed ?? ''}</td>
      <td>${j.error ?? ''}</td>
    </tr>
  `,
    )
    .join('');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = new FormData(e.target).get('password');
  const r = await api('/admin/login', { method: 'POST', body: { password } });
  if (r.ok) showMain();
  else $('#login-error').textContent = 'Bad password';
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' });
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  showLogin();
});

$('#btn-pause').addEventListener('click', () => api('/admin/api/pause', { method: 'POST' }).then(refreshStatus));
$('#btn-resume').addEventListener('click', () => api('/admin/api/resume', { method: 'POST' }).then(refreshStatus));
$('#btn-connect').addEventListener('click', () => api('/admin/api/connect', { method: 'POST' }).then(refreshStatus));
$('#btn-disconnect').addEventListener('click', () => api('/admin/api/disconnect', { method: 'POST' }).then(refreshStatus));
$('#btn-close-all').addEventListener('click', () => api('/admin/api/groups/close-all', { method: 'POST' }).then(refreshStatus));
$('#btn-open-all').addEventListener('click', () => api('/admin/api/groups/open-all', { method: 'POST' }).then(refreshStatus));
$('#btn-reload-config').addEventListener('click', async () => {
  const r = await api('/admin/api/config/reload', { method: 'POST' });
  $('#job-output').textContent = r.ok ? 'Config reloaded' : 'Reload failed: ' + (r.data?.error ?? '');
  refreshStatus();
});

document.querySelectorAll('button[data-job]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const job = btn.dataset.job;
    const dryRun = btn.dataset.dry === '1';
    $('#job-output').textContent = `Running ${job} (dry=${dryRun})…\n`;
    const r = await api(`/admin/api/jobs/${job}`, { method: 'POST', body: { dry_run: dryRun } });
    $('#job-output').textContent += JSON.stringify(r.data?.result ?? r.data, null, 2);
    refreshJobRuns();
    refreshEvents();
  });
});

api('/admin/api/status').then((r) => (r.status === 401 ? showLogin() : showMain()));
