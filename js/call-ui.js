export class CallUI {
    constructor(options = {}) {
        this.container = null;
        this.localVideo = null;
        this.remoteVideo = null;
        this.remoteVideosContainer = null;
        this.chatOverlay = null;
        this.chatMessages = null;
        this.chatInput = null;
        this.localVideoWrapper = null;
        this.isChatVisible = false;
        this.isFullscreen = false;
        this.isMobile = options.isMobile || false;
        this.hasMultipleCameras = options.hasMultipleCameras || false;
        this.uiHideTimeout = null;
        this.uiHideDelay = 3000;
        this.uiVisible = true;
        this.wakeLock = null;
        this.callbacks = {};
        this.volumeManager = null;
        this.remoteStreamsMap = null;
        this.expandedPeerId = null;
    }

    init() {
        this.createElements();
        this.bindEvents();
        this.initDraggable();
        this.bindActivityEvents();
    }

    createElements() {
        this.container = document.createElement('div');
        this.container.className = 'call-ui-container';
        this.container.innerHTML = `
            <div class="call-ui-header">
                <div class="call-partner-info">
                    <div class="call-partner-avatar">👤</div>
                    <div class="call-partner-details">
                        <div class="call-partner-name">Участники</div>
                        <div class="call-partner-status">
                            <span class="status-dot"></span>
                            <span class="status-text">В звонке</span>
                        </div>
                    </div>
                </div>
                <div class="call-ui-actions">
                    <button class="call-ui-btn" id="callUiFullscreenBtn" title="Полноэкранный режим">⛶</button>
                </div>
            </div>

            <div class="call-ui-video-area">
                <div class="call-ui-remote-video-wrapper">
                    <video class="call-ui-remote-video" id="callUiRemoteVideo" autoplay playsinline></video>
                    <div class="call-ui-remote-video-label" id="callUiRemoteVideoLabel"></div>
                    <div class="call-ui-remote-video-placeholder" id="callUiRemoteVideoPlaceholder">
                        <div class="placeholder-icon">📞</div>
                        <div class="placeholder-text">Ожидание подключения...</div>
                    </div>
                </div>
                <div class="call-ui-local-video-wrapper" id="callUiLocalVideoWrapper">
                    <video class="call-ui-local-video" id="callUiLocalVideo" autoplay muted playsinline></video>
                    <div class="call-ui-local-video-label">Вы</div>
                </div>
            </div>

            <div class="call-ui-participants" id="callUiParticipants">
                <div class="call-ui-participants-header">
                    <span>Участники</span>
                    <button id="callUiParticipantsRefresh" title="Обновить">↻</button>
                    <button id="callUiParticipantsClose">×</button>
                </div>
                <div class="call-ui-participants-list" id="callUiParticipantsList"></div>
            </div>

            <div class="call-ui-chat-overlay" id="callUiChatOverlay">
                <div class="call-ui-chat-header">
                    <h3>💬 Чат</h3>
                    <button class="call-ui-chat-close" id="callUiChatClose">×</button>
                </div>
                <div class="call-ui-chat-messages" id="callUiChatMessages"></div>
                <div class="call-ui-chat-input">
                    <input type="text" id="callUiChatInput" placeholder="Напишите сообщение...">
                    <button class="call-ui-chat-send-btn" id="callUiChatSendBtn">➤</button>
                </div>
            </div>

            <div class="call-ui-controls">
                <div class="call-ui-controls-row">
                    <button class="call-ui-control-btn active" id="callUiMicBtn" title="Микрофон">🎤</button>
                    <button class="call-ui-control-btn" id="callUiCameraBtn" title="Камера">📷</button>
                    <button class="call-ui-control-btn ${!this.hasMultipleCameras ? 'hidden' : ''}" id="callUiCamSwitchBtn" title="Переключить камеру">🔄</button>
                    <button class="call-ui-control-btn ${this.isMobile ? 'hidden' : ''}" id="callUiScreenBtn" title="Демонстрация экрана">🖥️</button>
                    <button class="call-ui-control-btn hidden" id="callUiScreenAudioBtn" title="Звук экрана">🔊</button>
                    <button class="call-ui-control-btn" id="callUiShareBtn" title="Поделиться">🔗</button>
                    <button class="call-ui-control-btn" id="callUiChatBtn" title="Чат">💬</button>
                    <button class="call-ui-control-btn" id="callUiParticipantsBtn" title="Участники">👥</button>
                    <button class="call-ui-control-btn danger" id="callUiHangupBtn" title="Завершить звонок">📵</button>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);

        this.localVideo = document.getElementById('callUiLocalVideo');
        this.remoteVideo = document.getElementById('callUiRemoteVideo');
        this.chatOverlay = document.getElementById('callUiChatOverlay');
        this.chatMessages = document.getElementById('callUiChatMessages');
        this.chatInput = document.getElementById('callUiChatInput');
        this.localVideoWrapper = document.getElementById('callUiLocalVideoWrapper');
        this.participantsList = document.getElementById('callUiParticipantsList');
    }

    bindEvents() {
        document.getElementById('callUiParticipantsClose').addEventListener('click', () => {
            this.hideParticipants();
        });

        document.getElementById('callUiParticipantsRefresh').addEventListener('click', () => {
            this.callbacks.onRefreshParticipants?.();
        });
        document.getElementById('callUiHangupBtn').addEventListener('click', () => {
            this.callbacks.onHangup?.();
        });

        document.getElementById('callUiMicBtn').addEventListener('click', () => {
            this.callbacks.onToggleMic?.();
        });

        document.getElementById('callUiCameraBtn').addEventListener('click', () => {
            this.callbacks.onToggleCamera?.();
        });

        document.getElementById('callUiCamSwitchBtn').addEventListener('click', () => {
            this.callbacks.onToggleCamSwitch?.();
        });

        document.getElementById('callUiScreenBtn').addEventListener('click', () => {
            this.callbacks.onToggleScreen?.();
        });

        document.getElementById('callUiScreenAudioBtn').addEventListener('click', () => {
            this.callbacks.onToggleScreenAudio?.();
        });

        document.getElementById('callUiShareBtn').addEventListener('click', () => {
            this.callbacks.onShare?.();
        });

        document.getElementById('callUiChatBtn').addEventListener('click', () => {
            this.toggleChat();
        });

        document.getElementById('callUiParticipantsBtn').addEventListener('click', () => {
            this.toggleParticipants();
        });

        document.getElementById('callUiChatClose').addEventListener('click', () => {
            this.toggleChat(false);
        });

        document.getElementById('callUiChatSendBtn').addEventListener('click', () => {
            this.sendMessage();
        });

        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });

        document.getElementById('callUiFullscreenBtn').addEventListener('click', () => {
            this.toggleFullscreen();
        });

        document.addEventListener('fullscreenchange', () => {
            this.isFullscreen = !!document.fullscreenElement;
        });
    }

    initDraggable() {
        const wrapper = this.localVideoWrapper;

        const onStart = (e) => {
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            this.dragState = {
                isDragging: true,
                startX: clientX,
                startY: clientY
            };

            const rect = wrapper.getBoundingClientRect();
            this.dragState.initialX = rect.left;
            this.dragState.initialY = rect.top;
            wrapper.classList.add('dragging');
        };

        const onMove = (e) => {
            if (!this.dragState?.isDragging) return;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            const dx = clientX - this.dragState.startX;
            const dy = clientY - this.dragState.startY;

            wrapper.style.left = `${this.dragState.initialX + dx}px`;
            wrapper.style.top = `${this.dragState.initialY + dy}px`;
            wrapper.style.right = 'auto';
            wrapper.style.bottom = 'auto';
        };

        const onEnd = () => {
            if (this.dragState?.isDragging) {
                this.dragState.isDragging = false;
                wrapper.classList.remove('dragging');
            }
        };

        wrapper.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);

        wrapper.addEventListener('touchstart', onStart, { passive: true });
        document.addEventListener('touchmove', onMove, { passive: true });
        document.addEventListener('touchend', onEnd);
    }

    bindActivityEvents() {
        this.container.addEventListener('mousemove', () => this.handleUserActivity());
        this.container.addEventListener('mousedown', () => this.handleUserActivity());
        this.container.addEventListener('touchstart', () => this.handleUserActivity());
    }

    showUI() {
        if (!this.uiVisible) {
            this.container.querySelector('.call-ui-header')?.classList.remove('hidden');
            this.container.querySelector('.call-ui-controls')?.classList.remove('hidden');
            this.container.querySelector('.call-ui-volume-bar')?.classList.remove('hidden');
            this.uiVisible = true;
        }
        this.resetUIHideTimer();
    }

    hideUI() {
        if (this.isChatVisible) return;

        this.container.querySelector('.call-ui-header')?.classList.add('hidden');
        this.container.querySelector('.call-ui-controls')?.classList.add('hidden');
        this.container.querySelector('.call-ui-volume-bar')?.classList.add('hidden');
        this.uiVisible = false;
    }

    resetUIHideTimer() {
        if (this.uiHideTimeout) {
            clearTimeout(this.uiHideTimeout);
        }
        if (this.isChatVisible) return;

        this.uiHideTimeout = setTimeout(() => {
            this.hideUI();
        }, this.uiHideDelay);
    }

    handleUserActivity() {
        this.showUI();
    }

    show() {
        this.container.classList.add('active');
        this.showUI();
        this.requestWakeLock();
    }

    hide() {
        this.container.classList.remove('active');
        this.toggleChat(false);
        this.releaseWakeLock();

        if (this.uiHideTimeout) {
            clearTimeout(this.uiHideTimeout);
        }
    }

    async requestWakeLock() {
        if (!('wakeLock' in navigator)) return;

        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.warn('Wake Lock error:', err);
        }
    }

    async releaseWakeLock() {
        if (this.wakeLock) {
            await this.wakeLock.release();
            this.wakeLock = null;
        }
    }

    setLocalStream(stream) {
        if (this.localVideo && stream) {
            this.localVideo.srcObject = stream;
        }
    }

    setRemoteStream(stream, remoteStreamsMap = null) {
        console.log('[CallUI] setRemoteStream called');
        console.log('[CallUI] - stream tracks:', stream?.getTracks().map(t => t.kind + ':' + t.readyState));
        console.log('[CallUI] - remoteStreamsMap size:', remoteStreamsMap?.size);
        if (remoteStreamsMap) {
            for (const [id, s] of remoteStreamsMap) {
                console.log('[CallUI] - peer', id.substring(0, 8), 'tracks:', s.getTracks().map(t => t.kind));
            }
        }
        console.log('[CallUI] - this.remoteVideo exists:', !!this.remoteVideo);

        this.remoteStreamsMap = remoteStreamsMap;

        const placeholder = document.getElementById('callUiRemoteVideoPlaceholder');
        
        const videoTracks = stream?.getVideoTracks().filter(t => t.readyState === 'live') || [];
        const audioTracks = stream?.getAudioTracks().filter(t => t.readyState === 'live') || [];
        const hasRemoteTracks = videoTracks.length > 0 || audioTracks.length > 0;

        if (hasRemoteTracks) {
            this.container.classList.add('connected');
            this.container.classList.remove('connecting');
            if (placeholder) placeholder.style.display = 'none';

            if (remoteStreamsMap && remoteStreamsMap.size > 1) {
                console.log('[CallUI] Multiple peers, using grid view');
                this.updateGridView(remoteStreamsMap);
            } else {
                this.updateSingleView(stream);
                this.updateSingleViewVolumeControls();
            }
        } else if (!this.container.classList.contains('connected')) {
            this.container.classList.remove('connected');
            this.container.classList.add('connecting');
            if (placeholder) placeholder.style.display = 'flex';
            this.hideVolumeControls();
        } else {
            if (placeholder) placeholder.style.display = 'none';
        }
    }

    updateSingleView(stream) {
        if (!this.remoteVideo) {
            console.log('[CallUI] updateSingleView: no remoteVideo element!');
            return;
        }

        console.log('[CallUI] updateSingleView: setting stream with tracks:', stream.getTracks().map(t => t.kind));
        console.log('[CallUI] Video element:', this.remoteVideo);
        console.log('[CallUI] Video videoWidth:', this.remoteVideo.videoWidth, 'videoHeight:', this.remoteVideo.videoHeight);
        
        const wrapper = this.remoteVideo.parentElement;
        const rect = this.remoteVideo.getBoundingClientRect();
        console.log('[CallUI] Video rect:', rect.width, 'x', rect.height);
        console.log('[CallUI] Wrapper:', wrapper?.className);
        
        console.log('[CallUI] Stream tracks:', stream.getTracks().map(t => t.kind + ':' + t.id));
        this.remoteVideo.srcObject = stream;
        this.remoteVideo.muted = true;
        console.log('[CallUI] Video srcObject:', this.remoteVideo.srcObject);
        console.log('[CallUI] Video srcObject tracks:', this.remoteVideo.srcObject?.getTracks().map(t => t.kind));
        console.log('[CallUI] After srcObject set, videoWidth:', this.remoteVideo.videoWidth, 'videoHeight:', this.remoteVideo.videoHeight);
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            console.log('[CallUI] Video track settings:', videoTrack.getSettings());
            console.log('[CallUI] Video track readyState:', videoTrack.readyState);
        }
        
        this.remoteVideo.style.display = 'block';
        this.remoteVideo.style.width = '100%';
        this.remoteVideo.style.height = '100%';
        
        const placeholder = document.getElementById('callUiRemoteVideoPlaceholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        
        this.remoteVideo.play().then(() => {
            console.log('[CallUI] Video playing, videoWidth:', this.remoteVideo.videoWidth, 'videoHeight:', this.remoteVideo.videoHeight);
        }).catch(e => {
            console.log('[CallUI] Play error:', e.message);
        });
    }

    updateGridView(remoteStreamsMap) {
        const wrapper = this.container.querySelector('.call-ui-remote-video-wrapper');
        if (!wrapper) return;

        console.log('[CallUI] updateGridView called');

        const originalVideo = this.remoteVideo;
        const originalPlaceholder = document.getElementById('callUiRemoteVideoPlaceholder');

        wrapper.innerHTML = '';
        wrapper.style.position = 'relative';
        wrapper.style.width = '100%';
        wrapper.style.height = '100%';

        const validStreams = [];
        for (const [peerId, peerStream] of remoteStreamsMap) {
            const videoTrack = peerStream.getVideoTracks().find(t => t.readyState === 'live');
            const audioTrack = peerStream.getAudioTracks().find(t => t.readyState === 'live');
            const hasVideo = videoTrack && videoTrack.getSettings().width > 0 && videoTrack.getSettings().height > 0;
            const hasAudio = !!audioTrack;
            
            if (hasVideo || hasAudio) {
                validStreams.push([peerId, peerStream, hasVideo]);
            }
        }

        const count = validStreams.length;
        if (count === 0) {
            wrapper.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.5);">Нет видео</div>';
            return;
        }

        this.expandedPeerId = null;

        if (count === 1) {
            const [[peerId, peerStream]] = validStreams;
            this.updateSingleViewForPeer(peerId, peerStream);
            return;
        }

        wrapper.style.display = 'grid';
        wrapper.style.gridTemplateColumns = '1fr 1fr';
        wrapper.style.gridTemplateRows = '1fr 1fr';
        wrapper.style.gap = '8px';

        console.log('[CallUI] Grid view: creating', validStreams.length, 'videos');

        for (const [peerId, peerStream] of validStreams) {
            console.log('[CallUI] Grid: creating video for peer:', peerId.substring(0, 8), 'tracks:', peerStream.getTracks().map(t => t.kind));
            
            const videoWrapper = document.createElement('div');
            videoWrapper.style.cssText = 'position:relative;background:#1a1a1a;border-radius:8px;overflow:hidden;cursor:pointer;';
            videoWrapper.dataset.peerId = peerId;

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsinline = true;
            video.muted = true;
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#1a1a1a;display:block;';

            const peerStreamCopy = new MediaStream();
            for (const track of peerStream.getTracks()) {
                if (track.readyState === 'live') {
                    peerStreamCopy.addTrack(track);
                }
            }

            console.log('[CallUI] Grid: peerStreamCopy tracks:', peerStreamCopy.getTracks().map(t => t.kind));
            
            video.srcObject = peerStreamCopy;
            video.onloadedmetadata = () => {
                console.log('[CallUI] Grid video loaded:', peerId.substring(0, 8), 'videoWidth:', video.videoWidth);
            };
            video.play().catch(e => console.log('[CallUI] Grid play error:', e));

            const label = document.createElement('div');
            label.textContent = peerId.substring(0, 8);
            label.style.cssText = 'position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.7);color:white;padding:4px 8px;border-radius:4px;font-size:12px;';

            videoWrapper.appendChild(video);
            videoWrapper.appendChild(label);
            wrapper.appendChild(videoWrapper);

            videoWrapper.addEventListener('click', () => {
                this.toggleExpandedVideo(peerId);
            });
        }

        this.remoteVideo = originalVideo;
        if (originalPlaceholder) {
            originalPlaceholder.id = 'callUiRemoteVideoPlaceholder';
        }
    }

    toggleExpandedVideo(peerId) {
        const wrapper = this.container.querySelector('.call-ui-remote-video-wrapper');
        if (!wrapper) return;

        if (this.expandedPeerId === peerId) {
            this.expandedPeerId = null;
            wrapper.style.position = 'relative';
            wrapper.style.display = 'grid';
            for (const child of wrapper.children) {
                child.style.position = 'relative';
                child.style.width = '100%';
                child.style.height = '100%';
                child.style.display = 'block';
                child.style.zIndex = '';
            }
        } else {
            this.expandedPeerId = peerId;
            wrapper.style.display = 'block';
            wrapper.style.position = 'relative';
            for (const child of wrapper.children) {
                if (child.dataset.peerId === peerId) {
                    child.style.position = 'absolute';
                    child.style.top = '0';
                    child.style.left = '0';
                    child.style.width = '100%';
                    child.style.height = '100%';
                    child.style.zIndex = '10';
                } else {
                    child.style.display = 'none';
                }
            }
        }
    }

    updateSingleViewForPeer(peerId, stream) {
        if (!this.remoteVideo) return;

        this.remoteVideo.srcObject = stream;
        this.remoteVideo.muted = true;
        this.remoteVideo.style.display = 'block';
        
        const placeholder = document.getElementById('callUiRemoteVideoPlaceholder');
        if (placeholder) placeholder.style.display = 'none';

        this.remoteVideo.play().catch(() => {});

        const label = document.getElementById('callUiRemoteVideoLabel');
        if (label) label.textContent = peerId.substring(0, 8);
    }

    updateMicState(enabled) {
        const btn = document.getElementById('callUiMicBtn');
        if (enabled) {
            btn.classList.add('active');
            btn.textContent = '🎤';
        } else {
            btn.classList.remove('active');
            btn.textContent = '🔇';
        }
    }

    updateCameraState(enabled) {
        const btn = document.getElementById('callUiCameraBtn');
        if (enabled) {
            btn.classList.add('active');
            btn.textContent = '📹';
        } else {
            btn.classList.remove('active');
            btn.textContent = '📷';
        }
    }

    updateScreenState(enabled) {
        const btn = document.getElementById('callUiScreenBtn');
        const audioBtn = document.getElementById('callUiScreenAudioBtn');

        if (enabled) {
            btn.classList.add('active');
            audioBtn.classList.remove('hidden');
        } else {
            btn.classList.remove('active');
            audioBtn.classList.add('hidden');
        }
    }

    updateScreenAudioState(enabled) {
        const btn = document.getElementById('callUiScreenAudioBtn');
        if (!btn) return;

        if (enabled) {
            btn.classList.add('active');
            btn.textContent = '🔊';
        } else {
            btn.classList.remove('active');
            btn.textContent = '🔇';
        }
    }

    updateSingleViewVolumeControls() {
        if (!this.remoteStreamsMap || this.remoteStreamsMap.size <= 1) {
            this.hideVolumeControls();
            return;
        }
        
        let volumeBar = this.container.querySelector('.call-ui-volume-bar');
        if (!volumeBar) {
            volumeBar = document.createElement('div');
            volumeBar.className = 'call-ui-volume-bar';
            volumeBar.innerHTML = `
                <div class="volume-bar-header">
                    <span>Громкость</span>
                </div>
                <div class="volume-bar-content"></div>
            `;
            this.container.querySelector('.call-ui-video-area').appendChild(volumeBar);
        }
        
        const content = volumeBar.querySelector('.volume-bar-content');
        content.innerHTML = '';
        
        for (const [peerId, stream] of this.remoteStreamsMap) {
            const hasAudio = stream.getAudioTracks().some(t => t.readyState === 'live');
            if (!hasAudio) continue;
            
            const volume = this.volumeManager?.getVolume(peerId) ?? 1.0;
            const item = document.createElement('div');
            item.className = 'volume-bar-item';
            item.dataset.peerId = peerId;
            item.innerHTML = `
                <span class="volume-bar-name">${peerId.substring(0, 8)}</span>
                <span class="volume-bar-icon">${volume === 0 ? '🔇' : '🔊'}</span>
                <input type="range" class="volume-bar-slider" 
                    min="0" max="100" value="${volume * 100}">
                <span class="volume-bar-value">${Math.round(volume * 100)}</span>
            `;
            
            const slider = item.querySelector('.volume-bar-slider');
            slider.addEventListener('input', (e) => {
                const vol = parseInt(e.target.value) / 100;
                item.querySelector('.volume-bar-value').textContent = Math.round(vol * 100);
                item.querySelector('.volume-bar-icon').textContent = vol === 0 ? '🔇' : '🔊';
                this.callbacks.onVolumeChange?.(peerId, vol);
            });
            
            content.appendChild(item);
        }
    }

    hideVolumeControls() {
        const volumeBar = this.container.querySelector('.call-ui-volume-bar');
        if (volumeBar) {
            volumeBar.remove();
        }
    }

    toggleChat(show = null) {
        this.isChatVisible = show !== null ? show : !this.isChatVisible;

        if (this.isChatVisible) {
            this.chatOverlay.classList.add('active');
            document.getElementById('callUiChatBtn').classList.add('active');
            this.chatInput.focus();
            this.showUI();
            this.hideParticipants();
        } else {
            this.chatOverlay.classList.remove('active');
            document.getElementById('callUiChatBtn').classList.remove('active');
            this.resetUIHideTimer();
        }
    }

    toggleParticipants() {
        const participants = this.container.querySelector('.call-ui-participants');
        if (!participants) return;
        
        if (this.container.classList.contains('show-participants')) {
            this.hideParticipants();
            document.getElementById('callUiParticipantsBtn').classList.remove('active');
        } else {
            this.showParticipants();
            document.getElementById('callUiParticipantsBtn').classList.add('active');
            this.hideChat();
        }
    }

    hideChat() {
        this.isChatVisible = false;
        this.chatOverlay.classList.remove('active');
        document.getElementById('callUiChatBtn').classList.remove('active');
    }

    addMessage(text, isOutgoing) {
        const message = document.createElement('div');
        message.className = `call-ui-message ${isOutgoing ? 'outgoing' : 'incoming'}`;

        const time = new Date().toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
        });

        message.innerHTML = `
            <div class="call-ui-message-text">${this.escapeHtml(text)}</div>
            <div class="call-ui-message-time">${time}</div>
        `;

        this.chatMessages.appendChild(message);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    sendMessage() {
        const text = this.chatInput.value.trim();
        if (!text) return;

        this.callbacks.onSendMessage?.(text);
        this.chatInput.value = '';
    }

    clearChat() {
        this.chatMessages.innerHTML = '';
    }

    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            this.container.requestFullscreen().catch(() => {});
        }
    }

    setConnectionState(state) {
        const statusText = this.container.querySelector('.status-text');

        switch (state) {
            case 'connecting':
                this.container.classList.add('connecting');
                this.container.classList.remove('connected');
                if (statusText) statusText.textContent = 'Подключение...';
                break;
            case 'connected':
                this.container.classList.remove('connecting');
                this.container.classList.add('connected');
                if (statusText) statusText.textContent = 'В звонке';
                break;
            case 'disconnected':
                this.container.classList.remove('connecting', 'connected');
                if (statusText) statusText.textContent = 'Отключено';
                break;
        }
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    setVolumeManager(volumeManager) {
        this.volumeManager = volumeManager;
    }

    updateParticipants(participants, localUUID) {
        if (!this.participantsList) return;
        
        this.participantsList.innerHTML = '';
        
        for (const peerId of participants) {
            const item = document.createElement('div');
            item.className = 'call-ui-participant';
            
            if (peerId === localUUID) {
                item.innerHTML = `
                    <span class="call-ui-participant-name">Вы</span>
                `;
            } else {
                const volume = this.volumeManager?.getVolume(peerId) ?? 1.0;
                item.innerHTML = `
                    <span class="call-ui-participant-name">${peerId.substring(0, 8)}</span>
                    <div class="call-ui-participant-volume">
                        <span class="volume-icon">🔊</span>
                        <input type="range" class="volume-slider" 
                            min="0" max="100" value="${volume * 100}" 
                            data-peer-id="${peerId}">
                        <span class="volume-value">${Math.round(volume * 100)}</span>
                    </div>
                `;
                
                const slider = item.querySelector('.volume-slider');
                slider.addEventListener('input', (e) => {
                    const vol = parseInt(e.target.value) / 100;
                    item.querySelector('.volume-value').textContent = Math.round(vol * 100);
                    item.querySelector('.volume-icon').textContent = vol === 0 ? '🔇' : '🔊';
                    this.callbacks.onVolumeChange?.(peerId, vol);
                });
            }
            
            this.participantsList.appendChild(item);
        }
    }

    showParticipants() {
        this.container.classList.add('show-participants');
    }

    hideParticipants() {
        this.container.classList.remove('show-participants');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    destroy() {
        this.releaseWakeLock();
        if (this.uiHideTimeout) {
            clearTimeout(this.uiHideTimeout);
        }
        if (this.container?.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}
