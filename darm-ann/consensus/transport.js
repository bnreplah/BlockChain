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
  constructor({ faults = null } = {}) {
    this.handlers = new Map();
    this.queue = [];
    // Optional fault-injection model for adversarial testing:
    //   { drop: fn(from,to,msg)->bool, partition: Set<"a|b">, dropped: count }
    this.faults = faults; // set/replace via setFaults()
    this.stats = { sent: 0, dropped: 0, delivered: 0 };
  }

  setFaults(faults) {
    this.faults = faults;
    return this;
  }

  connect(nodeId, onMessage) {
    this.handlers.set(nodeId, onMessage);
  }

  _blocked(from, to, msg) {
    const f = this.faults;
    if (!f) return false;
    if (f.partition) {
      // Symmetric link cut between two nodes.
      if (f.partition.has(`${from}|${to}`) || f.partition.has(`${to}|${from}`)) return true;
    }
    if (typeof f.drop === 'function' && f.drop(from, to, msg)) return true;
    return false;
  }

  _enqueue(from, to, msg) {
    this.stats.sent += 1;
    if (this._blocked(from, to, msg)) {
      this.stats.dropped += 1;
      return;
    }
    // Serialise/clone to mimic a wire boundary (no shared references).
    this.queue.push({ to, msg: JSON.parse(JSON.stringify(msg)) });
  }

  send(from, to, msg) {
    this._enqueue(from, to, msg);
  }

  broadcast(from, msg) {
    for (const id of this.handlers.keys()) if (id !== from) this._enqueue(from, id, msg);
  }

  /** Drain the queue, delivering messages until the round goes quiet. */
  pump(maxSteps = 100000) {
    let steps = 0;
    while (this.queue.length && steps < maxSteps) {
      const { to, msg } = this.queue.shift();
      const h = this.handlers.get(to);
      if (h) {
        this.stats.delivered += 1;
        h(msg);
      }
      steps += 1;
    }
    return steps;
  }
}

class TcpTransport {
  // `tls` enables mutually-authenticated TLS between nodes:
  //   { key, cert, ca }  (PEM buffers/strings). When set, the listener requires
  //   and verifies client certs (mTLS) and dialers present their own cert and
  //   verify the server against the same CA — so only nodes holding a CA-signed
  //   cert can join the consensus transport, and all traffic is encrypted.
  constructor({ nodeId, host = '127.0.0.1', port, tls = null }) {
    this.nodeId = nodeId;
    this.host = host;
    this.port = port;
    this.tls = tls;
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
      if (this.tls) {
        const tls = require('tls');
        const opts = { key: this.tls.key, cert: this.tls.cert, ca: this.tls.ca, requestCert: true, rejectUnauthorized: true };
        this.server = tls.createServer(opts, (socket) => this._attach(socket));
      } else {
        this.server = net.createServer((socket) => this._attach(socket));
      }
      this.server.on('error', reject);
      this.server.on('tlsClientError', () => {}); // reject unauthenticated dialers quietly
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
      let s;
      if (this.tls) {
        const tls = require('tls');
        // servername must satisfy the peer cert; checkServerIdentity is relaxed
        // because nodes are addressed by host:port, not DNS CN (auth is via CA).
        s = tls.connect({ port: peer.port, host: peer.host, key: this.tls.key, cert: this.tls.cert, ca: this.tls.ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }, () => resolve(s));
      } else {
        s = net.connect(peer.port, peer.host, () => resolve(s));
      }
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
