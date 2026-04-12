import { generateUUID, generateRoomId, saveRoomId, getRoomId, clearRoomId } from './uuid.js';
import { Signaling } from './signaling.js';
import { CryptoHandler } from './crypto.js';
import { MediaHandler } from './media-handler.js';
import { WebRTCHandler } from './webrtc-handler.js';
import { CallUI } from './call-ui.js';
import { VolumeManager } from './volume-manager.js';

class WellCallApp {
    constructor() {
        this.uuid = generateUUID();
        this.roomId = null;
        this.roomOwner = null;
        this.isCreator = false;
        this.isInCall = false;
        this.isRoomHeir = false;

        this.signaling = null;
        this.crypto = new CryptoHandler();
        this.media = new MediaHandler();
        this.volumeManager = new VolumeManager();
        this.callUI = null;

        this.peers = new Map();
        this.roomParticipants = new Set([this.uuid]);
        this.presenceAckSent = new Set();
        this.pendingICE = new Map();
        this.remoteStreams = new Map();
        this.incomingCall = null;
        this.isScreenAudioEnabled = false;
        this.hasMultipleCameras = false;
        this.isMobile = false;

        this.elements = {};
    }

    async init() {
        console.log('[App] Initializing...');

        await this.crypto.init();
        await this.media.initialize();

        this.isMobile = this.detectMobile();
        this.hasMultipleCameras = await this.checkMultipleCameras();

        this.cacheElements();
        this.setupEventListeners();

        const urlParams = new URLSearchParams(window.location.search);
        const roomIdParam = urlParams.get('room');
        const inheritedRoomId = getRoomId();

        if (roomIdParam) {
            this.roomId = roomIdParam;
            this.roomOwner = roomIdParam;
            this.isCreator = false;
            console.log('[App] Joining as participant, roomOwner:', this.roomOwner.substring(0, 8));
            await this.joinRoom();
        } else if (inheritedRoomId && inheritedRoomId !== this.uuid) {
            console.log('[App] Inheriting room:', inheritedRoomId.substring(0, 8));
            this.roomId = inheritedRoomId;
            this.isCreator = false;
            this.isRoomHeir = true;
            await this.inheritRoom();
        } else {
            this.isCreator = true;
            this.roomOwner = this.uuid;
        }

        console.log('[App] Initialized, UUID:', this.uuid.substring(0, 8), 'roomId:', this.roomId?.substring(0, 8), 'roomOwner:', this.roomOwner?.substring(0, 8));
    }

    detectMobile() {
        const ua = navigator.userAgent || navigator.vendor || window.opera;
        return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua.toLowerCase()) ||
            (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    }

    async checkMultipleCameras() {
        try {
            if (!navigator.mediaDevices?.enumerateDevices) return false;
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            return videoDevices.length > 1;
        } catch {
            return false;
        }
    }

    cacheElements() {
        this.elements = {
            mainScreen: document.getElementById('mainScreen'),
            callScreen: document.getElementById('callScreen'),
            createRoomBtn: document.getElementById('createRoomBtn'),
            roomInfo: document.getElementById('roomInfo'),
            roomLink: document.getElementById('roomLink'),
            copyLinkBtn: document.getElementById('copyLinkBtn'),
            waitingStatus: document.getElementById('waitingStatus'),
            connectionStatus: document.getElementById('connectionStatus'),
            incomingCallModal: document.getElementById('incomingCallModal'),
            qrCodeContainer: document.getElementById('qrCodeContainer'),
            qrCodeCanvas: document.getElementById('qrCode')
        };
    }

    setupEventListeners() {
        this.elements.createRoomBtn.addEventListener('click', () => this.createRoom());
        this.elements.copyLinkBtn.addEventListener('click', () => this.copyLink());

        document.addEventListener('click', (e) => {
            if (e.target.closest('#acceptCallBtn')) {
                e.preventDefault();
                this.acceptIncomingCall();
            }
            if (e.target.closest('#declineCallBtn')) {
                e.preventDefault();
                this.declineIncomingCall();
            }
        });
    }

    async createRoom() {
        console.log('[App] Creating room...');

        this.roomId = this.uuid;
        this.roomOwner = this.uuid;
        console.log('[App] Created roomId (full):', this.roomId);
        saveRoomId(this.roomId);

        const link = `${window.location.origin}${window.location.pathname}?room=${this.roomId}`;
        console.log('[App] Generated link:', link);
        this.elements.roomLink.value = link;

        this.elements.createRoomBtn.classList.add('hidden');
        this.elements.roomInfo.classList.remove('hidden');

        await this.copyLink();
        this.generateQRCode(link);

        await this.connectToSignaling();

        this.signaling.send({
            type: 'room-created',
            roomId: this.roomId,
            from: this.uuid
        });

        console.log('[App] Room created, waiting for participants...');
    }

    generateQRCode(link) {
        const QRCodeLib = window.QRCode || QRCode;
        if (this.elements.qrCodeCanvas && QRCodeLib) {
            this.elements.qrCodeContainer.classList.remove('hidden');
            this.elements.qrCodeCanvas.innerHTML = '';
            QRCodeLib.toCanvas(this.elements.qrCodeCanvas, link, {
                width: 180,
                margin: 2,
                color: { dark: '#2c3e50', light: '#ffffff' }
            }, (error) => {
                if (error) {
                    console.error('QR generation error:', error);
                    this.elements.qrCodeContainer.classList.add('hidden');
                }
            });
        }
    }

    async joinRoom() {
        console.log('[App] Joining room:', this.roomId);

        this.elements.mainScreen.classList.add('hidden');
        this.elements.connectionStatus.classList.remove('hidden');

        await this.connectToSignaling();

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (this.isInCall || this.peers.size > 0) {
                    resolve(true);
                    return;
                }
                console.log('[App] Join timeout');
                this.cleanup();
                resolve(false);
            }, 30000);

            this.onOfferReceived = () => {
                clearTimeout(timeout);
                this.onOfferReceived = null;
                resolve(true);
            };
        });
    }

    async inheritRoom() {
        console.log('[App] Inheriting room as:', this.roomId.substring(0, 8));

        this.elements.mainScreen.classList.add('hidden');
        this.elements.connectionStatus.classList.remove('hidden');
        this.elements.waitingStatus.querySelector('span').textContent = 'Вы новый организатор...';

        await this.connectToSignaling();

        this.signaling.send({
            type: 'presence',
            status: 'online',
            roomId: this.roomId,
            isRoomHeir: true
        });

        this.isInCall = true;
        this.showCallUI();
    }

    async connectToSignaling() {
        this.signaling = new Signaling(this.uuid, (msg) => this.handleSignalingMessage(msg), this.roomId);

        await new Promise((resolve) => {
            const check = setInterval(() => {
                if (this.signaling.registered) {
                    clearInterval(check);
                    resolve();
                }
            }, 100);
            setTimeout(() => { clearInterval(check); resolve(); }, 5000);
        });

        if (this.signaling.registered) {
            if (this.roomId && this.roomId !== this.uuid) {
                console.log('[App] Sending presence TO room creator:', this.roomId);
                this.signaling.send({
                    type: 'presence',
                    to: this.roomOwner,
                    from: this.uuid,
                    roomId: this.roomId,
                    roomOwner: this.roomOwner,
                    status: 'online'
                });
            } else {
                console.log('[App] Sending presence (no roomId in URL)');
                this.signaling.send({
                    type: 'presence',
                    status: 'online'
                });
            }
        }
    }

    handleSignalingMessage(msg) {
        console.log('[App] Message:', msg.type, 'from:', msg.from?.substring(0, 8), 'roomId:', msg.roomId?.substring(0, 8));

        switch (msg.type) {
            case 'registered':
            case 'ping':
            case 'pong':
                break;

            case 'presence':
                this.handlePresence(msg);
                break;

            case 'group-room-member-joined':
                this.handleGroupRoomMemberJoined(msg);
                break;

            case 'room-heir-transfer':
                this.handleRoomHeirTransfer(msg);
                break;

            case 'room-migrated':
                this.handleRoomMigrated(msg);
                break;

            case 'offer':
            case 'answer':
            case 'ice':
            case 'key':
                this.handleWebRTCMessage(msg);
                break;

            case 'group-call-leave':
                this.handleParticipantLeave(msg);
                break;

            case 'call-ended':
                this.handleCallEnded(msg);
                break;
        }
    }

    handlePresence(msg) {
        const fromUUID = msg.from;
        if (!fromUUID || fromUUID === this.uuid) return;

        if (this.presenceAckSent.has(fromUUID) && this.peers.has(fromUUID)) {
            return;
        }

        if (this.presenceAckSent.has(fromUUID)) {
            this.presenceAckSent.delete(fromUUID);
            this.roomParticipants.delete(fromUUID);
        }

        if (this.isCreator || this.isRoomHeir) {
            const isNew = !this.roomParticipants.has(fromUUID);
            this.roomParticipants.add(fromUUID);

            if (isNew) {
                const existingParticipants = Array.from(this.roomParticipants).filter(id => id !== fromUUID);

                this.signaling.send({
                    type: 'presence',
                    to: fromUUID,
                    from: this.uuid,
                    status: 'online',
                    roomMembers: existingParticipants,
                    roomId: this.roomId
                });

                for (const peerId of this.peers.keys()) {
                    this.signaling.send({
                        type: 'group-room-member-joined',
                        to: peerId,
                        from: this.uuid,
                        newMemberId: fromUUID
                    });
                }

                setTimeout(() => this.startCallWithOffer(fromUUID), 500);
            }

            this.presenceAckSent.add(fromUUID);
            return;
        }

        if (!this.isCreator && !this.isRoomHeir && this.roomOwner && fromUUID === this.roomOwner) {
            console.log('[App] Received presence from room owner:', fromUUID.substring(0, 8), 'waiting for offer...');

            if (msg.roomMembers && Array.isArray(msg.roomMembers)) {
                for (const memberId of msg.roomMembers) {
                    if (memberId !== this.uuid) {
                        this.roomParticipants.add(memberId);
                    }
                }
            }

            this.presenceAckSent.add(fromUUID);
        }
    }

    handleGroupRoomMemberJoined(msg) {
        const newMemberId = msg.newMemberId;
        if (!newMemberId || newMemberId === this.uuid) return;

        this.roomParticipants.add(newMemberId);
        this.presenceAckSent.delete(newMemberId);

        if (this.peers.has(newMemberId)) {
            return;
        }

        if (!this.callUI) {
            this.createCallUI();
        }

        setTimeout(() => this.startCallWithOffer(newMemberId), 500);
    }

    handleWebRTCMessage(msg) {
        if (msg.from === this.uuid) return;

        if (msg.type === 'ice') {
            if (!this.peers.has(msg.from)) {
                if (!this.pendingICE.has(msg.from)) {
                    this.pendingICE.set(msg.from, []);
                }
                this.pendingICE.get(msg.from).push(msg);
            } else {
                this.peers.get(msg.from).handleICECandidate(msg);
            }
            return;
        }

        if (msg.type === 'key') {
            const peer = this.peers.get(msg.from);
            if (peer) {
                peer.handleKeyExchange(msg);
            }
            return;
        }

        if (!this.callUI) {
            this.createCallUI();
        }

        if (msg.type === 'offer') {
            this.handleIncomingOffer(msg);
        } else if (msg.type === 'answer') {
            const peer = this.peers.get(msg.from);
            if (peer) {
                peer.handleAnswer(msg);
            }
        }

        this.roomParticipants.add(msg.from);

        if (!this.isInCall) {
            this.isInCall = true;
            this.showCallUI();
        }

        if (msg.type === 'offer' || msg.type === 'answer') {
            this.flushPendingICE(msg.from);
            this.updateRemoteStreams();
        }
    }

    async handleIncomingOffer(msg) {
        const peer = await this.getOrCreatePeer(msg.from);
        await peer.handleOffer(msg);
        await this.flushPendingICE(msg.from);
    }

    handleParticipantLeave(msg) {
        const leftUUID = msg.from;
        console.log('[App] Participant left:', leftUUID.substring(0, 8));

        this.roomParticipants.delete(leftUUID);
        this.presenceAckSent.delete(leftUUID);

        const peer = this.peers.get(leftUUID);
        if (peer) {
            peer.hangup();
            this.peers.delete(leftUUID);
        }

        this.remoteStreams.delete(leftUUID);
        this.updateRemoteStreams();
        this.updateParticipantsList();
        
        if (this.callUI) {
            this.callUI.hideVolumeControls();
            this.callUI.updateSingleViewVolumeControls();
        }
    }

    handleRoomHeirTransfer(msg) {
        if (msg.to !== this.uuid) return;

        console.log('[App] Received room heir transfer from:', msg.from.substring(0, 8));
        console.log('[App] New roomId:', msg.roomId.substring(0, 8));

        this.roomId = msg.roomId;
        this.isRoomHeir = true;
        this.isCreator = false;
        saveRoomId(this.roomId);

        this.signaling.send({
            type: 'presence',
            status: 'online',
            roomId: this.roomId,
            isRoomHeir: true
        });

        for (const peerId of this.peers.keys()) {
            this.signaling.send({
                type: 'group-room-member-joined',
                to: peerId,
                from: this.uuid,
                newMemberId: msg.roomId,
                roomId: this.roomId
            });
        }
    }

    async handleRoomMigrated(msg) {
        console.log('[App] Room migrated from', msg.oldRoomId?.substring(0, 8), 'to', msg.newRoomId?.substring(0, 8));
        
        const newRoomId = msg.newRoomId;
        this.roomId = newRoomId;
        this.roomOwner = newRoomId;
        saveRoomId(newRoomId);
        
        const newLink = `${window.location.origin}${window.location.pathname}?room=${newRoomId}`;
        
        if (this.elements?.roomLink) {
            this.elements.roomLink.value = newLink;
        }
        
        this.generateQRCode(newLink);
        
        window.history.replaceState(null, '', `?room=${newRoomId}`);
        
        this.isRoomHeir = true;
        this.isCreator = false;
        
        this.signaling.send({
            type: 'presence',
            status: 'online',
            roomId: newRoomId,
            isRoomHeir: true
        });
    }

    handleCallEnded(msg) {
        const fromUUID = msg.from;
        const peer = this.peers.get(fromUUID);
        if (peer) {
            peer.hangup();
            this.peers.delete(fromUUID);
        }

        if (this.peers.size === 0) {
            this.cleanup();
        }
    }

    async startCallWithOffer(targetUUID) {
        console.log('[App] Starting call with:', targetUUID.substring(0, 8));

        if (!this.callUI) {
            this.createCallUI();
        }

        const peer = await this.getOrCreatePeer(targetUUID);

        await this.media.ensureAudio();
        peer.localStream = this.media.getLocalStream();

        const ok = await peer.createOffer(targetUUID);
        if (!ok) {
            console.error('[App] Failed to create offer');
            return;
        }

        this.isInCall = true;
        this.showCallUI();

        const stream = this.getLocalStream();
        if (this.callUI && stream) {
            this.callUI.setLocalStream(stream);
        }
    }

    async getOrCreatePeer(targetUUID) {
        if (this.peers.has(targetUUID)) {
            return this.peers.get(targetUUID);
        }

        const peer = new WebRTCHandler(this.uuid, this.signaling, this.crypto);

        peer.onRemoteStream = (stream) => {
            console.log('[App] Remote stream updated, tracks:', stream.getTracks().map(t => t.kind + ':' + t.id.substring(0, 8)));
            
            this.remoteStreams.set(targetUUID, stream);
            console.log('[App] remoteStreams updated, now has tracks:', this.remoteStreams.get(targetUUID)?.getTracks().map(t => t.kind));
            
            this.updateRemoteStreams(stream);
            this.updateParticipantsList();
        };

        peer.onMessage = (from, text) => {
            if (this.callUI) {
                this.callUI.addMessage(text, false);
            }
        };

        peer.onConnectionStateChange = (state) => {
            console.log('[App] Connection state:', state, 'for', targetUUID.substring(0, 8));
            if (state === 'connected' && this.callUI) {
                this.callUI.setConnectionState('connected');
                this.updateParticipantsList();
            }
        };

        this.peers.set(targetUUID, peer);
        return peer;
    }

    async flushPendingICE(from) {
        if (!this.pendingICE.has(from)) return;

        const peer = this.peers.get(from);
        if (!peer) return;

        const candidates = this.pendingICE.get(from);
        for (const candidate of candidates) {
            await peer.handleICECandidate(candidate);
        }

        this.pendingICE.delete(from);
    }

    async updateRemoteStreams(latestStream = null) {
        console.log('[App] updateRemoteStreams, remoteStreams size:', this.remoteStreams.size);

        let streamToUse = latestStream;
        if (!streamToUse || streamToUse.getTracks().length === 0) {
            for (const [, s] of this.remoteStreams) {
                if (s.getTracks().length > 0) {
                    streamToUse = s;
                    break;
                }
            }
        }

        if (streamToUse) {
            console.log('[App] Using stream with tracks:', streamToUse.getTracks().map(t => t.kind));
        }

        for (const [peerId, stream] of this.remoteStreams) {
            await this.volumeManager.attachStream(peerId, stream);
        }

        if (this.callUI) {
            this.callUI.setRemoteStream(streamToUse, this.remoteStreams);
            this.callUI.setVolumeManager(this.volumeManager);
        }
    }

    updateParticipantsList() {
        if (!this.callUI) return;
        
        const participants = [this.uuid, ...this.remoteStreams.keys()];
        this.callUI.updateParticipants(participants, this.uuid);
    }

    refreshParticipants() {
        console.log('[App] Refreshing participants...');
        
        if (this.signaling?.registered && this.roomOwner) {
            this.signaling.send({
                type: 'presence',
                to: this.roomOwner,
                from: this.uuid,
                roomId: this.roomId,
                roomOwner: this.roomOwner,
                status: 'online'
            });
        }
        
        this.updateParticipantsList();
    }

    getLocalStream() {
        const screenStream = this.media.getScreenStream();
        const cameraTrack = this.media.getVideoTrackSync();
        const audioTrack = this.media.getAudioTrackSync();

        if (screenStream?.getVideoTracks()?.[0]) {
            const combined = new MediaStream();
            const screenTrack = screenStream.getVideoTracks()[0];
            if (screenTrack.readyState === 'live') {
                combined.addTrack(screenTrack);
            }

            const screenAudio = this.media.getScreenAudioTrack();
            if (screenAudio && screenAudio.readyState === 'live' && this.isScreenAudioEnabled) {
                combined.addTrack(screenAudio);
            } else if (audioTrack?.readyState === 'live') {
                combined.addTrack(audioTrack);
            }
            return combined;
        }

        if (cameraTrack && this.media.isVideoEnabled && cameraTrack.readyState === 'live') {
            const combined = new MediaStream();
            combined.addTrack(cameraTrack);
            if (audioTrack?.readyState === 'live') {
                combined.addTrack(audioTrack);
            }
            return combined;
        }

        if (audioTrack?.readyState === 'live') {
            const combined = new MediaStream([audioTrack]);
            const black = this.media.getBlackVideoTrack();
            combined.addTrack(black);
            return combined;
        }

        return new MediaStream();
    }

    createCallUI() {
        this.callUI = new CallUI({
            isMobile: this.isMobile,
            hasMultipleCameras: this.hasMultipleCameras
        });
        this.callUI.init();

        this.callUI.on('onHangup', () => this.hangup());
        this.callUI.on('onToggleMic', () => this.toggleMic());
        this.callUI.on('onToggleCamera', () => this.toggleCamera());
        this.callUI.on('onToggleCamSwitch', () => this.switchCamera());
        this.callUI.on('onToggleScreen', () => this.toggleScreen());
        this.callUI.on('onToggleScreenAudio', () => this.toggleScreenAudio());
        this.callUI.on('onShare', () => this.shareRoom());
        this.callUI.on('onSendMessage', (text) => this.sendMessage(text));
        this.callUI.on('onVolumeChange', (peerId, volume) => this.setPeerVolume(peerId, volume));
        this.callUI.on('onRefreshParticipants', () => this.refreshParticipants());
    }

    showCallUI() {
        this.elements.mainScreen.classList.add('hidden');
        this.elements.connectionStatus.classList.add('hidden');
        this.elements.callScreen.classList.remove('hidden');

        if (!this.callUI) {
            this.createCallUI();
        }

        this.callUI.show();
        this.callUI.setConnectionState('connecting');
    }

    hideCallUI() {
        if (this.callUI) {
            this.callUI.hide();
        }
        this.elements.callScreen.classList.add('hidden');
        this.elements.mainScreen.classList.remove('hidden');
    }

    async toggleMic() {
        const wasEnabled = this.media.isAudioEnabled;
        await this.media.enableAudio(!wasEnabled);

        const audioTrack = this.media.getAudioTrackSync();
        for (const peer of this.peers.values()) {
            await peer.replaceAudioTrack(audioTrack);
        }

        if (this.callUI) {
            this.callUI.updateMicState(this.media.isAudioEnabled);
        }
    }

    async toggleCamera() {
        if (this.media.isVideoEnabled) {
            await this.media.disableVideo();
        } else {
            await this.media.enableVideo(true);
        }

        const videoTrack = this.media.getVideoTrackSync();
        for (const peer of this.peers.values()) {
            await peer.replaceVideoTrack(videoTrack);
            await peer.renegotiate();
        }

        const stream = this.getLocalStream();
        if (this.callUI) {
            this.callUI.setLocalStream(stream);
            this.callUI.updateCameraState(this.media.isVideoEnabled);
        }
    }

    async switchCamera() {
        const result = await this.media.switchCamera();
        if (!result) return;

        for (const peer of this.peers.values()) {
            await peer.replaceVideoTrack(result.newTrack);
            await peer.renegotiate();
        }

        const stream = this.getLocalStream();
        if (this.callUI) {
            this.callUI.setLocalStream(stream);
        }
    }

    async toggleScreen() {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            alert('Демонстрация экрана не поддерживается');
            return;
        }

        if (this.media.isScreenSharing) {
            await this.stopScreenShare();
        } else {
            await this.startScreenShare();
        }
    }

    async startScreenShare() {
        try {
            const screenTrack = await this.media.startScreenShare();
            if (!screenTrack) return;

            const screenStream = this.media.getScreenStream();
            const screenAudioTrack = this.media.getScreenAudioTrack();
            this.isScreenAudioEnabled = true;

            for (const peer of this.peers.values()) {
                await peer.addScreenTrack(screenTrack, screenStream, screenAudioTrack);
            }

            const stream = this.getLocalStream();
            if (this.callUI) {
                this.callUI.setLocalStream(stream);
                this.callUI.updateScreenState(true);
                this.callUI.updateScreenAudioState(true);
            }
        } catch (error) {
            console.error('[App] Screen share failed:', error);
            if (error.name === 'NotAllowedError') {
                alert('Доступ к демонстрации экрана запрещён');
            }
        }
    }

    async stopScreenShare() {
        const audioTrack = this.media.getAudioTrackSync();

        for (const peer of this.peers.values()) {
            await peer.removeScreenTrack(audioTrack);
        }

        this.media.stopScreenShare();

        const stream = this.getLocalStream();
        if (this.callUI) {
            this.callUI.setLocalStream(stream);
            this.callUI.updateScreenState(false);
        }
    }

    async sendMessage(text) {
        for (const peer of this.peers.values()) {
            const sent = await peer.sendMessage(text);
            if (sent && this.callUI) {
                this.callUI.addMessage(text, true);
            }
        }
    }

    toggleScreenAudio() {
        if (!this.media.isScreenSharing) return;

        this.isScreenAudioEnabled = !this.isScreenAudioEnabled;
        const screenAudio = this.media.getScreenAudioTrack();
        if (screenAudio) {
            screenAudio.enabled = this.isScreenAudioEnabled;
        }

        if (this.callUI) {
            this.callUI.updateScreenAudioState(this.isScreenAudioEnabled);
        }
    }

    shareRoom() {
        const roomIdToShare = this.roomOwner || this.roomId;
        const link = `${window.location.origin}${window.location.pathname}?room=${roomIdToShare}`;
        
        if (navigator.share) {
            navigator.share({
                title: 'WellCall',
                text: 'Присоединяйся к звонку!',
                url: link
            }).catch(() => {});
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(link).then(() => {
                alert('Ссылка скопирована: ' + link);
            }).catch(() => {
                prompt('Скопируйте ссылку:', link);
            });
        } else {
            prompt('Скопируйте ссылку:', link);
        }
    }

    sendMessage(text) {
        for (const peer of this.peers.values()) {
            peer.sendMessage(text);
        }
        if (this.peers.size > 0 && this.callUI) {
            this.callUI.addMessage(text, true);
        }
    }

    async setPeerVolume(peerId, volume) {
        console.log('[App] setPeerVolume', peerId?.substring(0, 8), volume);
        await this.volumeManager.setVolume(peerId, volume);
    }

    async acceptIncomingCall() {
        console.log('[App] Accepting incoming call');

        this.elements.incomingCallModal.classList.add('hidden');

        if (!this.callUI) {
            this.createCallUI();
        }

        const targetUUID = this.incomingCall?.from || this.roomId;
        const peer = await this.getOrCreatePeer(targetUUID);

        await this.media.ensureAudio();
        peer.localStream = this.media.getLocalStream();

        if (this.incomingCall?.offer) {
            await peer.handleOffer(this.incomingCall.offer);
        } else {
            await peer.createOffer(targetUUID);
        }

        this.isInCall = true;
        this.showCallUI();

        const stream = this.getLocalStream();
        if (this.callUI) {
            this.callUI.setLocalStream(stream);
        }

        if (this.onOfferReceived) {
            this.onOfferReceived();
        }

        this.incomingCall = null;
    }

    declineIncomingCall() {
        if (this.incomingCall) {
            this.signaling.send({
                type: 'call-rejected',
                to: this.incomingCall.from,
                from: this.uuid
            });
        }

        this.elements.incomingCallModal.classList.add('hidden');
        this.incomingCall = null;

        if (!this.isCreator) {
            window.location.href = window.location.pathname;
        }
    }

    hangup() {
        console.log('[App] Hanging up');

        const peersArray = Array.from(this.peers.keys()).filter(id => id !== this.uuid);
        
        let nextHeir = null;
        if (peersArray.length > 0 && (this.isCreator || this.isRoomHeir)) {
            nextHeir = peersArray[Math.floor(Math.random() * peersArray.length)];
        }

        for (const peerId of this.peers.keys()) {
            this.signaling.send({
                type: 'call-ended',
                to: peerId,
                from: this.uuid
            });
            this.signaling.send({
                type: 'group-call-leave',
                to: peerId,
                from: this.uuid,
                roomId: this.roomId
            });
        }

        if (nextHeir) {
            this.signaling.send({
                type: 'room-heir-transfer',
                to: nextHeir,
                from: this.uuid,
                roomId: this.roomId
            });
            
            this.signaling.broadcast({
                type: 'room-migrated',
                from: this.uuid,
                oldRoomId: this.roomId,
                newRoomId: nextHeir
            });
        } else {
            clearRoomId();
        }

        this.cleanup(nextHeir !== null);
    }

    cleanup(isHeirTransfer = false) {
        console.log('[App] Cleaning up');

        for (const peer of this.peers.values()) {
            peer.hangup();
        }
        this.peers.clear();

        this.media.stopAllTracks();

        this.isInCall = false;
        this.incomingCall = null;
        this.pendingICE.clear();
        this.presenceAckSent.clear();
        this.remoteStreams.clear();

        this.hideCallUI();

        if (this.callUI) {
            this.callUI.clearChat();
        }

        if (!this.isCreator && !this.isRoomHeir && !isHeirTransfer) {
            window.location.href = window.location.pathname;
        }
    }

    async copyLink() {
        try {
            await navigator.clipboard.writeText(this.elements.roomLink.value);
            this.elements.copyLinkBtn.textContent = '✅';
            setTimeout(() => {
                this.elements.copyLinkBtn.textContent = '📋';
            }, 2000);
        } catch {
            this.elements.roomLink.select();
            document.execCommand('copy');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.wellCallApp = new WellCallApp();
    window.wellCallApp.init();
});
