const summaryEls = {
  todayCount: document.querySelector('#todayCount'),
  weekCount: document.querySelector('#weekCount'),
  generatedAt: document.querySelector('#generatedAt'),
  storageMode: document.querySelector('#storageMode'),
  analysisMode: document.querySelector('#analysisMode'),
  summaryList: document.querySelector('#summaryList'),
  typeCounts: document.querySelector('#typeCounts'),
  categoryCounts: document.querySelector('#categoryCounts'),
  recentList: document.querySelector('#recentList')
};

const adminEls = {
  loginForm: document.querySelector('#loginForm'),
  password: document.querySelector('#password'),
  message: document.querySelector('#adminMessage'),
  tools: document.querySelector('#adminTools'),
  search: document.querySelector('#searchInput'),
  type: document.querySelector('#typeFilter'),
  load: document.querySelector('#loadRecordsBtn'),
  table: document.querySelector('#recordsTable'),
  tbody: document.querySelector('#recordsTable tbody')
};

function formatTime(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}

function text(value) {
  return value || '沒有資料';
}

function renderChips(container, counts) {
  const entries = Object.entries(counts || {});
  container.innerHTML = entries.length
    ? entries.map(([key, count]) => `<span class="chip">${key} ${count}</span>`).join('')
    : '<span class="muted">尚無統計</span>';
}

async function loadSummary() {
  const response = await fetch('/api/public/summary');
  const summary = await response.json();

  summaryEls.todayCount.textContent = summary.todayCount;
  summaryEls.weekCount.textContent = summary.weekCount;
  summaryEls.generatedAt.textContent = formatTime(summary.generatedAt);
  summaryEls.storageMode.textContent = `儲存：${summary.storageMode === 'sheets' ? 'Google Sheets' : '本機記憶體'}`;
  summaryEls.analysisMode.textContent = `分析：${summary.analysisMode === 'gemini' ? 'Gemini' : '本機規則'}`;

  summaryEls.summaryList.innerHTML = summary.summaries.length
    ? summary.summaries.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
    : '<li>尚無摘要，等群組開始傳訊息後會出現在這裡。</li>';

  renderChips(summaryEls.typeCounts, summary.typeCounts);
  renderChips(summaryEls.categoryCounts, summary.categoryCounts);

  summaryEls.recentList.innerHTML = summary.recent.length
    ? summary.recent
        .map(
          (item) => `
            <article class="recent-item">
              <div class="recent-meta">${formatTime(item.timestamp)} · ${escapeHtml(item.messageType)} · ${escapeHtml(item.category)}</div>
              <strong>${escapeHtml(item.aiSummary || item.driveFileName || '未摘要')}</strong>
              <span>${escapeHtml(item.content || item.driveFileName || '非文字訊息')}</span>
            </article>
          `
        )
        .join('')
    : '<p class="muted">尚無最近項目。</p>';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function login(event) {
  event.preventDefault();
  const response = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminEls.password.value })
  });
  if (!response.ok) {
    adminEls.message.textContent = '登入失敗，請確認管理密碼。';
    return;
  }
  adminEls.message.textContent = '已登入，可查看完整紀錄。';
  adminEls.tools.classList.remove('hidden');
  adminEls.table.classList.remove('hidden');
  await loadRecords();
}

async function loadRecords() {
  const params = new URLSearchParams();
  if (adminEls.search.value) params.set('search', adminEls.search.value);
  if (adminEls.type.value) params.set('type', adminEls.type.value);
  const response = await fetch(`/api/admin/records?${params.toString()}`);
  if (!response.ok) {
    adminEls.message.textContent = '讀取完整紀錄失敗，可能需要重新登入。';
    return;
  }
  const payload = await response.json();
  adminEls.message.textContent = `共 ${payload.count} 筆符合條件的紀錄。`;
  adminEls.tbody.innerHTML = payload.records.map(renderRecordRow).join('');
}

function renderRecordRow(record) {
  return `
    <tr>
      <td>${formatTime(record.timestamp)}</td>
      <td>${escapeHtml(record.messageType)}</td>
      <td>${escapeHtml(record.category)}</td>
      <td>${escapeHtml(record.content)}</td>
      <td>${escapeHtml(record.aiSummary)}</td>
      <td>${renderMedia(record)}</td>
    </tr>
  `;
}

function renderMedia(record) {
  if (!record.mediaProxyUrl) return escapeHtml(record.driveFileName || '');
  if (record.mimeType?.startsWith('image/')) {
    return `<img class="media-preview" src="${record.mediaProxyUrl}" alt="${escapeHtml(record.driveFileName)}" loading="lazy" />`;
  }
  return `<a class="file-link" href="${record.mediaProxyUrl}" target="_blank" rel="noreferrer">${escapeHtml(record.driveFileName || '開啟檔案')}</a>`;
}

document.querySelector('#refreshBtn').addEventListener('click', loadSummary);
adminEls.loginForm.addEventListener('submit', login);
adminEls.load.addEventListener('click', loadRecords);

loadSummary().catch((error) => {
  console.error(error);
  summaryEls.summaryList.innerHTML = '<li>讀取摘要失敗，請確認後端服務是否啟動。</li>';
});
