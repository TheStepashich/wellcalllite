import { ICE_SERVERS } from './ice-servers.js';

export class WebRTCHandler {
    constructor(uuid, signaling, crypto) {
        this.uuid = uuid;
        this.signaling = signaling;
        this.crypto = crypto;
        this.pc = null;
        this.dataChannel = null;
        this.localStream = null;
        this.targetUUID = null;
        this.remoteTracks = new Map();
        this.pendingICE = [];
        this.pendingAnswers = [];
        this.messageQueue = [];
        this.isConnected = false;
        this.sentMyKey = false;
        this.receivedPeerKey = false;
        this.onRemoteStream = null;
        this.onMessage = null;
        this.onConnectionStateChange = null;
        this.retryCount = 0;
        this.maxRetries = 3;
        this.retryDelay = 2000;
        this.offerGeneration = 0;
        this.operationLock = null;
    }

    async acquireLock() {
        while (this.operationLock) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        this.operationLock = true;
    }

    releaseLock() {
        this.operationLock = null;
    }

    createPeerConnection() {
        this.pc = new RTCPeerConnection({
            iceServers: ICE_SERVERS,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 16
        });

        this.pc.oniceconnectionstatechange = () => {
            const state = this.pc.iceConnectionState;
            console.log('[WebRTC] ICE state:', state);

            if (state === 'disconnected') {
                console.log('[WebRTC] ICE disconnected, waiting for recovery...');
            }

            if (state === 'failed') {
                console.log('[WebRTC] ICE failed, triggering connection retry...');
            }
        };

        this.pc.onicecandidate = (event) => {
            if (event.candidate && this.targetUUID) {
                this.signaling.send({
                    type: 'ice',
                    to: this.targetUUID,
                    from: this.uuid,
                    data: event.candidate
                });
            }
        };

        this.pc.ontrack = (event) => {
            console.log('[WebRTC] ontrack:', event.track.kind, event.track.id, 'streams:', event.streams?.length);
            console.log('[WebRTC] Track label:', event.track.label, 'readyState:', event.track.readyState, 'settings:', event.track.getSettings());
            console.log('[WebRTC] remoteTracks before:', Array.from(this.remoteTracks.entries()).map(([k, t]) => k + ':' + t.kind));
            
            if (event.track.kind === 'video') {
                for (const [id, track] of this.remoteTracks) {
                    console.log('[WebRTC] Checking track:', id, 'kind:', track.kind);
                    if (track.kind === 'video') {
                        console.log('[WebRTC] Removing old video track:', id);
                        this.remoteTracks.delete(id);
                    }
                }
            }
            
            console.log('[WebRTC] remoteTracks after:', Array.from(this.remoteTracks.keys()));
            
            this.remoteTracks.set(event.track.id, event.track);
            
            const combined = this.createCombinedStream();
            console.log('[WebRTC] Combined stream has', combined.getTracks().length, 'tracks');
            this.onRemoteStream?.(combined);

            event.track.onended = () => {
                console.log('[WebRTC] Track ended:', event.track.id);
                this.remoteTracks.delete(event.track.id);
                const newCombined = this.createCombinedStream();
                this.onRemoteStream?.(newCombined);
            };
        };

        this.pc.onconnectionstatechange = () => {
            const state = this.pc.connectionState;
            console.log('[WebRTC] Connection state:', state);
            this.isConnected = state === 'connected';
            this.onConnectionStateChange?.(state);

            if (state === 'disconnected' && this.retryCount < this.maxRetries) {
                console.log('[WebRTC] Connection disconnected, scheduling ICE restart...');
                setTimeout(() => this.restartICE(), this.retryDelay);
                this.retryDelay *= 1.5;
            }

            if (state === 'failed' && this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`[WebRTC] Connection failed, retry ${this.retryCount}/${this.maxRetries} in ${this.retryDelay}ms`);
                setTimeout(() => this.retryConnection(), this.retryDelay);
                this.retryDelay *= 1.5;
            }
        };

        return this.pc;
    }

    async restartICE() {
        if (!this.pc || this.pc.connectionState === 'connected') return;

        console.log('[WebRTC] Attempting ICE restart...');
        try {
            if (this.pc.signalingState === 'stable') {
                const offer = await this.pc.createOffer({ iceRestart: true });
                await this.pc.setLocalDescription(offer);
                this.signaling.send({
                    type: 'offer',
                    to: this.targetUUID,
                    from: this.uuid,
                    data: offer
                });
                console.log('[WebRTC] ICE restart offer sent');
            } else {
                console.log('[WebRTC] Cannot ICE restart, signaling state:', this.pc.signalingState);
            }
        } catch (e) {
            console.warn('[WebRTC] ICE restart failed:', e);
        }
    }

    async retryConnection() {
        if (!this.targetUUID) return;

        this.retryCount++;
        this.offerGeneration++;
        this.receivedPeerKey = false;
        
        console.log('[WebRTC] Retrying connection, attempt:', this.retryCount, 'generation:', this.offerGeneration);

        if (this.pc) {
            this.pc.close();
        }

        this.createPeerConnection();
        this.pendingICE = [];
        this.remoteTracks.clear();

        if (this.dataChannel) {
            try {
                this.dataChannel.close();
            } catch (e) {}
        }

        await this.ensureAudio();

        const audioTrack = this.localStream?.getAudioTracks()?.[0];
        if (audioTrack) {
            this.pc.addTrack(audioTrack, this.localStream);
        }

        const videoTrack = this.localStream?.getVideoTracks()?.[0];
        if (videoTrack && videoTrack.readyState === 'live') {
            this.pc.addTrack(videoTrack, this.localStream);
        }

        this.dataChannel = this.pc.createDataChannel('chat');
        this.setupDataChannel(this.dataChannel);

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        this.signaling.send({
            type: 'offer',
            to: this.targetUUID,
            from: this.uuid,
            data: offer
        });

        console.log('[WebRTC] Retry offer sent, waiting for answer...');
    }

    createCombinedStream() {
        const combined = new MediaStream();
        for (const track of this.remoteTracks.values()) {
            if (track.readyState === 'live') {
                combined.addTrack(track);
            }
        }
        console.log('[WebRTC] Combined stream:', combined.getTracks().length, 'tracks');
        return combined;
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;

        this.dataChannel.onopen = () => {
            console.log('[WebRTC] Data channel opened');
            this.isConnected = true;
            this.sentMyKey = false;
            this.sendMyKey();
            this.flushMessageQueue();
        };

        this.dataChannel.onclose = () => {
            console.log('[WebRTC] Data channel closed');
            this.isConnected = false;
        };

        this.dataChannel.onmessage = async (event) => {
            try {
                const encrypted = JSON.parse(event.data);
                const message = await this.crypto.decrypt(encrypted, this.targetUUID);
                this.onMessage?.(message.from, message.text);
            } catch (error) {
                console.error('[WebRTC] Failed to decrypt message:', error);
            }
        };
    }

    async createOffer(targetUUID) {
        await this.acquireLock();
        try {
            return await this._createOffer(targetUUID);
        } finally {
            this.releaseLock();
        }
    }

    async _createOffer(targetUUID) {
        this.targetUUID = targetUUID;
        this.offerGeneration++;
        this.sentMyKey = false;
        this.receivedPeerKey = false;

        if (this.pc && this.pc.signalingState !== 'stable') {
            console.log('[WebRTC] Waiting for stable state, current:', this.pc.signalingState);
            await this.waitForStableState();
        }

        if (this.pc) {
            console.log('[WebRTC] Closing existing connection for new offer');
            this.pc.close();
            this.pc = null;
        }

        await this.ensureAudio();

        this.createPeerConnection();
        this.pendingICE = [];
        this.remoteTracks.clear();

        this.dataChannel = this.pc.createDataChannel('chat');
        this.setupDataChannel(this.dataChannel);

        const publicKey = await this.crypto.exportPublicKey();
        this.signaling.send({
            type: 'key',
            to: targetUUID,
            from: this.uuid,
            data: publicKey
        });
        this.sentMyKey = true;

        const audioTrack = this.localStream?.getAudioTracks()?.[0];
        if (audioTrack) {
            this.pc.addTrack(audioTrack, this.localStream);
        }

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        console.log('[WebRTC] Offer created, generation:', this.offerGeneration);

        this.signaling.send({
            type: 'offer',
            to: targetUUID,
            from: this.uuid,
            data: offer
        });

        return true;
    }

    async waitForStableState(timeout = 3000) {
        if (!this.pc || this.pc.signalingState === 'stable') {
            return;
        }

        return new Promise((resolve) => {
            const checkState = () => {
                if (!this.pc || this.pc.signalingState === 'stable') {
                    clearTimeout(timer);
                    this.pc?.removeEventListener('signalingstatechange', checkState);
                    resolve();
                }
            };

            const timer = setTimeout(() => {
                this.pc?.removeEventListener('signalingstatechange', checkState);
                resolve();
            }, timeout);

            this.pc.addEventListener('signalingstatechange', checkState);
            checkState();
        });
    }

    async handleOffer(msg) {
        await this.acquireLock();
        try {
            await this._handleOffer(msg);
        } finally {
            this.releaseLock();
        }
    }

    async _handleOffer(msg) {
        this.targetUUID = msg.from;

        const hasExistingConnection = this.pc && 
                                      this.pc.remoteDescription && 
                                      (this.pc.connectionState === 'connected' || 
                                       this.pc.connectionState === 'connecting' || 
                                       this.pc.connectionState === 'new');

        if (hasExistingConnection) {
            const state = this.pc.signalingState;
            console.log('[WebRTC] Existing connection, state:', state, 'connection:', this.pc.connectionState);

            if (state === 'stable') {
                console.log('[WebRTC] Renegotiation offer received (stable), processing...');
                try {
                    await this.pc.setRemoteDescription(msg.data);
                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);

                    this.signaling.send({
                        type: 'answer',
                        to: msg.from,
                        from: this.uuid,
                        data: answer
                    });

                    setTimeout(async () => {
                        for (const candidate of this.pendingICE) {
                            try {
                                await this.pc.addIceCandidate(candidate);
                            } catch (e) {
                                if (!e.message.includes('Unknown ufrag') && !e.message.includes('closed')) {
                                    console.warn('[WebRTC] ICE add failed:', e.message);
                                }
                            }
                        }
                        this.pendingICE = [];
                    }, 100);
                    return;
                } catch (e) {
                    console.error('[WebRTC] Renegotiation (stable) failed:', e);
                }
            }

            if (state === 'have-local-offer') {
                console.log('[WebRTC] Glare during renegotiation, rolling back...');
                try {
                    await this.pc.setLocalDescription({ type: 'rollback' });
                    await this.pc.setRemoteDescription(msg.data);

                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);

                    this.signaling.send({
                        type: 'answer',
                        to: msg.from,
                        from: this.uuid,
                        data: answer
                    });

                    setTimeout(async () => {
                        for (const candidate of this.pendingICE) {
                            try {
                                await this.pc.addIceCandidate(candidate);
                            } catch (e) {
                                if (!e.message.includes('Unknown ufrag') && !e.message.includes('closed')) {
                                    console.warn('[WebRTC] ICE add failed:', e.message);
                                }
                            }
                        }
                        this.pendingICE = [];
                    }, 100);
                    return;
                } catch (e) {
                    console.error('[WebRTC] Glare resolution failed:', e);
                }
            }

            if (state === 'have-remote-offer') {
                console.log('[WebRTC] Already have remote offer, updating...');
                try {
                    await this.pc.setRemoteDescription(msg.data);

                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);

                    this.signaling.send({
                        type: 'answer',
                        to: msg.from,
                        from: this.uuid,
                        data: answer
                    });
                    return;
                } catch (e) {
                    console.error('[WebRTC] Failed to update remote offer:', e);
                }
            }

            if (state === 'closed') {
                console.log('[WebRTC] Connection closed, recreating...');
                this.pc.close();
                this.pc = null;
            }

            console.log('[WebRTC] Could not handle offer on existing connection (state:', state, '), skipping to avoid destroying connection');
            return;
        }

        if (this.pc && this.pc.signalingState === 'have-local-offer') {
            console.log('[WebRTC] Glare detected (have-local-offer), rolling back our offer to accept incoming');
            try {
                await this.pc.setLocalDescription({ type: 'rollback' });

                await this.pc.setRemoteDescription(msg.data);

                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);

                this.signaling.send({
                    type: 'answer',
                    to: msg.from,
                    from: this.uuid,
                    data: answer
                });

                setTimeout(async () => {
                    for (const candidate of this.pendingICE) {
                        try {
                            await this.pc.addIceCandidate(candidate);
                        } catch (e) {
                            if (!e.message.includes('Unknown ufrag') && !e.message.includes('closed')) {
                                console.warn('[WebRTC] ICE add failed:', e.message);
                            }
                        }
                    }
                    this.pendingICE = [];
                }, 100);
                return;
            } catch (e) {
                console.warn('[WebRTC] Glare resolution failed, recreating connection:', e);
                this.pc.close();
                this.pc = null;
            }
        }

        console.log('[WebRTC] No existing connection, creating new one for incoming offer');

        this.sentMyKey = false;
        this.receivedPeerKey = false;

        await this.ensureAudio();

        this.createPeerConnection();
        this.pendingICE = [];
        this.remoteTracks.clear();

        this.pc.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        const audioTrack = this.localStream?.getAudioTracks()?.[0];
        if (audioTrack) {
            this.pc.addTrack(audioTrack, this.localStream);
        }

        try {
            await this.pc.setRemoteDescription(msg.data);
            console.log('[WebRTC] Offer set, state:', this.pc.signalingState);

            const publicKey = await this.crypto.exportPublicKey();
            this.signaling.send({
                type: 'key',
                to: msg.from,
                from: this.uuid,
                data: publicKey
            });
            this.sentMyKey = true;

            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            this.signaling.send({
                type: 'answer',
                to: msg.from,
                from: this.uuid,
                data: answer
            });

            setTimeout(async () => {
                for (const candidate of this.pendingICE) {
                    try {
                        await this.pc.addIceCandidate(candidate);
                    } catch (e) {
                        if (!e.message.includes('Unknown ufrag') && !e.message.includes('closed')) {
                            console.warn('[WebRTC] ICE add failed:', e.message);
                        }
                    }
                }
                this.pendingICE = [];
            }, 100);

        } catch (e) {
            console.error('[WebRTC] Failed to handle offer:', e);
        }
    }

    async handleAnswer(msg) {
        await this.acquireLock();
        try {
            await this._handleAnswer(msg);
        } finally {
            this.releaseLock();
        }
    }

    async _handleAnswer(msg) {
        if (!this.pc) {
            console.warn('[WebRTC] No peer connection for answer');
            return;
        }

        if (this.pc.signalingState === 'stable') {
            console.log('[WebRTC] Answer for renegotiation received, state stable');
            try {
                await this.pc.setRemoteDescription(msg.data);
                console.log('[WebRTC] Renegotiation answer set');
            } catch (e) {
                console.error('[WebRTC] Failed to set renegotiation answer:', e);
            }
            return;
        }

        console.log('[WebRTC] Answer state:', this.pc.signalingState, 'connected:', this.isConnected, 'pc.connectionState:', this.pc.connectionState);

        if ((this.isConnected || this.pc.connectionState === 'connected') && this.pc.remoteDescription) {
            console.log('[WebRTC] Already connected, setting remote description anyway');
            try {
                await this.pc.setRemoteDescription(msg.data);
                console.log('[WebRTC] Answer set for existing connection');
            } catch (e) {
                console.error('[WebRTC] Failed to set answer:', e.message);
            }
            return;
        }

        if (this.pc.signalingState !== 'have-local-offer') {
            console.log('[WebRTC] Unexpected state for answer:', this.pc.signalingState);
            return;
        }

        try {
            await this.pc.setRemoteDescription(msg.data);
            console.log('[WebRTC] Answer set, state:', this.pc.signalingState);

            setTimeout(async () => {
                for (const candidate of this.pendingICE) {
                    try {
                        await this.pc.addIceCandidate(candidate);
                    } catch (e) {
                        if (e.message.includes('Unknown ufrag') || e.message.includes('closed')) {
                            continue;
                        }
                        console.warn('[WebRTC] ICE add failed:', e.message);
                    }
                }
                this.pendingICE = [];
            }, 500);
        } catch (e) {
            console.error('[WebRTC] Failed to set answer:', e.message);
        }
    }

    async handleICECandidate(msg) {
        if (!this.pc) {
            console.log('No peer connection, queuing ICE candidate');
            this.pendingICE.push(msg.data);
            return;
        }

        if (!this.pc.remoteDescription || !this.pc.remoteDescription.sdp) {
            console.log('No remote description yet, queuing ICE candidate');
            this.pendingICE.push(msg.data);
            return;
        }

        try {
            await this.pc.addIceCandidate(msg.data);
        } catch (e) {
            if (e.message.includes('Unknown ufrag')) {
                console.log('ICE candidate from old negotiation, ignoring');
            } else if (!e.message.includes('closed') && !e.message.includes('state')) {
                console.warn('Failed to add ICE candidate:', e.message);
            }
        }
    }

    async sendMyKey() {
        if (this.sentMyKey || !this.targetUUID) return;

        try {
            const publicKey = await this.crypto.exportPublicKey();
            
            if (this.signaling) {
                this.signaling.send({
                    type: 'key',
                    to: this.targetUUID,
                    from: this.uuid,
                    data: publicKey
                });
            }
            
            this.sentMyKey = true;
            console.log('[WebRTC] Public key sent to', this.targetUUID?.substring(0, 8));
        } catch (error) {
            console.error('[WebRTC] Failed to send public key:', error);
        }
    }

    async handleKeyExchange(msg) {
        if (!this.receivedPeerKey && msg.from) {
            await this.crypto.deriveSharedKey(msg.data, msg.from);
            this.receivedPeerKey = true;
            console.log('[WebRTC] Shared key derived with', msg.from?.substring(0, 8));
            
            if (!this.sentMyKey) {
                await this.sendMyKey();
            }
        }
    }

    async ensureAudio() {
        if (!this.localStream) {
            this.localStream = new MediaStream();
        }

        const existingAudio = this.localStream.getAudioTracks()?.[0];
        if (existingAudio && existingAudio.readyState === 'live') {
            return;
        }

        try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const audioTrack = audioStream.getAudioTracks()[0];
            if (audioTrack) {
                this.localStream.addTrack(audioTrack);
            }
        } catch (error) {
            console.error('Failed to get audio:', error);
        }
    }

    async sendMessage(text) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            this.messageQueue.push(text);
            return false;
        }

        if (!this.crypto.hasSharedKey(this.targetUUID)) {
            this.messageQueue.push(text);
            return false;
        }

        try {
            const encrypted = await this.crypto.encrypt({ from: this.uuid, text }, this.targetUUID);
            this.dataChannel.send(JSON.stringify(encrypted));
            return true;
        } catch (error) {
            console.error('Failed to send message:', error);
            return false;
        }
    }

    async flushMessageQueue() {
        const messages = [...this.messageQueue];
        this.messageQueue = [];

        for (const text of messages) {
            const sent = await this.sendMessage(text);
            if (!sent) {
                this.messageQueue.push(text);
            }
        }
    }

    async replaceAudioTrack(track) {
        if (!this.pc) return;

        const senders = this.pc.getSenders();
        const audioSender = senders.find(s => s.track?.kind === 'audio');

        if (audioSender) {
            await audioSender.replaceTrack(track);
        } else if (track) {
            this.pc.addTrack(track, this.localStream);
        }
    }

    async replaceVideoTrack(track) {
        if (!this.pc) return;

        const senders = this.pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === 'video');

        if (videoSender) {
            await videoSender.replaceTrack(track);
        } else if (track) {
            this.pc.addTrack(track, this.localStream);
        }
    }

    async renegotiate(maxRetries = 2) {
        if (!this.pc || !this.targetUUID) {
            console.log('[WebRTC] Cannot renegotiate: no pc or target');
            return false;
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                console.log(`[WebRTC] Renegotiate retry ${attempt}/${maxRetries}`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (this.pc.signalingState === 'have-local-offer') {
                console.log('[WebRTC] Renegotiate: have-local-offer, rolling back...');
                try {
                    await this.pc.setLocalDescription({ type: 'rollback' });
                } catch (e) {
                    console.error('[WebRTC] Renegotiate rollback failed:', e);
                    continue;
                }
            }

            if (this.pc.signalingState !== 'stable') {
                console.log('[WebRTC] Renegotiate: state is', this.pc.signalingState, ', waiting...');
                await this.waitForStableState(3000);
            }

            if (this.pc.signalingState !== 'stable') {
                console.log('[WebRTC] Renegotiate: still not stable (', this.pc.signalingState, ')');
                continue;
            }

            try {
                const senders = this.pc.getSenders();
                console.log('[WebRTC] Renegotiate, senders:', senders.map(s => s.track?.kind + ':' + s.track?.id?.substring(0, 8)));

                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);

                console.log('[WebRTC] Renegotiation offer sent, has video:', offer.sdp?.includes('m=video'));

                this.signaling.send({
                    type: 'offer',
                    to: this.targetUUID,
                    from: this.uuid,
                    data: offer
                });
                return true;
            } catch (error) {
                console.error('[WebRTC] Renegotiation failed:', error);
                continue;
            }
        }

        console.error('[WebRTC] Renegotiation failed after', maxRetries, 'retries');
        return false;
    }

    async addScreenTrack(screenTrack, screenStream, screenAudioTrack = null) {
        if (!this.pc) {
            console.log('[WebRTC] addScreenTrack: no peer connection');
            return false;
        }

        this.screenShareTrack = screenTrack;

        screenTrack.addEventListener('ended', async () => {
            console.log('[WebRTC] Screen track ended event');
            await this.removeScreenTrack();
        });

        const transceivers = this.pc.getTransceivers();
        const videoTransceiver = transceivers.find(t => t.sender.track?.kind === 'video');

        if (videoTransceiver) {
            console.log('[WebRTC] Screen share: existing video transceiver', videoTransceiver.mid, 'direction:', videoTransceiver.direction, 'current:', videoTransceiver.currentDirection);

            this.savedVideoTrack = videoTransceiver.sender.track;

            videoTransceiver.direction = 'sendrecv';

            await videoTransceiver.sender.replaceTrack(screenTrack);
            console.log('[WebRTC] Screen track replaced, direction set to sendrecv');
        } else {
            console.log('[WebRTC] Screen share: adding new video transceiver');
            videoTransceiver = this.pc.addTransceiver(screenTrack, { direction: 'sendrecv' });
        }

        if (screenAudioTrack?.readyState === 'live') {
            const audioSenders = this.pc.getSenders().filter(s => s.track?.kind === 'audio');
            const screenAudioSender = audioSenders.find(s => s.track?.label?.toLowerCase().includes('screen'));
            if (screenAudioSender) {
                await screenAudioSender.replaceTrack(screenAudioTrack);
            } else {
                this.pc.addTrack(screenAudioTrack, screenStream);
            }
        }

        const ok = await this.renegotiate();
        if (!ok) {
            console.warn('[WebRTC] Screen share renegotiation failed');
        }
        return ok;
    }

    async removeScreenTrack(restoreAudioTrack = null) {
        if (!this.pc) return;

        delete this.screenShareTrack;

        const senders = this.pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === 'video');
        const screenAudioSender = senders.find(s => s.track?.kind === 'audio' && s.track?.label?.toLowerCase().includes('screen'));
        
        if (videoSender) {
            console.log('[WebRTC] Removing screen video track');
            if (this.savedVideoTrack && this.savedVideoTrack.readyState === 'live') {
                console.log('[WebRTC] Restoring original video track');
                await videoSender.replaceTrack(this.savedVideoTrack);
                delete this.savedVideoTrack;
            } else {
                console.log('[WebRTC] Replacing with black track');
                const blackTrack = this.createBlackVideoTrack();
                await videoSender.replaceTrack(blackTrack);
                delete this.savedVideoTrack;
            }
            
            const transceivers = this.pc.getTransceivers();
            const videoTransceiver = transceivers.find(t => t.sender === videoSender);
            if (videoTransceiver && videoTransceiver.direction === 'sendonly') {
                videoTransceiver.direction = 'sendrecv';
            }
        }

        if (screenAudioSender) {
            console.log('[WebRTC] Removing screen audio track');
            if (restoreAudioTrack) {
                await screenAudioSender.replaceTrack(restoreAudioTrack);
            } else {
                const audioTrack = this.localStream?.getAudioTracks()?.[0];
                if (audioTrack) {
                    await screenAudioSender.replaceTrack(audioTrack);
                }
            }
        }

        const ok = await this.renegotiate();
        if (!ok) {
            console.warn('[WebRTC] Screen share remove renegotiation failed');
        }
    }

    createBlackVideoTrack() {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0];
        track.enabled = true;
        return track;
    }

    hangup() {
        if (this.dataChannel) {
            try {
                this.dataChannel.close();
            } catch (e) {}
            this.dataChannel = null;
        }

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        this.remoteTracks.clear();
        this.pendingICE = [];
        this.messageQueue = [];
        this.isConnected = false;
    }
}
