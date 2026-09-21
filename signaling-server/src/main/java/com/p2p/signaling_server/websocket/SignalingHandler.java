package com.p2p.signaling_server.websocket;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import com.p2p.signaling_server.room.RoomManager;

@Component
public class SignalingHandler extends TextWebSocketHandler {

    @Autowired
    private RoomManager roomManager;
    
    //test
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        
        //test
        JsonNode jsonNode = objectMapper.readTree(payload);
        //test
        String roomId = jsonNode.has("roomId") ? jsonNode.get("roomId").asText() : null;
        String type = jsonNode.has("type") ? jsonNode.get("type").asText() : null;

        if (roomId == null || type == null) return;

        if ("JOIN".equals(type)) {
            roomManager.joinRoom(roomId, session);
            System.out.println("User " + session.getId() + " joined " + roomId);
            
            //test
            String joinMsg = "{\"type\":\"JOINED\",\"sessionId\":\"" + session.getId() + "\"}";
            roomManager.broadcastToRoomExcept(roomId, session, joinMsg);
        } 
        else if ("OFFER".equals(type) || "ANSWER".equals(type) || "ICE".equals(type)) {
            roomManager.broadcastToRoomExcept(roomId, session, payload);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        roomManager.leaveRoom(session);
        System.out.println("Session closed: " + session.getId());
    }
}