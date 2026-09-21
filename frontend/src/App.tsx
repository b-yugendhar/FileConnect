import { useRef, useState } from "react";

const TRANSFER_MODES = {
  WIFI_NEAR: { 
    //cchange later
    chunkSize: 64 * 1024,   
    maxBuffer: 2 * 1024 * 1024 
  },
  WIFI_FAR: { 
    chunkSize: 16 * 1024,   
    maxBuffer: 512 * 1024     
  },
  MOBILE: { 
    chunkSize: 16 * 1024,     
    maxBuffer: 256 * 1024     )
  }
};

export default function App() {
  const [status, setStatus] = useState("Disconnected");
  const [room, setRoom] = useState("room1");
  const [mode, setMode] = useState<"WIFI_NEAR" | "WIFI_FAR" | "MOBILE">("MOBILE");

  const socketRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
        a.href = url;
        a.download = incomingFile.current.name;
        a.click();
        setStatus(`File received: ${incomingFile.current.name}`);
        incomingFile.current = null;
        receivedChunks.current = [];
      }
    } else {
      receivedChunks.current.push(data);
      receivedBytes.current += data.byteLength;
      
      const now = Date.now();
      if (now - lastUpdateRef.current > 500) {//change later
         if (incomingFile.current) {
             const percent = ((receivedBytes.current / incomingFile.current.size) * 100).toFixed(1);
             setStatus(`Receiving: ${percent}%`);
         }
         lastUpdateRef.current = now;
      }
    }
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
   //change later
    channel.bufferedAmountLowThreshold = 0;
    channel.onopen = () => setStatus("P2P Connected!");
    channel.onmessage = handleIncoming;
    dcRef.current = channel;
  };

  const forceHighBandwidth = (sdp: string) => {
    return sdp.replace(/(m=application\s\d+\sUDP\/DTLS\/SCTP\s.*)/, '$1\r\nb=AS:500000');
  };

  const connect = () => {
    setStatus("Connecting...");
    const socket = new WebSocket("wss://signaling-server-production-97a2.up.railway.app/ws");
    socketRef.current = socket;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ],
    });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ICE", roomId: room, candidate: e.candidate }));
      }
    };

    pc.ondatachannel = (e) => setupDataChannel(e.channel);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "JOIN", roomId: room }));
      setStatus("Joined room. Waiting for peer...");
    };

    socket.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "JOINED") {
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
    const file = fileRef.current?.files?.[0];
    const dc = dcRef.current;

    if (!file || !dc || dc.readyState !== "open") return alert("Connect first!");

    dc.send(JSON.stringify({ type: "META", name: file.name, size: file.size }));

    const config = TRANSFER_MODES[mode];
    const { chunkSize, maxBuffer } = config;
    //change
    dc.bufferedAmountLowThreshold = 0;

    let offset = 0;

    const waitForBuffer = () => {
      return new Promise<void>((resolve) => {
        if (dc.bufferedAmount < maxBuffer) {
          resolve();
        } else {
          //test
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            resolve();
          };
        }
      });
    };

    try {
      while (offset < file.size) {
        if (dc.bufferedAmount >= maxBuffer) {
           await waitForBuffer();
        }

        const slice = file.slice(offset, offset + chunkSize);
        const buffer = await slice.arrayBuffer();
        dc.send(buffer);
        offset += buffer.byteLength;

      //test
        if (offset % (chunkSize * 50) === 0 || offset === file.size) {
           const percent = ((offset / file.size) * 100).toFixed(1);
           setStatus(`Sending: ${percent}%`);
           //test
           await new Promise(r => setTimeout(r, 0));
        }
      }

      dc.send(JSON.stringify({ type: "DONE" }));
      setStatus("Sent Successfully!");
    } catch (err) {
      console.error(err);
      setStatus("Transfer Failed");
    }
  };

  return (
    <div style={{ padding: "40px", textAlign: "center", fontFamily: "sans-serif" }}>
      <h2>P2P File Transfer</h2>
      
      <div style={{marginBottom: '20px'}}>
        <label>Network Mode: </label>
        <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{padding: '5px'}}>
          <option value="WIFI_NEAR">Same WiFi (Fastest)</option>
          <option value="WIFI_FAR">Weak WiFi / Far</option>
          <option value="MOBILE">Mobile Data (Stable)</option>
        </select>
      </div>

      <input value={room} onChange={(e) => setRoom(e.target.value)} style={{padding: '12px', width: '150px'}} />
      <button onClick={connect} style={{padding: '12px'}}>Join</button>
      <p>Status: <strong>{status}</strong></p>
      <hr />
      <div style={{marginTop: '20px'}}>
        <input ref={fileRef} type="file" />
        <button 
          onClick={sendFile} 
          style={{display: 'block', margin: '20px auto', padding: '15px 30px', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '5px', fontSize: '18px'}}
        >
            Send File
        </button>
      </div>
    </div>
  );
}
