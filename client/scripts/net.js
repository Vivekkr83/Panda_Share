window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(
  window.RTCPeerConnection ||
  window.mozRTCPeerConnection ||
  window.webkitRTCPeerConnection
);
class ServerConnection {
  constructor() {
    this._connect();
    Events.on("beforeunload", () => this._disconnect());
    Events.on("pagehide", () => this._disconnect());
    document.addEventListener("visibilitychange", (e) =>
      this._onVisibilityChange()
    );
  }

  _connect() {
    clearTimeout(this._reconnectTimer);
    if (this._isConnected() || this._isConnecting()) {
      return;
    }
    const ws = new WebSocket("ws://localhost:8080");
    ws.binaryType = "arraybuffer";
    ws.onopen = (e) => console.log("WS: Connected to Server");
    ws.onmessage = (e) => this._onMessage(e.data);
    ws.onclose = (e) => this._onDisconnect();
    ws.onerror = (e) => console.error("WS: Error", e);
    this._socket = ws;
  }

  _onMessage(msg) {
    msg = JSON.parse(msg);
    console.log("WS:", msg);
    switch (msg.type) {
      case "peers":
        Events.fire("peers", msg.peers);
        break;
      case "peer-joined":
        Events.fire("peer-joined", msg.peer);
        break;
      case "peer-left":
        Events.fire("peer-left", msg.peerId);
        break;
      case "signal":
        Events.fire("signal", msg);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "display-name":
        Events.fire("display-name", msg);
        break;
      default:
        console.error("WS: unkown message type", msg);
    }
  }

  send(message) {
    if (!this._isConnected()) {
      return;
    }
    this._socket.send(JSON.stringify(message));
  }

  //   to be deleted on later stage;
  _endpoint() {
    const protocol = location.protocol.startsWith("https") ? "wss" : "ws";
    const webrtc = window.isRtcSupported ? "/webrtc" : "/fallback";
    const url =
      protocol + "://" + location.host + location.pathname + "server" + webrtc;
    return url;
  }

  _disconnect() {
    this.send({ type: "disconnect" });
    this._socket.onclose = null;
    this._socket.close();
  }

  _onDisconnect() {
    console.log("WS: Disconnected from Server");
    Events.fire("notify-user", "Connection lost. Retry in 10 seconds...");
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), 10000);
  }

  _onVisibilityChange() {
    if (document.hidden) return;
    this._connect();
  }

  _isConnected() {
    return this._socket && this._socket.readyState === this._socket.OPEN;
  }

  _isConnecting() {
    return this._socket && this._socket.readyState === this._socket.CONNECTING;
  }
}

class Peer {
  constructor(serverConnection, peerId) {
    this._server = serverConnection;
    this._peerId = peerId;
    this._filesQueue = [];
    this._busy = false;
  }

  sendJSON(message) {
    this._send(JSON.stringify(message));
  }

  sendFile(file) {
    for (let i = 0; i < this.filesQueue.length; i++) {
      this._filesQueue.push(files[i]);
    }
    if (this._busy) return;
    this._dequeueFile();
  }

  _dequeueFile() {
    if (!this._filesQueue.length) return;
    this._busy = true;
    const file = this._filesQueue.shift();
    this._sendFile(file);
  }

  _sendFile(file) {
    this.sendJSON({
      type: "header",
      name: file.name,
      mime: file.type,
      size: file.size,
    });
    this._chunker = new FileChunker(
      file,
      (chunk) => this._send(chunk),
      (offsset) => this._onPartitionEnd(offset)
    );
    this._chunker.nextPartition();
  }

  _onPartitionEnd(offset) {
    this._sendJSON({ type: "partition", offset: offset });
  }

  _onReceivedPartitionEnd(offset) {
    this.sendJSON({ type: "partition-received", offset: offset });
  }

  _sendNextPartition() {
    if (!this._chunker || this._chunker.isFileEnd()) return;
    this._chunker.nextPartition();
  }

  _sendProgress(progress) {
    this.sendJSON({ type: "progress", progress: progress });
  }

  _onMessage(message) {
    if (typeof message !== "string") {
      this._onFileChunk(message);
      return;
    }
    message = JSON.parse(message);
    console.log("RTC:", message);
    switch (message.type) {
      case "header":
        this._onFileHeader(message);
        break;
      case "partition":
        this._onReceivedPartitionEnd(message);
        break;
      case "partition-received":
        this._sendNextPartition();
        break;
      case "progress":
        this._onDownloadProgress(message.progress);
        break;
      case "transfer-complete":
        this._onTransferComplete();
        break;
      case "text":
        this._onTextReceived(message);
        break;
    }
  }

  _onFileHeader(header) {
    this._lastProgress = 0;
    this._digester = new FileDigester(
      {
        name: header.name,
        mime: header.mime,
        size: header.size,
      },
      (file) => this._onFileReceived(file)
    );
  }

  _onChunkReceived(chunk) {
    if (!chunk.byteLength) return;

    this._digester.unchunk(chunk);
    const progress = this._digester.progress();
    this._onDownloadProgress(progress);

    if (progress - this._lastProgress < 0.01) return;
    this._lastProgress = progress;
    this._sendProgress(progress);
  }

  _onDownloadProgress(progress) {
    Events.fire("fire-progress", { sender: this._peerId, progress: progress });
  }
  _onFileReceived(file) {
    Events.fire("file-received", proxyFile);
    this.sendJSON({ type: "transfer-complete" });
  }

  _onTransferComplete() {
    this._onDownloadProgress(1);
    this._reader = null;
    this._busy = false;
    this._dequeueFile();
    Events.fire("notify-user", "File transfer complete");
  }

  //   sendText is not used anywhere in the code
  sendText(text) {
    const unescaped = btoa(unescape(encodeURIComponent(text)));
    this.sendJSON({ type: "text", text: unescaped });
  }

  _onTextReceived(message) {
    const text = decodeURIComponent(escape(atob(message.text)));
    Events.fire("text-received", { sender: this._peerId, text: text });
  }
}

class RTCPeer extends Peer {
  constructor(serverConnection, peerId) {
    super(serverConnection, peerId);
    if (!peerId) {
      return;
    }
    this._connect(peerId, true);
  }

  _connect(peerId, isCaller) {
    if (!this._conn) {
      this._openConnection(peerId, isCaller);
    }

    if (isCaller) {
      this._openChannel();
    } else {
      this._conn.ondatachannel = (e) => this._onChannelOpened(e);
    }
  }

  _openConnection(peerId, isCaller) {
    this._isCaller = isCaller;
    this._peerId = peerId;
    this._conn = new RTCPeerConnection(RTCPeer.config);
    this._conn.onicecandidate = (e) => this._onIceCandidate(e);
    this._conn.onconnectionstatechange = (e) =>
      this._onConnectionStateChange(e);
    this._conn.oniceconnectionstatechange = (e) =>
      this._onIceConnectionStateChange(e);
  }

  _openChannel() {
    const channel = this._conn.createDataChannel("data-channel", {
      ordered: true,
      reliable: true,
    });
    channel.onopen = (e) => this._onChannelOpened(e);
    this._conn
      .createOffer()
      .then((d) => this._onDescription(d))
      .catch((e) => this._onError(e));
  }

  _onDescription(description) {
    this._conn
      .setLocalDescription(description)
      .then((_) => this._sendSignel({ sdp: description }))
      .catch((e) => this._onError(e));
  }

  _onIceCandidate(event) {
    if (!event.candidate) {
      return;
    }
    this._sendSignal({ ice: event.candidate });
  }

  onServerMessage(message) {
    if (!this._conn) {
      this._connect(message.sender, false);
    }

    if (message.sdp) {
      this._conn
        .setRemoteDescription(new RTCSessionDescription(message.sdp))
        .then((_) => {
          if (message.sdp.type === "offer") {
            this._conn.createAnswer().then((d) => this._onDescription(d));
          }
        })
        .catch((e) => this._onError(e));
    } else if (message.ice) {
      this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
    }
  }

  _onChannelOpened(event) {
    console.log("RTC: Channel opened with", this._peerId);
    const channel = event.channel || event.target;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (e) => this._onMessage(e.data);
    channel.onclose = (e) => this._onChannelClosed(e);
    this._channel = channel;
  }

  _onChannelClosed() {
    console.log("RTC: Channel closed with", this._peerId);
    if (!this.isCaller) {
      return;
    }
    this._connect(this._peerId, true); // Reopen the channel
  }

  _onConnectionStateChange(e) {
    console.log("RTC: Connection state changed to", this._conn.connectionState);
    switch (this._conn.connectionState) {
      case "disconnected":
        this._onChannelClosed();
        break;
      case "failed":
        this._conn = null;
        this._onChannelClosed();
        break;
    }
  }

  _onIceConnectionStateChange(e) {
    switch (this._conn.iceConnectionState) {
      case "failed":
        console.error("RTC: ICE Gathering failed");
        break;
      default:
        console.log(
          "RTC: ICE Connection state changed to",
          this._conn.iceConnectionState
        );
    }
  }

  _onError(error) {
    console.error(error);
  }

  _send(message) {
    if (!this._channel) {
      return this.refresh();
    }
    this._channel.send(message);
  }

  _sendSignal(signal) {
    signal.type = "signal";
    signal.to = this._peerId;
    this._server.send(signal);
  }

  refresh() {
    // check if channel is open. otherwise create one
    if (this._isConnected() || this._isConnecting()) {
      return;
    }
    this._connect(this._peerId, this._isCaller);
  }

  _isConnected() {
    return this._channel && this._channel.readyState === "open";
  }

  _isConnecting() {
    return this._channel && this._channel.readyState === "connecting";
  }
}

class PeerManager {
  constructor(serverConnection) {
    this.peers = {};
    this._server = serverConnection;
    Events.on("signal", (e) => this._onMessage(e.detail));
    Events.on("peers", (e) => this._onPeers(e.detail));
    Events.on("files-selected", (e) => this._onFilesSelected(e.detail));
    Events.on("send-file", (e) => this._onSendText(e.detail));
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
  }

  _onMessage(message) {
    if (!this.peers[message.sender]) {
      this.peers[message.sender] = new RTCPeer(this._server);
    }
    this.peers[message.sender].onServerMessage(message);
  }

  _onPeers(peers) {
    peers.forEach((peer) => {
      if (this.peers[peer.id]) {
        this.peers[peer.id].refresh();
        return;
      }
      if (window.isRtcSupported && peer.rtcSupported) {
        this.peers[peer.id] = new RTCPeer(this._server, peer.id);
      } else {
        this.peers[peer.id] = new WSPeer(this._server, peer.id);
      }
    });
  }

  sendTo(peerId, message) {
    this.peers[peerId].send(message);
  }

  _onFilesSelected(message) {
    this.peers[message.to].sendFile(message.files);
  }

  _onSendText(message) {
    this.peers[message.to].sendText(message.text);
  }

  _onPeerLeft(peerId) {
    const peer = this.peers[peerId];
    delete this.peers[peerId];
    if (!peer || !peer._peer) {
      return;
    }
    peer._peer.close();
  }
}

class WSPeer {
  _send(message) {
    message.to = this._peerId;
    this._server.send(message);
  }
}

class FileChunker {
  constructor(file, onChunk, onPartitionEnd) {
    this._chunkSize = 20000; // 20KB
    this._maxPartitionSize = 1000000; // 1MB
    this._offset = 0;
    this.partitionSize = 0;
    this._file = file;
    this._onChunk = onChunk;
    this._onPartitionEnd = onPartitionEnd;
    this._reader = new FileReader();
    this._reader.addEventListener("load", (e) =>
      this._onChunkRead(e.target.result)
    );
  }

  nextPartition() {
    this._partitionSize = 0;
    this._readChunk();
  }

  _readChunk() {
    const chunk = this._file.slice(
      this._offset,
      this._offset + this._chunkSize
    );
    this._reader.readAsArrayBuffer(chunk);
  }

  _onChunkRead(chunk) {
    this._offser += chunk.byteLength;
    this._partitionSize += chunk.byteLength;
    this._onChunk(chunk);
    if (this.isFileEnd()) {
      return;
    }
    if (this._isPartitionEnd()) {
      this._onPartitionEnd(this._offset);
      return;
    }
    this._readChunk();
  }

  repeatPartition() {
    this._offset -= this._partitionSize;
    this.nextPartition();
  }

  _isPartitionEnd() {
    return this._partitionSize >= this._maxPartitionSize;
  }

  isFileEnd() {
    return this._offset >= this._file.size;
  }

  get progress() {
    return this._offset / this._file.size;
  }
}

class FileDigester {
  constructor(meta, callback) {
    this._buffer = [];
    this._bytesReceived = 0;
    this._size = meta.size;
    this._name = meta.name;
    this.mime = meta.mime || "application/octet-stream";
    this._callback = callback;
  }

  unchunk(chunk) {
    this._buffer.push(chunk);
    this._bytesReceived += chunk.byteLength || chunk.size;
    const totalChunks = this._buffer.length;
    this._progress = this._bytesReceived / this._size;
    if (isNaN(this._progress)) {
      this._progress = 1;
    }
    if (this._bytesReceived < this._size) {
      return;
    }

    let blob = new Blob(this._buffer, { type: this.mime });
    this._callback({
      name: this._name,
      mime: this._mime,
      size: this._size,
      blob: blob,
    });
  }
}

class Events {
  static fire(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail: detail }));
  }

  static on(type, callback) {
    return window.addEventListener(type, callback, false);
  }

  static off(type, callback) {
    return window.removeEventListener(type, callback, false);
  }
}
RTCPeer.config = {
  sdpSemantics: "unified-plan",
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};
