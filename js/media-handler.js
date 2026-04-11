export class MediaHandler {
    constructor() {
        this.localStream = null;
        this.screenStream = null;
        this.blackVideoTrack = null;
        this.isAudioEnabled = true;
        this.isVideoEnabled = false;
        this.isScreenSharing = false;
        this.isScreenAudioEnabled = false;
        this.currentFacingMode = 'user';
        this.pendingVideoTrack = null;
    }

    async initialize() {
        try {
            await this.ensureAudio();
        } catch (error) {
            console.error('Failed to initialize audio:', error);
        }
    }

    async ensureAudio() {
        const existingTrack = this.localStream?.getAudioTracks()?.[0];

        if (existingTrack && existingTrack.readyState === 'live') {
            existingTrack.enabled = this.isAudioEnabled;
            return this.localStream;
        }

        const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        });

        const audioTrack = audioStream.getAudioTracks()[0];
        if (!audioTrack) return this.localStream || new MediaStream();

        if (!this.localStream) {
            this.localStream = new MediaStream();
        }

        this.localStream.addTrack(audioTrack);
        audioTrack.enabled = this.isAudioEnabled;

        return this.localStream;
    }

    getAudioTrackSync() {
        return this.localStream?.getAudioTracks()?.[0] || null;
    }

    getVideoTrackSync() {
        return this.localStream?.getVideoTracks()?.[0] || null;
    }

    async createVideoTrack() {
        const desiredFacingMode = this.currentFacingMode;

        if (this.pendingVideoTrack) {
            return this.pendingVideoTrack;
        }

        const existingTrack = this.getVideoTrackSync();
        if (existingTrack && existingTrack.readyState === 'live' && existingTrack.enabled) {
            return existingTrack;
        }

        this.pendingVideoTrack = navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: desiredFacingMode
            }
        }).then(videoStream => {
            const videoTrack = videoStream.getVideoTracks()[0];
            if (!videoTrack) throw new Error('No video track');

            if (!this.localStream) {
                this.localStream = new MediaStream();
            }

            this.localStream.getVideoTracks().forEach(t => {
                if (t !== videoTrack) {
                    this.localStream.removeTrack(t);
                    t.stop();
                }
            });

            this.localStream.addTrack(videoTrack);
            this.isVideoEnabled = true;
            this.pendingVideoTrack = null;

            return videoTrack;
        }).catch(error => {
            this.pendingVideoTrack = null;
            throw error;
        });

        return this.pendingVideoTrack;
    }

    async switchCamera() {
        const currentTrack = this.getVideoTrackSync();
        if (!currentTrack) return null;

        const newFacingMode = this.currentFacingMode === 'user' ? 'environment' : 'user';

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: newFacingMode
                }
            });

            const newTrack = newStream.getVideoTracks()[0];
            if (!newTrack) throw new Error('No new video track');

            this.localStream.removeTrack(currentTrack);
            currentTrack.stop();
            this.localStream.addTrack(newTrack);
            this.currentFacingMode = newFacingMode;

            return { oldTrack: currentTrack, newTrack };
        } catch (error) {
            console.error('Switch camera failed:', error);
            return null;
        }
    }

    async enableAudio(enabled) {
        this.isAudioEnabled = enabled;
        const track = this.getAudioTrackSync();
        if (track) {
            track.enabled = enabled;
        }
        return enabled;
    }

    async disableVideo() {
        this.isVideoEnabled = false;
        const track = this.getVideoTrackSync();
        if (track) {
            track.enabled = false;
        }
    }

    async enableVideo(enabled) {
        if (enabled) {
            const existingTrack = this.getVideoTrackSync();
            if (!existingTrack) {
                await this.createVideoTrack();
            } else {
                this.isVideoEnabled = true;
                existingTrack.enabled = true;
            }
        } else {
            await this.disableVideo();
        }
        return this.isVideoEnabled;
    }

    getBlackVideoTrack() {
        if (this.blackVideoTrack && this.blackVideoTrack.readyState === 'live') {
            return this.blackVideoTrack;
        }

        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        canvas.style.display = 'none';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const stream = canvas.captureStream(15);
        this.blackVideoTrack = stream.getVideoTracks()[0];
        this.blackVideoTrack.enabled = true;

        const animate = () => {
            if (this.blackVideoTrack && this.blackVideoTrack.readyState === 'live') {
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                requestAnimationFrame(animate);
            }
        };
        animate();

        return this.blackVideoTrack;
    }

    async startScreenShare() {
        if (this.isScreenSharing) {
            return this.screenStream?.getVideoTracks()?.[0] || null;
        }

        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 15, max: 30 } },
            audio: true
        });

        const screenTrack = this.screenStream.getVideoTracks()[0];
        if (!screenTrack) throw new Error('No screen track');

        this.isScreenSharing = true;
        this.isScreenAudioEnabled = true;

        screenTrack.addEventListener('ended', () => {
            this.stopScreenShare();
        });

        return screenTrack;
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        this.isScreenSharing = false;
        this.isScreenAudioEnabled = false;
    }

    getScreenStream() {
        return this.screenStream;
    }

    getScreenAudioTrack() {
        return this.screenStream?.getAudioTracks()?.[0] || null;
    }

    getLocalStream() {
        return this.localStream;
    }

    stopAllTracks() {
        this.stopScreenShare();

        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }

        this.isAudioEnabled = true;
        this.isVideoEnabled = false;
    }

    getState() {
        return {
            hasAudio: !!this.getAudioTrackSync(),
            audioEnabled: this.isAudioEnabled,
            hasVideo: !!this.getVideoTrackSync(),
            videoEnabled: this.isVideoEnabled,
            isScreenSharing: this.isScreenSharing
        };
    }
}
