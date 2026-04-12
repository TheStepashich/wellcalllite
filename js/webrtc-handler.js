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
            this.onConnectionStateChange?.(state);
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

            if (state === 'failed' && this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`[WebRTC] Connection failed, retry ${this.retryCount}/${this.maxRetries} in ${this.retryDelay}ms`);
                setTimeout(() => this.retryConnection(), this.retryDelay);
                this.retryDelay *= 1.5;
            }
        };

        return this.pc;
    }

    async retryConnection() {
        if (!this.targetUUID) return;

        this.retryCount++;
        this.offerGeneration++;
        
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

        await this.sendMyKey();

        const audioTrack = this.localStream?.getAudioTracks()?.[0];
        if (audioTrack) {
            this.pc.addTrack(audioTrack, this.localStream);
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
        this.targetUUID = msg.from;

        const isRenegotiation = this.pc && 
                                this.pc.signalingState === 'stable' && 
                                this.pc.remoteDescription && 
                                this.pc.connectionState === 'connected';

        if (isRenegotiation) {
            console.log('[WebRTC] Renegotiation offer received, processing...');
            
            try {
                await this.pc.setRemoteDescription(msg.data);
                console.log('[WebRTC] Renegotiation: remote description set');

                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);

                console.log('[WebRTC] Renegotiation answer created, sending...');

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
                console.error('[WebRTC] Renegotiation failed:', e);
            }
        }

        if (this.pc) {
            console.log('[WebRTC] Closing existing connection for new call');
            this.pc.close();
        }

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

    flushMessageQueue() {
        const messages = [...this.messageQueue];
        this.messageQueue = [];

        for (const text of messages) {
            this.sendMessage(text);
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

    async renegotiate() {
        if (!this.pc || !this.targetUUID) return;

        if (this.pc.signalingState !== 'stable') {
            console.log('[WebRTC] Not stable, waiting...');
            await this.waitForStableState(5000);
        }

        if (this.pc.signalingState !== 'stable') {
            console.log('[WebRTC] Still not stable, skipping renegotiation');
            return;
        }

        try {
            const senders = this.pc.getSenders();
            console.log('[WebRTC] Renegotiate, senders:', senders.map(s => s.track?.kind + ':' + s.track?.id?.substring(0, 8)));

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            console.log('[WebRTC] Renegotiation offer sent, has video:', offer.sdp?.includes('m=video'));
            console.log('[WebRTC] SDP video part:', offer.sdp?.match(/m=video[\s\S]*?(?=m=|$)/)?.[0]);

            this.signaling.send({
                type: 'offer',
                to: this.targetUUID,
                from: this.uuid,
                data: offer
            });
        } catch (error) {
            console.error('[WebRTC] Renegotiation failed:', error);
        }
    }

    async addScreenTrack(screenTrack, screenStream, screenAudioTrack = null) {
        if (!this.pc) return;

        const senders = this.pc.getSenders();
        console.log('[WebRTC] addScreenTrack, current senders:', senders.map(s => s.track?.kind + ':' + s.track?.id?.substring(0, 8)));
        console.log('[WebRTC] addScreenTrack, screenTrack:', screenTrack.id, 'label:', screenTrack.label, 'settings:', screenTrack.getSettings());

        const videoSender = senders.find(s => s.track?.kind === 'video');
        
        screenTrack.addEventListener('ended', () => {
            console.log('[WebRTC] Screen track ended event');
            this.removeScreenTrack();
        });
        
        if (videoSender) {
            console.log('[WebRTC] Replacing video track for screen share');
            await videoSender.replaceTrack(screenTrack);
            
            const transceivers = this.pc.getTransceivers();
            console.log('[WebRTC] Transceivers:', transceivers.map(t => t.mid + ':' + t.direction));
            
            const videoTransceiver = transceivers.find(t => t.sender === videoSender);
            if (videoTransceiver) {
                console.log('[WebRTC] Video transceiver currentDirection:', videoTransceiver.currentDirection);
                if (videoTransceiver.currentDirection === 'sendrecv') {
                    videoTransceiver.direction = 'sendonly';
                }
                console.log('[WebRTC] Set transceiver direction');
            }
        } else {
            console.log('[WebRTC] Adding screen track');
            this.pc.addTrack(screenTrack, screenStream);
        }

        if (screenAudioTrack) {
            const audioSender = senders.find(s => s.track?.kind === 'audio' && s.track?.label?.toLowerCase().includes('screen'));
            if (audioSender) {
                console.log('[WebRTC] Replacing screen audio track');
                await audioSender.replaceTrack(screenAudioTrack);
            } else {
                console.log('[WebRTC] Adding screen audio track');
                this.pc.addTrack(screenAudioTrack, screenStream);
            }
        }

        await this.renegotiate();
        console.log('[WebRTC] Screen track added, renegotiation complete');
    }

    async removeScreenTrack(restoreAudioTrack = null) {
        if (!this.pc) return;

        const senders = this.pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === 'video');
        const screenAudioSender = senders.find(s => s.track?.kind === 'audio' && s.track?.label?.toLowerCase().includes('screen'));
        
        if (videoSender) {
            console.log('[WebRTC] Replacing video track with black');
            const blackTrack = this.createBlackVideoTrack();
            await videoSender.replaceTrack(blackTrack);
            console.log('[WebRTC] Screen track replaced with black');
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
