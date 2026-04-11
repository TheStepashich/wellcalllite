export function generateUUID() {
    if (!localStorage.uuid) {
        localStorage.uuid = crypto.randomUUID();
    }
    return localStorage.uuid;
}

export function getUUID() {
    return localStorage.uuid || null;
}

export function clearUUID() {
    localStorage.removeItem('uuid');
}

export function saveRoomId(roomId) {
    localStorage.roomId = roomId;
}

export function getRoomId() {
    return localStorage.roomId || null;
}

export function clearRoomId() {
    localStorage.removeItem('roomId');
}
