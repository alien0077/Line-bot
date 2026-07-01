const summaryEls = {
  todayCount: document.querySelector('#todayCount'),
  weekCount: document.querySelector('#weekCount'),
  generatedAt: document.querySelector('#generatedAt'),
  storageMode: document.querySelector('#storageMode'),
  analysisMode: document.querySelector('#analysisMode'),
  summaryList: document.querySelector('#summaryList'),
  groupCounts: document.querySelector('#groupCounts'),
  topicCounts: document.querySelector('#topicCounts'),
  topicList: document.querySelector('#topicList'),
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
  group: document.querySelector('#groupFilter'),
  topic: document.querySelector('#topicFilter'),
  type: document.querySelector('#typeFilter'),
  load: document.querySelector('#loadRecordsBtn'),
  threadList: document.querySelector('#recordsThreadList'),
  table: document.querySelector('#recordsTable'),
  tbody: document.querySelector('#recordsTable tbody')
};

const threadsPerPage = 25;
let adminThreadPage = 1;
let currentThreads = [];

function formatTime(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}

function renderChips(container, counts) {
  const entries = Object.entries(counts || {});
  container.innerHTML = entries.length
    ? entries.map(([key, count]) => `<span class="chip" title="${escapeHtml(key)}">${escapeHtml(key)} ${count}</span>`).join('')
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

  renderChips(summaryEls.groupCounts, summary.groupCounts);
  renderChips(summaryEls.topicCounts, summary.topicCounts);
  renderChips(summaryEls.typeCounts, summary.typeCounts);
  renderChips(summaryEls.categoryCounts, summary.categoryCounts);

  summaryEls.topicList.innerHTML = summary.topics.length
    ? summary.topics
        .map(
          (topic) => `
            <article class="topic-item">
              <div class="topic-title-row">
                <strong>${escapeHtml(topic.topicTitle)}</strong>
                <span class="chip">${topic.count} 則</span>
              </div>
              <div class="recent-meta">${formatTime(topic.lastMessageAt)} · ${escapeHtml(topic.groupName)}</div>
              <p>${escapeHtml(topic.topicSummary || '尚無主題摘要')}</p>
            </article>
          `
        )
        .join('')
    : '<p class="muted">尚無主題討論串。</p>';

  summaryEls.recentList.innerHTML = summary.recent.length
    ? summary.recent
        .map(
          (item) => `
            <article class="recent-item">
              <div class="recent-meta">${formatTime(item.timestamp)} · ${escapeHtml(item.groupName)} · ${escapeHtml(item.topicTitle)} · ${escapeHtml(item.messageType)} · ${escapeHtml(item.category)}</div>
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
  setAdminAuthenticated(true);
  adminEls.message.textContent = '已登入，可查看完整紀錄。';
  await loadRecords();
}

function setAdminAuthenticated(isAuthenticated) {
  adminEls.loginForm.classList.toggle('hidden', isAuthenticated);
  adminEls.tools.classList.toggle('hidden', !isAuthenticated);
  adminEls.threadList.classList.toggle('hidden', !isAuthenticated);
  adminEls.table.classList.add('hidden');
  if (isAuthenticated) adminEls.password.value = '';
}

function renderGroupOptions(groups, selectedGroupId) {
  const options = ['<option value="">全部群組</option>'];
  for (const group of groups || []) {
    const selected = group.groupId === selectedGroupId ? ' selected' : '';
    options.push(
      `<option value="${escapeHtml(group.groupId)}"${selected}>${escapeHtml(group.groupName)} (${group.count})</option>`
    );
  }
  adminEls.group.innerHTML = options.join('');
}

function renderTopicOptions(topics, selectedTopicId) {
  const options = ['<option value="">全部主題</option>'];
  for (const topic of topics || []) {
    const selected = topic.topicId === selectedTopicId ? ' selected' : '';
    options.push(
      `<option value="${escapeHtml(topic.topicId)}"${selected}>${escapeHtml(topic.topicTitle)} (${topic.count})</option>`
    );
  }
  adminEls.topic.innerHTML = options.join('');
}

async function loadRecords(options = {}) {
  const params = new URLSearchParams();
  const selectedGroupId = adminEls.group.value;
  const selectedTopicId = adminEls.topic.value;
  if (adminEls.search.value) params.set('search', adminEls.search.value);
  if (selectedGroupId) params.set('groupId', selectedGroupId);
  if (selectedTopicId) params.set('topicId', selectedTopicId);
  if (adminEls.type.value) params.set('type', adminEls.type.value);
  const response = await fetch(`/api/admin/records?${params.toString()}`);
  if (!response.ok) {
    setAdminAuthenticated(false);
    if (!options.silent) {
      adminEls.message.textContent = response.status === 401 ? '登入已過期，請重新輸入管理密碼。' : '讀取完整紀錄失敗。';
    }
    return false;
  }
  const payload = await response.json();
  setAdminAuthenticated(true);
  renderGroupOptions(payload.groups, selectedGroupId);
  renderTopicOptions(payload.topics, selectedTopicId);
  currentThreads = groupRecordsByTopic(payload.records);
  adminThreadPage = 1;
  adminEls.message.textContent = `共 ${payload.count} 筆符合條件的紀錄，整理成 ${currentThreads.length} 個討論串。`;
  renderThreadPage();
  adminEls.tbody.innerHTML = '';
  return true;
}

function groupRecordsByTopic(records) {
  const map = new Map();
  for (const record of records || []) {
    const key = record.topicId || `${record.groupId}-${record.category}`;
    const existing = map.get(key);
    if (existing) {
      existing.records.push(record);
      existing.count += 1;
      if (Date.parse(record.timestamp) > Date.parse(existing.lastMessageAt)) existing.lastMessageAt = record.timestamp;
    } else {
      map.set(key, {
        id: key,
        topicTitle: record.topicTitle || '未分類主題',
        topicSummary: record.topicSummary || record.aiSummary || record.content || record.driveFileName || '',
        groupName: record.groupName,
        groupId: record.groupId,
        count: 1,
        lastMessageAt: record.timestamp,
        records: [record]
      });
    }
  }
  return [...map.values()]
    .map((thread) => ({
      ...thread,
      records: thread.records.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    }))
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

function renderThreadPage() {
  if (!currentThreads.length) {
    adminEls.threadList.innerHTML = '<p class="muted">沒有符合條件的紀錄。</p>';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(currentThreads.length / threadsPerPage));
  adminThreadPage = Math.min(Math.max(adminThreadPage, 1), totalPages);
  const start = (adminThreadPage - 1) * threadsPerPage;
  const pageThreads = currentThreads.slice(start, start + threadsPerPage);
  const controls = renderThreadPagination(totalPages);
  adminEls.threadList.innerHTML = [
    controls,
    ...pageThreads.map((thread) => renderRecordThread(thread, adminEls.topic.value || pageThreads.length === 1)),
    controls
  ].join('');
}

function renderThreadPagination(totalPages) {
  if (totalPages <= 1) return '';
  return `
    <nav class="thread-pagination" aria-label="討論串分頁">
      <button type="button" data-thread-page="${adminThreadPage - 1}"${adminThreadPage === 1 ? ' disabled' : ''}>上一頁</button>
      <span>第 ${adminThreadPage} / ${totalPages} 頁 · 每頁 ${threadsPerPage} 個討論串</span>
      <button type="button" data-thread-page="${adminThreadPage + 1}"${adminThreadPage === totalPages ? ' disabled' : ''}>下一頁</button>
    </nav>
  `;
}

function renderRecordThread(thread, open) {
  return `
    <details class="record-thread"${open ? ' open' : ''}>
      <summary>
        <span>
          <strong>${escapeHtml(thread.topicTitle)}</strong>
          <small>${formatTime(thread.lastMessageAt)} · ${escapeHtml(thread.groupName)}</small>
        </span>
        <span class="chip">${thread.count} 則</span>
      </summary>
      <p class="thread-summary">${escapeHtml(thread.topicSummary || '尚無主題摘要')}</p>
      <div class="thread-records">
        ${thread.records.map(renderRecordCard).join('')}
      </div>
    </details>
  `;
}

function renderRecordCard(record) {
  return `
    <article class="record-card">
      <div class="record-card-head">
        <span>${formatTime(record.timestamp)}</span>
        <span class="chip">${escapeHtml(record.messageType)}</span>
        <span class="chip">${escapeHtml(record.category)}</span>
      </div>
      <p class="record-content">${escapeHtml(record.content || record.driveFileName || '非文字訊息')}</p>
      ${record.aiSummary ? `<p class="record-summary">${escapeHtml(record.aiSummary)}</p>` : ''}
      ${record.mediaProxyUrl ? `<div class="record-media">${renderMedia(record)}</div>` : ''}
    </article>
  `;
}

function renderMedia(record) {
  if (!record.mediaProxyUrl) return escapeHtml(record.driveFileName || '');
  if (record.mimeType?.startsWith('image/')) {
    return `
      <a class="media-link" href="${record.mediaProxyUrl}" target="_blank" rel="noreferrer">
        <img class="media-preview" src="${record.mediaProxyUrl}" alt="${escapeHtml(record.driveFileName)}" loading="lazy" />
        <span>開啟圖片</span>
      </a>
    `;
  }
  if (record.mimeType?.startsWith('video/')) {
    return `<video class="media-preview media-video" src="${record.mediaProxyUrl}" controls preload="metadata"></video>`;
  }
  if (record.mimeType?.startsWith('audio/')) {
    return `<audio class="media-audio" src="${record.mediaProxyUrl}" controls preload="metadata"></audio>`;
  }
  return `<a class="file-link" href="${record.mediaProxyUrl}" target="_blank" rel="noreferrer">${escapeHtml(record.driveFileName || '開啟檔案')}</a>`;
}

document.querySelector('#refreshBtn').addEventListener('click', loadSummary);
adminEls.loginForm.addEventListener('submit', login);
adminEls.load.addEventListener('click', loadRecords);
adminEls.group.addEventListener('change', loadRecords);
adminEls.topic.addEventListener('change', loadRecords);
adminEls.type.addEventListener('change', loadRecords);
adminEls.threadList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-thread-page]');
  if (!button || button.hasAttribute('disabled')) return;
  adminThreadPage = Number(button.dataset.threadPage);
  renderThreadPage();
  adminEls.threadList.scrollIntoView({ block: 'start' });
});

loadSummary().catch((error) => {
  console.error(error);
  summaryEls.summaryList.innerHTML = '<li>讀取摘要失敗，請確認後端服務是否啟動。</li>';
});
loadRecords({ silent: true }).catch((error) => {
  console.error(error);
});
