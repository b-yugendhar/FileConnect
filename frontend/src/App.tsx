import { useRef, useState, useCallback } from "react";
import "./index.css";

const TRANSFER_MODES = {
  WIFI_NEAR: { label: "Same WiFi", icon: "⚡", chunkSize: 64 * 1024, maxBuffer: 2 * 1024 * 1024 },
  WIFI_FAR: { label: "Weak WiFi", icon: "📶", chunkSize: 16 * 1024, maxBuffer: 512 * 1024 },
  MOBILE: { label: "Mobile", icon: "📱", chunkSize: 16 * 1024, maxBuffer: 256 * 1024 },
} as const;

type Mode = keyof typeof TRANSFER_MODES;

type StatusLevel = "idle" | "connected" | "active" | "error";

function getStatusLevel(status: string): StatusLevel {
  if (status.toLowerCase().includes("failed") || status.toLowerCase().includes("error")) return "error";
  if (status.includes("P2P Connected")) return "connected";
  if (status.includes("Sending") || status.includes("Receiving") || status.includes("Joined")) return "active";
  return "idle";
}

function extractPercent(status: string): number | null {
  const m = status.match(/([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

export default function App() {
  const [status, setStatus] = useState("Ready to connect");
  const [room, setRoom] = useState("room1");
  const [mode, setMode] = useState<Mode>("MOBILE");
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const selectedFileRef = useRef<File | null>(null);

  const receivedChunks = useRef<ArrayBuffer[]>([]);
  const incomingFile = useRef<{ name: string; size: number } | null>(null);
  const receivedBytes = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);

  const handleIncoming = (e: MessageEvent) => {
    const data = e.data;
    if (typeof data === "string") {
      const msg = JSON.parse(data);
      if (msg.type === "META") {
        incomingFile.current = msg;
        receivedChunks.current = [];
        receivedBytes.current = 0;
        setStatus(`Receiving: ${msg.name}...`);
      } else if (msg.type === "DONE" && incomingFile.current) {
        const blob = new Blob(receivedChunks.current);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = incomingFile.current.name; a.click();
        setStatus(`✅ Received: ${incomingFile.current.name}`);
        incomingFile.current = null;
        receivedChunks.current = [];
      }
    } else {
      receivedChunks.current.push(data);
      receivedBytes.current += data.byteLength;
      const now = Date.now();
      if (now - lastUpdateRef.current > 300) {
        if (incomingFile.current) {
          const pct = ((receivedBytes.current / incomingFile.current.size) * 100).toFixed(1);
          setStatus(`Receiving: ${pct}%`);
        }
        lastUpdateRef.current = now;
      }
    }
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 0;
    channel.onopen = () => { setStatus("P2P Connected!"); setConnected(true); };
    channel.onmessage = handleIncoming;
    dcRef.current = channel;
  };

  const forceHighBandwidth = (sdp: string) => {
    try {
      if (sdp.includes("m=application"))
        return sdp.replace(/(m=application\s\d+\s[A-Z\/]+\s.*)/, '$1\r\nb=AS:500000');
      return sdp;
    } catch { return sdp; }
  };

  const connect = () => {
    const wsUrl = import.meta.env.VITE_SIGNALING_URL ||
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? `ws://${window.location.hostname}:8081/ws`
        : "wss://fileconnect.onrender.com/ws");

    setStatus(`Connecting…`);
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      ],
    });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ICE", roomId: room, candidate: e.candidate }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { setStatus("P2P Connected!"); setConnected(true); }
      else if (pc.connectionState === "failed") setStatus("Connection failed — ensure both peers joined the same room.");
    };
    pc.ondatachannel = (e) => setupDataChannel(e.channel);

    socket.onerror = () => setStatus(`WebSocket error — is the server running?`);
    socket.onclose = () => { setConnected(false); };
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "JOIN", roomId: room }));
      setStatus("Joined room — waiting for peer…");
    };

    let offered = false;
    socket.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "JOINED" && !offered) {
        offered = true;
        const channel = pc.createDataChannel("filetransfer");
        setupDataChannel(channel);
        const offer = await pc.createOffer();
        offer.sdp = forceHighBandwidth(offer.sdp || "");
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: "OFFER", roomId: room, sdp: offer }));
      } else if (msg.type === "OFFER") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        answer.sdp = forceHighBandwidth(answer.sdp || "");
        await pc.setLocalDescription(answer);
        socket.send(JSON.stringify({ type: "ANSWER", roomId: room, sdp: answer }));
      } else if (msg.type === "ANSWER") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } else if (msg.type === "ICE") {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(console.error);
      }
    };
  };

  const sendFile = async () => {
    const file = selectedFileRef.current ?? fileRef.current?.files?.[0];
    const dc = dcRef.current;
    if (!file || !dc || dc.readyState !== "open") { setStatus("⚠️ Connect and select a file first!"); return; }

    const { chunkSize, maxBuffer } = TRANSFER_MODES[mode];
    dc.send(JSON.stringify({ type: "META", name: file.name, size: file.size }));
    dc.bufferedAmountLowThreshold = 0;

    let offset = 0;
    const waitForBuffer = () => new Promise<void>((resolve) => {
      if (dc.bufferedAmount < maxBuffer) { resolve(); return; }
      dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
    });

    try {
      while (offset < file.size) {
        if (dc.bufferedAmount >= maxBuffer) await waitForBuffer();
        const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
        dc.send(buffer);
        offset += buffer.byteLength;
        if (offset % (chunkSize * 50) === 0 || offset >= file.size) {
          setStatus(`Sending: ${((offset / file.size) * 100).toFixed(1)}%`);
          await new Promise(r => setTimeout(r, 0));
        }
      }
      dc.send(JSON.stringify({ type: "DONE" }));
      setStatus("✅ Sent successfully!");
    } catch {
      setStatus("❌ Transfer failed");
    }
  };

  const onFileChange = useCallback((file: File) => {
    selectedFileRef.current = file;
    setFileName(file.name);
  }, []);

  const level = getStatusLevel(status);
  const pct = extractPercent(status);
  const showProgress = pct !== null;

  return (
    <div className="card">
      {/* Header */}
      <div className="header">
        <div className="icon">📡</div>
        <h1>FileConnect</h1>
        <p>Peer-to-peer file transfer — no servers, no limits</p>
      </div>

      {/* Room + Join */}
      <label>Room ID</label>
      <div className="input-row">
        <input
          id="room-input"
          type="text"
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          placeholder="Enter room name…"
        />
        <button className="btn btn-primary" onClick={connect} id="join-btn">
          {connected ? "↺ Rejoin" : "Join"}
        </button>
      </div>

      {/* Status */}
      <div className={`status-badge`}>
        <span className={`status-dot ${level}`} />
        <span>{status}</span>
      </div>

      {/* Progress */}
      <div className={`progress-wrap ${showProgress ? "visible" : ""}`}>
        <div className="progress-header">
          <span>{status.includes("Sending") ? "Uploading" : "Downloading"}</span>
          <span>{pct?.toFixed(1)}%</span>
        </div>
        <div className="progress-bar-bg">
          <div className="progress-bar-fill" style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>

      <div className="divider" />

      {/* Network mode */}
      <label>Network Mode</label>
      <div className="mode-grid">
        {(Object.keys(TRANSFER_MODES) as Mode[]).map((m) => (
          <button
            key={m}
            className={`mode-btn ${mode === m ? "active" : ""}`}
            onClick={() => setMode(m)}
            id={`mode-${m.toLowerCase()}`}
          >
            <span className="mode-icon">{TRANSFER_MODES[m].icon}</span>
            {TRANSFER_MODES[m].label}
          </button>
        ))}
      </div>

      {/* Drop zone */}
      <div
        className={`drop-zone ${dragOver ? "drag-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFileChange(f);
        }}
        onClick={() => fileRef.current?.click()}
        id="drop-zone"
      >
        <input
          ref={fileRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFileChange(f); }}
          id="file-input"
        />
        <div className="drop-icon">{fileName ? "📄" : "☁️"}</div>
        {fileName
          ? <div className="file-name">{fileName}</div>
          : <p>Drop a file here or <strong>click to browse</strong></p>
        }
      </div>

      {/* Send */}
      <button
        className="btn btn-primary"
        style={{ width: "100%", padding: "0.85rem", fontSize: "0.95rem" }}
        onClick={sendFile}
        disabled={!connected || !fileName}
        id="send-btn"
      >
        ↑ Send File
      </button>
    </div>
  );
}
