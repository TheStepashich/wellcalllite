export class VolumeManager {
    constructor() {
        this.audioContext = null;
        this.gainNodes = new Map();
        this.sources = new Map();
        this.streams = new Map();
        this.mediaElements = new Map();
        this.volumes = new Map();
    }

    getAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        return this.audioContext;
    }

    createGainNode(peerId) {
        if (this.gainNodes.has(peerId)) {
            return this.gainNodes.get(peerId);
        }

        const ctx = this.getAudioContext();
        const gainNode = ctx.createGain();
        gainNode.connect(ctx.destination);
        gainNode.gain.value = this.volumes.get(peerId) ?? 1.0;
        
        this.gainNodes.set(peerId, gainNode);
        return gainNode;
    }

    async ensureAudioContext() {
        const ctx = this.getAudioContext();
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }
        return ctx;
    }

    async attachStream(peerId, stream) {
        if (!stream) return;

        const ctx = await this.ensureAudioContext();
        
        const gainNode = this.createGainNode(peerId);
        
        this.streams.set(peerId, stream);

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;

        const existingSource = this.sources.get(peerId);
        if (existingSource) {
            try {
                existingSource.disconnect();
            } catch (e) {}
        }

        try {
            const source = ctx.createMediaStreamSource(stream);
            source.connect(gainNode);
            this.sources.set(peerId, source);
        } catch (e) {
            console.warn('[VolumeManager] Failed to connect stream:', e);
        }
    }

    attachMediaElement(peerId, mediaElement) {
        if (!mediaElement) return;

        const ctx = this.getAudioContext();
        const gainNode = this.createGainNode(peerId);
        
        this.mediaElements.set(peerId, mediaElement);

        try {
            const source = ctx.createMediaStreamSource(mediaElement.srcObject);
            source.connect(gainNode);
        } catch (e) {
            try {
                const dest = ctx.createMediaStreamDestination();
                const source = ctx.createMediaStreamSource(mediaElement.srcObject);
                source.connect(dest);
                source.connect(gainNode);
                mediaElement.srcObject = dest.stream;
            } catch (e2) {
                console.warn('[VolumeManager] Failed to attach media element:', e2);
            }
        }
    }

    async setVolume(peerId, volume) {
        volume = Math.max(0, Math.min(1, volume));
        this.volumes.set(peerId, volume);
        console.log('[VolumeManager] setVolume', peerId?.substring(0, 8), 'volume:', volume);

        await this.ensureAudioContext();
        
        const gainNode = this.gainNodes.get(peerId);
        console.log('[VolumeManager] gainNode exists:', !!gainNode, 'sources:', this.sources.size, 'gain.value:', gainNode?.gain.value);
        if (gainNode) {
            gainNode.gain.value = volume;
            console.log('[VolumeManager] gain.value =', volume);
        }
    }

    getVolume(peerId) {
        return this.volumes.get(peerId) ?? 1.0;
    }

    mute(peerId) {
        const gainNode = this.gainNodes.get(peerId);
        if (gainNode) {
            gainNode.gain.setValueAtTime(0, gainNode.context.currentTime);
        }
    }

    unmute(peerId) {
        const volume = this.volumes.get(peerId) ?? 1.0;
        const gainNode = this.gainNodes.get(peerId);
        if (gainNode) {
            gainNode.gain.setValueAtTime(volume, gainNode.context.currentTime);
        }
    }

    removePeer(peerId) {
        const source = this.sources.get(peerId);
        if (source) {
            try {
                source.disconnect();
            } catch (e) {}
            this.sources.delete(peerId);
        }
        const gainNode = this.gainNodes.get(peerId);
        if (gainNode) {
            gainNode.disconnect();
            this.gainNodes.delete(peerId);
        }
        this.streams.delete(peerId);
        this.mediaElements.delete(peerId);
        this.volumes.delete(peerId);
    }

    destroy() {
        for (const [peerId] of this.gainNodes) {
            this.removePeer(peerId);
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
}
