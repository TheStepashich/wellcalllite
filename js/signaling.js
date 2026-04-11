export class Signaling {
    constructor(uuid, onMessage, roomId = null) {
        this.uuid = uuid;
        this.roomId = roomId;
        this.onMessage = onMessage;
        this.ws = null;
        this.registered = false;
        this.queue = [];
        this.sessionId = `${uuid}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.heartbeatInterval = null;
        this.connect();
    }

    connect() {
        if (this.ws) {
            this.stopHeartbeat();
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            try {
                this.ws.close();
            } catch (e) {}
        }

        this.ws = new WebSocket('wss://wellcall.weltenmc.ru/ws/');
        this.registered = false;

        this.ws.onopen = () => {
            this.send({
                type: 'register',
                uuid: this.uuid,
                session_id: this.sessionId
            });
            this.startHeartbeat();
        };

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);

                if (msg.type === 'registered' && msg.status === 'success') {
                    this.registered = true;
                    this.reconnectAttempts = 0;
                    this.flushQueue();
                }

                const ignoreOwnSession = msg.session_id === this.sessionId;
                const systemTypes = [
                    'registered', 'pong', 'presence',
                    'group-room-member-joined', 'group-call-leave'
                ];

                if (!ignoreOwnSession || systemTypes.includes(msg.type)) {
                    this.onMessage?.(msg);
                }
            } catch (error) {
                console.error('Signaling parse error:', error);
            }
        };

        this.ws.onclose = (e) => {
            this.registered = false;
            this.stopHeartbeat();

            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = Math.min(3000 * this.reconnectAttempts, 30000);
                setTimeout(() => this.connect(), delay);
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    send(message) {
        if (message.type !== 'register' && !message.session_id) {
            message.session_id = this.sessionId;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.queue.push(message);
            return false;
        }

        if (!this.registered && message.type !== 'register') {
            this.queue.push(message);
            return false;
        }

        this.ws.send(JSON.stringify(message));
        return true;
    }

    flushQueue() {
        if (this.queue.length === 0) return;

        const messages = [...this.queue];
        this.queue = [];

        for (const msg of messages) {
            this.send(msg);
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'ping',
                    uuid: this.uuid,
                    session_id: this.sessionId
                }));
            }
        }, 30000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    close() {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
        }
    }
}
