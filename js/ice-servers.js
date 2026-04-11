export const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
        urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: [
            'turn:global.relay.metered.ca:80',
            'turn:global.relay.metered.ca:443'
        ],
        username: 'b7f8d5086f8ea2c568c6eae4',
        credential: 'GcE4Bq1xH6VjJ19F'
    }
];
