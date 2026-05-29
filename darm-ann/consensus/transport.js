'use strict';

const net = require('net');

/**
 * Consensus transports. Two real implementations behind one interface:
 *
 *   connect(nodeId, onMessage)   register a node's inbound handler
 *   send(from, to, msg)          unicast
 *   broadcast(from, msg)         to all other registered nodes
 *
 * • InProcessBus — a real message bus with a FIFO queue and JSON
 *   serialisation (mimicking the wire), drained by pump(). Lets a full BFT
 *   round run deterministically in one process for tests/single-host clusters.
 *
 * • TcpTransport — genuine TCP networking (Node `net`), newline-delimited JSON,
 *   for multi-process / multi-host clusters. No simulation: real sockets.
 */

class InProcessBus {
  constructor() {
    this.handlers = new Map();
    this.queue = [];
  }

  connect(nodeId, onMessage) {
    this.handlers.set(nodeId, onMessage);
  }

  _enqueue(to, msg) {
    // Serialise/clone to mimic a wire boundary (no shared references).
    this.queue.push({ to, msg: JSON.parse(JSON.stringify(msg)) });
  }

  send(_from, to, msg) {
    this._enqueue(to, msg);
  }

  broadcast(from, msg) {
    for (const id of this.handlers.keys()) if (id !== from) this._enqueue(id, msg);
  }

  /** Drain the queue, delivering messages until the round goes quiet. */
  pump(maxSteps = 100000) {
    let steps = 0;
    while (this.queue.length && steps < maxSteps) {
      const { to, msg } = this.queue.shift();
      const h = this.handlers.get(to);
      if (h) h(msg);
      steps += 1;
    }
    return steps;
  }
}

class TcpTransport {
  constructor({ nodeId, host = '127.0.0.1', port }) {
    this.nodeId = nodeId;
    this.host = host;
    this.port = port;
    this.onMessage = null;
    this.peers = new Map(); // nodeId -> { host, port, socket }
    this.server = null;
    this._buffers = new Map();
  }

  connect(nodeId, onMessage) {
    this.nodeId = nodeId;
    this.onMessage = onMessage;
  }

  addPeer(nodeId, host, port) {
    this.peers.set(nodeId, { host, port, socket: null });
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._attach(socket));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
  }

  _attach(socket) {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() && this.onMessage) {
          try {
            this.onMessage(JSON.parse(line));
          } catch (_e) {
            /* ignore malformed frame */
          }
        }
      }
    });
    socket.on('error', () => {});
  }

  _socketFor(peer) {
    if (peer.socket && !peer.socket.destroyed) return Promise.resolve(peer.socket);
    return new Promise((resolve) => {
      const s = net.connect(peer.port, peer.host, () => resolve(s));
      s.on('error', () => resolve(null));
      peer.socket = s;
    });
  }

  async send(_from, to, msg) {
    const peer = this.peers.get(to);
    if (!peer) return;
    const s = await this._socketFor(peer);
    if (s) s.write(JSON.stringify(msg) + '\n');
  }

  async broadcast(_from, msg) {
    await Promise.all([...this.peers.keys()].map((to) => this.send(_from, to, msg)));
  }

  close() {
    for (const peer of this.peers.values()) if (peer.socket) peer.socket.destroy();
    if (this.server) this.server.close();
  }
}

module.exports = { InProcessBus, TcpTransport };
