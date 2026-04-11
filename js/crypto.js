export class CryptoHandler {
    constructor() {
        this.keyPair = null;
        this.sharedKeys = new Map();
        this.isInitialized = false;
    }

    async init() {
        this.keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey']
        );
        this.isInitialized = true;
    }

    async exportPublicKey() {
        const raw = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
        return Array.from(new Uint8Array(raw));
    }

    async importPublicKey(raw) {
        return crypto.subtle.importKey(
            'raw',
            new Uint8Array(raw),
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            []
        );
    }

    async deriveSharedKey(peerPublicKeyRaw, targetUUID) {
        const peerKey = await this.importPublicKey(peerPublicKeyRaw);
        const sharedKey = await crypto.subtle.deriveKey(
            { name: 'ECDH', public: peerKey },
            this.keyPair.privateKey,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
        this.sharedKeys.set(targetUUID, sharedKey);
    }

    hasSharedKey(targetUUID) {
        return this.sharedKeys.has(targetUUID);
    }

    async encrypt(data, targetUUID) {
        const key = this.sharedKeys.get(targetUUID);
        if (!key) {
            throw new Error(`No shared key for ${targetUUID}`);
        }

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(JSON.stringify(data));

        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            encoded
        );

        return {
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted))
        };
    }

    async decrypt(payload, targetUUID) {
        const key = this.sharedKeys.get(targetUUID);
        if (!key) {
            throw new Error(`No shared key for ${targetUUID}`);
        }

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
            key,
            new Uint8Array(payload.data)
        );

        return JSON.parse(new TextDecoder().decode(decrypted));
    }
}
