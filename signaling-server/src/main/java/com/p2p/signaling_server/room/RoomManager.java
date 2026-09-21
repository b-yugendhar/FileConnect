package com.p2p.signaling_server.room;

import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

@Component
public class RoomManager {

    private final Map<String, Set<WebSocketSession>> rooms = new HashMap<>();

    public synchronized void joinRoom(String roomId, WebSocketSession session) {
        rooms.computeIfAbsent(roomId, k -> new HashSet<>()).add(session);
    }

    public synchronized void leaveRoom(WebSocketSession session) {
        for (Set<WebSocketSession> members : rooms.values()) {
            members.remove(session);
        }
    }

    public synchronized Set<WebSocketSession> getRoomMembers(String roomId) {
        return rooms.getOrDefault(roomId, Collections.emptySet());
    }

    public synchronized void broadcastToRoomExcept(String roomId, WebSocketSession sender, String message) {
        for (WebSocketSession s : getRoomMembers(roomId)) {
            if (!s.getId().equals(sender.getId())) {
                try {
                    s.sendMessage(new org.springframework.web.socket.TextMessage(message));
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }
    }
    public synchronized Set<WebSocketSession> joinAndGetMembers(String roomId, WebSocketSession session) {
    rooms.computeIfAbsent(roomId, k -> new HashSet<>()).add(session);
    return new HashSet<>(rooms.get(roomId)); 
}
public synchronized void sendToPeer(String roomId, String targetSessionId, String message) {
    Set<WebSocketSession> members = rooms.get(roomId);
    if (members != null) {
        members.stream()
            .filter(s -> s.getId().equals(targetSessionId))
            .findFirst()
            .ifPresent(s -> {
                try {
                    s.sendMessage(new org.springframework.web.socket.TextMessage(message));
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
    }
}

}
