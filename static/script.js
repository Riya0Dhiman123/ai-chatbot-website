// ─── State ───────────────────────────────────────────────────
const state = {
    currentConversationId: null,
    messages: [],
    isGenerating: false,
    abortController: null,
    conversations: [],
    searchQuery: '',
    theme: localStorage.getItem('chat-theme') || 'dark',
    emojis: ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😗','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','😮','😯','😲','😳','🥺','😢','😭','😤','😠','😡','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','💖','💗','💓','💞','💕','💟','❣️','💔','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💋','👋','✋','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💪','🦵','🦶','👂','🦻','👃','🧠','🦷','👀','👅','👄']
};

const $ = (id) => document.getElementById(id);
const dom = {
    sidebar: $('sidebar'), conversationList: $('conversation-list'),
    newChatBtn: $('new-chat-btn'), searchInput: $('search-conversations'),
    modelSelect: $('model-select'), welcomeScreen: $('welcome-screen'),
    messagesArea: $('messages-area'), messagesContainer: $('messages-container'),
    messageInput: $('message-input'), sendBtn: $('send-btn'),
    stopBtnContainer: $('stop-btn-container'), stopBtn: $('stop-btn'),
    chatContainer: $('chat-container'), mainContent: $('main-content'),
    mobileMenuBtn: $('mobile-menu-btn'), sidebarBackdrop: $('sidebar-backdrop'),
    themeBtn: $('theme-btn'), themeBtnMobile: $('theme-btn-mobile'),
    profileBtn: $('profile-btn'), settingsBtn: $('settings-btn'), logoutBtn: $('logout-btn'),
    emojiBtn: $('emoji-btn'), emojiPicker: $('emoji-picker'), emojiGrid: $('emoji-grid'),
    attachBtn: $('attach-btn'), fileInput: $('file-input'), dragZone: $('drag-zone'),
    toast: $('toast'), topBar: $('top-bar'),
};

marked.setOptions({ breaks: true, gfm: true });

// ─── Theme ──────────────────────────────────────────────────
function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('chat-theme', theme);
}

function toggleTheme() {
    const newTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    showToast(`${newTheme === 'dark' ? '🌙' : '☀️'} ${newTheme.charAt(0).toUpperCase() + newTheme.slice(1)} mode`);
}

// ─── Toast ──────────────────────────────────────────────────
function showToast(text, duration = 2000) {
    dom.toast.textContent = text;
    dom.toast.classList.add('show');
    clearTimeout(dom.toast._hide);
    dom.toast._hide = setTimeout(() => dom.toast.classList.remove('show'), duration);
}

// ─── Emoji Picker ──────────────────────────────────────────
function buildEmojiPicker() {
    dom.emojiGrid.innerHTML = state.emojis.map(e =>
        `<div class="emoji-item" data-emoji="${e}">${e}</div>`
    ).join('');
    dom.emojiGrid.querySelectorAll('.emoji-item').forEach(el => {
        el.addEventListener('click', () => {
            dom.messageInput.value += el.dataset.emoji;
            dom.messageInput.focus();
            autoResizeTextarea();
            updateSendButton();
        });
    });
}
dom.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.emojiPicker.classList.toggle('show');
});
document.addEventListener('click', (e) => {
    if (!dom.emojiPicker.contains(e.target) && e.target !== dom.emojiBtn) {
        dom.emojiPicker.classList.remove('show');
    }
});

// ─── File Upload ────────────────────────────────────────────
dom.attachBtn.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', uploadFile);

function uploadFile() {
    const file = dom.fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    showToast(`📎 Uploading ${file.name}...`, 3000);
    fetch('/api/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
            if (data.ok) {
                dom.messageInput.value += `\n[Attached: ${data.filename}]\n${data.content || ''}`;
                showToast(`✅ ${data.filename} attached`);
                autoResizeTextarea();
                updateSendButton();
            } else showToast(`❌ ${data.error}`);
        })
        .catch(() => showToast('❌ Upload failed'));
    dom.fileInput.value = '';
}

// Drag and drop
let dragCounter = 0;
dom.chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault(); dragCounter++;
    dom.dragZone.classList.add('show');
});
dom.chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault(); dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dom.dragZone.classList.remove('show'); }
});
dom.chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault(); dom.dragZone.classList.add('dragover');
});
dom.chatContainer.addEventListener('drop', (e) => {
    e.preventDefault(); dom.dragZone.classList.remove('show', 'dragover'); dragCounter = 0;
    const files = e.dataTransfer.files;
    if (files.length) { dom.fileInput.files = files; uploadFile(); }
});
dom.dragZone.addEventListener('click', () => dom.fileInput.click());

// ─── API Calls ──────────────────────────────────────────────
async function fetchConversations() {
    try {
        const res = await fetch('/api/conversations');
        const data = await res.json();
        state.conversations = data.conversations || [];
        renderConversationList();
    } catch (e) { console.error(e); }
}

async function getConversation(id) {
    try {
        const res = await fetch(`/api/conversations/${id}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { return null; }
}

async function deleteConversation(id) {
    try {
        const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
        return res.ok;
    } catch (e) { return false; }
}

async function fetchProfile() {
    try {
        const res = await fetch('/api/profile');
        if (!res.ok) return;
        const data = await res.json();
        $('profile-username').value = data.username || '';
        $('profile-email').value = data.email || '';
        $('profile-theme').value = data.theme || 'dark';
        if (data.avatar) {
            $('modal-avatar').src = `/uploads/${data.avatar}`;
        } else {
            $('modal-avatar').src = '';
        }
        applyTheme(data.theme || 'dark');
    } catch (e) { console.error(e); }
}

// ─── Profile ────────────────────────────────────────────────
dom.profileBtn.addEventListener('click', () => {
    fetchProfile();
    openModal('profile-modal');
});
$('avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    try {
        const res = await fetch('/api/profile/avatar', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.ok) {
            $('modal-avatar').src = `/uploads/${data.avatar}?_=${Date.now()}`;
            showToast('✅ Avatar updated');
        }
    } catch (e) { showToast('❌ Failed to upload avatar'); }
});

async function saveProfile() {
    const data = {
        username: $('profile-username').value,
        theme: $('profile-theme').value,
        password: $('profile-password').value,
    };
    try {
        const res = await fetch('/api/profile', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json();
        if (json.ok) {
            applyTheme(json.theme || state.theme);
            showToast('✅ Profile saved');
            closeModal('profile-modal');
            $('profile-password').value = '';
        } else showToast(`❌ ${json.error}`);
    } catch (e) { showToast('❌ Failed to save'); }
}

// ─── Settings ────────────────────────────────────────────────
dom.settingsBtn.addEventListener('click', () => openModal('settings-modal'));
$('settings-temp').addEventListener('input', () => {
    $('settings-temp-val').textContent = $('settings-temp').value;
});

function saveSettings() {
    const model = $('settings-model').value;
    dom.modelSelect.value = model;
    showToast(`✅ Default model set to ${model}`);
    closeModal('settings-modal');
}

// ─── Modals ─────────────────────────────────────────────────
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
document.querySelector('.modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('show');
});

// ─── Logout ─────────────────────────────────────────────────
dom.logoutBtn.addEventListener('click', () => {
    window.location.href = '/logout';
});

// ─── Theme toggle handlers ──────────────────────────────────
dom.themeBtn.addEventListener('click', toggleTheme);
dom.themeBtnMobile.addEventListener('click', toggleTheme);

// ─── Mobile sidebar ─────────────────────────────────────────
dom.mobileMenuBtn.addEventListener('click', () => {
    dom.sidebar.classList.toggle('open');
    dom.sidebarBackdrop.classList.toggle('show');
});
dom.sidebarBackdrop.addEventListener('click', () => {
    dom.sidebar.classList.remove('open');
    dom.sidebarBackdrop.classList.remove('show');
});

// ─── Render Markdown ────────────────────────────────────────
function renderMarkdown(text) {
    const rawHtml = marked.parse(text);
    const cleanHtml = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true }, ADD_TAGS: ['code', 'pre'], ADD_ATTR: ['class', 'id'] });
    const container = document.createElement('div');
    container.innerHTML = cleanHtml;
    container.querySelectorAll('pre').forEach((pre) => {
        const code = pre.querySelector('code');
        if (!code) return;
        let lang = '';
        const m = code.className.match(/language-(\w+)/);
        if (m) lang = m[1];
        const header = document.createElement('div');
        header.className = 'code-header';
        const langSpan = document.createElement('span');
        langSpan.className = 'code-lang';
        langSpan.textContent = lang || 'code';
        header.appendChild(langSpan);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(code.textContent || code.innerText).then(() => {
                copyBtn.textContent = 'Copied!'; copyBtn.classList.add('copied');
                setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
            }).catch(() => showToast('Failed to copy'));
        };
        header.appendChild(copyBtn);
        pre.insertBefore(header, pre.firstChild);
    });
    return container.innerHTML;
}

// ─── Message Elements ───────────────────────────────────────
function createMessageElement(role, content, messageId) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}`;
    wrapper.dataset.messageId = messageId || Date.now();
    const isUser = role === 'user';

    const avatar = document.createElement('div');
    avatar.className = `message-avatar ${isUser ? 'user-avatar' : 'ai-avatar'}`;
    avatar.textContent = isUser ? 'U' : 'AI';
    wrapper.appendChild(avatar);

    const contentDiv = document.createElement('div');
    contentDiv.className = `message-content ${isUser ? 'user-content' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isUser ? 'user-bubble' : 'ai-bubble'}`;
    bubble.textContent = isUser ? content : '';
    if (!isUser) bubble.innerHTML = renderMarkdown(content);
    contentDiv.appendChild(bubble);

    if (!isUser) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `
            <button title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
            <button title="Regenerate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg></button>`;
        actions.querySelector('button:first-child').onclick = () => {
            navigator.clipboard.writeText(content).then(() => showToast('Copied!'));
        };
        actions.querySelector('button:last-child').onclick = regenerateLastResponse;
        contentDiv.appendChild(actions);
    }
    wrapper.appendChild(contentDiv);
    return wrapper;
}

function addMessageToChat(role, content, animate = true) {
    const el = createMessageElement(role, content);
    if (!animate) el.style.animation = 'none';
    dom.messagesContainer.appendChild(el);
    scrollToBottom();
    return el;
}

function updateAiMessage(messageId, content) {
    const wrapper = dom.messagesContainer.querySelector(`[data-message-id="${messageId}"]`);
    if (wrapper) {
        const bubble = wrapper.querySelector('.ai-bubble');
        if (bubble) bubble.innerHTML = renderMarkdown(content);
    }
}

function scrollToBottom() {
    requestAnimationFrame(() => { dom.chatContainer.scrollTop = dom.chatContainer.scrollHeight; });
}

function showTypingIndicator() {
    hideTypingIndicator();
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper'; wrapper.id = 'typing-indicator';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar ai-avatar'; avatar.textContent = 'AI';
    wrapper.appendChild(avatar);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    for (let i = 0; i < 3; i++) { const d = document.createElement('div'); d.className = 'typing-dot'; dots.appendChild(d); }
    contentDiv.appendChild(dots);
    wrapper.appendChild(contentDiv);
    dom.messagesContainer.appendChild(wrapper);
    scrollToBottom();
}

function hideTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

// ─── Conversation UI ────────────────────────────────────────
function renderConversationList() {
    let filtered = state.conversations;
    if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        filtered = state.conversations.filter(c => c.title.toLowerCase().includes(q));
    }
    if (!filtered.length) {
        dom.conversationList.innerHTML = `<div class="loading-conversations" style="border:none"><span>${state.searchQuery ? 'No results' : 'No conversations yet'}</span></div>`;
        return;
    }
    dom.conversationList.innerHTML = '';
    filtered.forEach(conv => {
        const item = document.createElement('div');
        item.className = `conversation-item${conv.id === state.currentConversationId ? ' active' : ''}`;
        item.dataset.convId = conv.id;
        item.innerHTML = `
            <div class="conv-icon">💬</div>
            <div class="conv-info"><div class="conv-title">${escapeHtml(conv.title)}</div><div class="conv-meta">${conv.message_count || 0} messages</div></div>
            <button class="conv-delete" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>`;
        item.querySelector('.conv-delete').addEventListener('click', (e) => { e.stopPropagation(); handleDeleteConversation(conv.id); });
        item.addEventListener('click', () => switchToConversation(conv.id));
        dom.conversationList.appendChild(item);
    });
}

function escapeHtml(t) {
    const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}

function newConversation() {
    state.currentConversationId = null;
    state.messages = [];
    dom.messagesContainer.innerHTML = '';
    dom.messagesArea.style.display = 'none';
    dom.welcomeScreen.style.display = 'flex';
    dom.messageInput.value = '';
    dom.messageInput.focus();
    updateSendButton();
    document.querySelectorAll('.conversation-item.active').forEach(el => el.classList.remove('active'));
}

async function switchToConversation(id) {
    if (state.isGenerating) return;
    const conv = await getConversation(id);
    if (!conv) { showToast('Conversation not found'); return; }
    state.currentConversationId = conv.id;
    state.messages = conv.messages || [];
    dom.welcomeScreen.style.display = 'none';
    dom.messagesArea.style.display = 'block';
    dom.messagesContainer.innerHTML = '';
    state.messages.forEach(msg => addMessageToChat(msg.role, msg.content, false));
    document.querySelectorAll('.conversation-item.active').forEach(el => el.classList.remove('active'));
    const active = document.querySelector(`.conversation-item[data-conv-id="${id}"]`);
    if (active) active.classList.add('active');
    scrollToBottom();
}

async function handleDeleteConversation(id) {
    if (await deleteConversation(id)) {
        state.conversations = state.conversations.filter(c => c.id !== id);
        renderConversationList();
        if (state.currentConversationId === id) newConversation();
        showToast('Conversation deleted');
    } else showToast('Failed to delete');
}

// ─── Streaming ──────────────────────────────────────────────
async function sendMessage(message, conversationId = null) {
    if (state.isGenerating) return;
    const model = dom.modelSelect.value;
    addMessageToChat('user', message);
    dom.welcomeScreen.style.display = 'none';
    dom.messagesArea.style.display = 'block';
    showTypingIndicator();
    dom.stopBtnContainer.style.display = 'block';
    const abortController = new AbortController();
    state.abortController = abortController;
    state.isGenerating = true;
    updateSendButton();
    disableInput(true);
    let aiMessageId = Date.now();
    let fullContent = '';

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, conversation_id: conversationId || '', model }),
            signal: abortController.signal,
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        hideTypingIndicator();
        const aiEl = addMessageToChat('assistant', '', false);
        aiEl.dataset.messageId = aiMessageId;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'chunk') { fullContent += data.content; updateAiMessage(aiMessageId, fullContent); scrollToBottom(); }
                    else if (data.type === 'done') {
                        fullContent = data.full_content || fullContent;
                        updateAiMessage(aiMessageId, fullContent);
                        state.currentConversationId = data.conversation_id;
                        fetchConversations();
                    } else if (data.type === 'error') { updateAiMessage(aiMessageId, `⚠️ Error: ${data.content}`); showToast('Error generating response'); }
                    else if (data.type === 'quota_error') { updateAiMessage(aiMessageId, data.content); showToast('API rate limit reached. Wait a moment.', 4000); }
                } catch (e) { console.error(e); }
            }
        }
        if (buffer.startsWith('data: ')) {
            try {
                const data = JSON.parse(buffer.slice(6));
                if (data.type === 'chunk') { fullContent += data.content; updateAiMessage(aiMessageId, fullContent); }
                else if (data.type === 'done') { fullContent = data.full_content || fullContent; updateAiMessage(aiMessageId, fullContent); state.currentConversationId = data.conversation_id; fetchConversations(); }
                else if (data.type === 'quota_error') { updateAiMessage(aiMessageId, data.content); showToast('API rate limit reached.', 4000); }
            } catch (e) {}
        }
    } catch (error) {
        hideTypingIndicator();
        if (error.name === 'AbortError') {
            if (fullContent) { const el = addMessageToChat('assistant', fullContent, false); el.dataset.messageId = aiMessageId; }
        } else { showToast('Failed to get response'); addMessageToChat('assistant', `⚠️ Error: ${error.message}`); }
    } finally {
        state.isGenerating = false;
        state.abortController = null;
        dom.stopBtnContainer.style.display = 'none';
        updateSendButton();
        disableInput(false);
        dom.messageInput.focus();
    }
}

async function regenerateLastResponse() {
    if (state.isGenerating || !state.currentConversationId) return;
    const model = dom.modelSelect.value;
    const msgs = dom.messagesContainer.querySelectorAll('.message-wrapper');
    let lastAi = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].classList.contains('assistant') || (!msgs[i].classList.contains('user') && msgs[i].querySelector('.ai-bubble'))) {
            lastAi = msgs[i]; break;
        }
    }
    if (lastAi) lastAi.remove();
    showTypingIndicator();
    dom.stopBtnContainer.style.display = 'block';
    const abortController = new AbortController();
    state.abortController = abortController;
    state.isGenerating = true;
    updateSendButton();
    disableInput(true);
    let fullContent = '';
    let aiMessageId = Date.now();
    try {
        const response = await fetch('/api/chat/regenerate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: state.currentConversationId, model }),
            signal: abortController.signal,
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        hideTypingIndicator();
        const el = addMessageToChat('assistant', '', false);
        el.dataset.messageId = aiMessageId;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'chunk') { fullContent += data.content; updateAiMessage(aiMessageId, fullContent); scrollToBottom(); }
                    else if (data.type === 'done') { fullContent = data.full_content || fullContent; updateAiMessage(aiMessageId, fullContent); fetchConversations(); }
                    else if (data.type === 'error') { updateAiMessage(aiMessageId, `⚠️ ${data.content}`); }
                    else if (data.type === 'quota_error') { updateAiMessage(aiMessageId, data.content); showToast('API rate limit', 4000); }
                } catch (e) {}
            }
        }
    } catch (error) {
        hideTypingIndicator();
        if (error.name !== 'AbortError') showToast('Failed to regenerate');
    } finally {
        state.isGenerating = false; state.abortController = null;
        dom.stopBtnContainer.style.display = 'none';
        updateSendButton(); disableInput(false);
    }
}

function stopGeneration() { if (state.abortController) state.abortController.abort(); }

// ─── Input ──────────────────────────────────────────────────
function updateSendButton() {
    dom.sendBtn.disabled = !dom.messageInput.value.trim() || state.isGenerating;
}

function disableInput(disabled) {
    dom.messageInput.disabled = disabled;
    dom.messageInput.style.opacity = disabled ? '0.5' : '1';
}

function autoResizeTextarea() {
    dom.messageInput.style.height = 'auto';
    dom.messageInput.style.height = Math.min(dom.messageInput.scrollHeight, 200) + 'px';
}

function handleSend() {
    const msg = dom.messageInput.value.trim();
    if (!msg || state.isGenerating) return;
    dom.messageInput.value = '';
    autoResizeTextarea();
    updateSendButton();
    sendMessage(msg, state.currentConversationId);
}

// ─── Event Listeners ────────────────────────────────────────
dom.sendBtn.addEventListener('click', handleSend);
dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});
dom.messageInput.addEventListener('input', () => { autoResizeTextarea(); updateSendButton(); });
dom.stopBtn.addEventListener('click', stopGeneration);
dom.newChatBtn.addEventListener('click', newConversation);
dom.searchInput.addEventListener('input', (e) => { state.searchQuery = e.target.value; renderConversationList(); });
dom.modelSelect.addEventListener('change', () => showToast(`Model: ${dom.modelSelect.value}`));
document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        dom.messageInput.value = chip.dataset.prompt;
        autoResizeTextarea(); updateSendButton(); dom.messageInput.focus();
        handleSend();
    });
});
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); dom.searchInput.focus(); }
    if (e.key === 'Escape') { dom.messageInput.blur(); dom.searchInput.blur(); dom.emojiPicker.classList.remove('show'); }
});

// ─── Init ───────────────────────────────────────────────────
async function init() {
    applyTheme(state.theme);
    buildEmojiPicker();
    await fetchConversations();
    dom.messageInput.focus();
    updateSendButton();
}

init();